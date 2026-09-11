import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ColdMemoryStore, coldHash } from './cold-memory-store';
import { AppFailure } from './errors';
import { clusterPolicy, decodeVector, dot, encodeVector, normalized, validateClusterPolicy, type ClusterPolicy } from './memory-vectors';
import type { ColdMemory } from '../shared/cold-memory';

interface Generation {
  id: string; space_id: string; dimensions: number; policy: string;
  state: 'building' | 'active' | 'retired' | 'failed'; next_assignment: number;
}
interface Cluster {
  id: string; generation_id: string; sum_vector: Buffer; centroid: Buffer; anchor_id: string;
  item_count: number; session_count: number; cohesion: number; revision: number;
  state: 'ready' | 'repairing'; anchor_cursor: string | null; anchor_candidate: string | null; anchor_similarity: number | null;
}
export interface EmbeddingJob { id: string; spaceId: string; text: string; sourceHash: string; lease: string; attempts: number }
interface Embedding { memory_id: string; space_id: string; state: string; source_hash: string; vector: Buffer; vector_hash: string; failure: string | null }

/** Incremental derived state. All methods run on the existing serialized DB worker. */
export class MemoryClusters {
  private originals: ColdMemoryStore;
  private representatives = new Map<string, { revision: number; centroid: Float64Array; anchor: Float64Array }>();
  constructor(private db: Database.Database) { this.originals = new ColdMemoryStore(db); }
  private rows<T>(sql: string, ...args: unknown[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  private generation(id: string): Generation {
    const row = this.db.prepare(`SELECT g.*,s.dimensions FROM cluster_generations g JOIN embedding_spaces s ON s.id=g.space_id WHERE g.id=?`).get(id) as Generation | undefined;
    if (!row) throw new AppFailure('cold_generation_missing');
    return row;
  }
  register(manifest: string, dimensions: number): string {
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) throw new AppFailure('cold_vector_dimension');
    JSON.parse(manifest);
    const id = coldHash(manifest);
    this.db.prepare('INSERT OR IGNORE INTO embedding_spaces VALUES(?,?,?,?)').run(id, manifest, dimensions, new Date().toISOString());
    const stored = this.db.prepare('SELECT manifest,dimensions FROM embedding_spaces WHERE id=?').get(id) as { manifest: string; dimensions: number };
    if (stored.manifest !== manifest || stored.dimensions !== dimensions) throw new AppFailure('cold_space_conflict');
    return id;
  }
  begin(spaceId: string, policy = clusterPolicy, rebuild = false): string {
    validateClusterPolicy(policy);
    const encoded = JSON.stringify(policy);
    const existing = this.db.prepare("SELECT id FROM cluster_generations WHERE space_id=? AND policy=? AND state IN ('active','building') ORDER BY state LIMIT 1").pluck().get(spaceId, encoded) as string | undefined;
    if (existing && !rebuild) return existing;
    // One replacement at a time; repeated repair clicks resume the same work.
    const building = this.db.prepare("SELECT id FROM cluster_generations WHERE space_id=? AND policy=? AND state='building'").pluck().get(spaceId, encoded) as string | undefined;
    if (building) return building;
    const id = randomUUID();
    this.db.prepare("UPDATE cluster_generations SET state='failed',failure='cold_build_superseded' WHERE state='building'").run();
    this.db.prepare("INSERT INTO cluster_generations(id,space_id,policy,state,created_at) VALUES(?,?,?,'building',?)").run(id, spaceId, encoded, new Date().toISOString());
    this.prune();
    return id;
  }
  recover() {
    this.db.prepare("UPDATE cold_embeddings SET state='pending',lease=NULL WHERE state='running'").run();
    this.representatives.clear();
  }
  /** Missing rows and completed vectors are separate queues; neither requires full re-embedding. */
  reconcile(limit = 32): number {
    return this.db.transaction(() => {
      let completed = 0;
      const spaces = this.rows<{ space_id: string }>("SELECT DISTINCT space_id FROM cluster_generations WHERE state IN ('active','building')");
      for (const { space_id } of spaces) {
        const missing = this.rows<ColdMemory>(`SELECT c.* FROM cold_memories c LEFT JOIN cold_embeddings e ON e.memory_id=c.id AND e.space_id=?
          WHERE e.memory_id IS NULL ORDER BY c.source_order,c.item_index,c.id LIMIT ?`, space_id, limit);
        for (const item of missing) {
          const valid = coldHash(item.text) === item.text_hash;
          this.db.prepare('INSERT INTO cold_embeddings(memory_id,space_id,source_hash,state,failure) VALUES(?,?,?,?,?)')
            .run(item.id, space_id, item.text_hash, valid ? 'pending' : 'failed', valid ? null : 'cold_original_hash');
        }
      }
      for (const { id } of this.rows<{ id: string }>("SELECT id FROM cluster_generations WHERE state IN ('active','building') ORDER BY created_at,id")) {
        const g = this.generation(id);
        const ready = this.rows<Embedding>(`SELECT e.* FROM cold_embeddings e JOIN cold_memories c ON c.id=e.memory_id
          LEFT JOIN cold_memberships m ON m.memory_id=e.memory_id AND m.generation_id=?
          WHERE e.space_id=? AND e.state IN ('ready','failed') AND (m.memory_id IS NULL OR (m.state='excluded' AND e.state='ready'))
          ORDER BY c.source_order,c.item_index,c.id LIMIT ?`, id, g.space_id, limit);
        for (const e of ready) {
          if (e.state === 'failed') {
            this.exclude(g, e.memory_id, e.failure ?? 'cold_embedding_failed');
          } else {
            // A savepoint protects group statistics if a corrupt vector interrupts assignment.
            try { this.db.transaction(() => this.assign(g, e))(); }
            catch (error) {
              this.db.prepare("UPDATE cluster_generations SET state='failed',failure=? WHERE id=?").run(error instanceof AppFailure ? error.code : 'cold_group_invalid', id);
              this.representatives.clear(); break;
            }
          }
          completed++;
        }
        completed += this.repairAnchors(id, limit);
        this.refreshWatermark(id);
      }
      return completed;
    })();
  }
  private exclude(g: Generation, id: string, failure: string) {
    const item = this.db.prepare('SELECT archive_revision FROM cold_memories WHERE id=?').get(id) as { archive_revision: number };
    this.db.prepare(`INSERT OR IGNORE INTO cold_memberships(generation_id,space_id,memory_id,state,failure,source_revision)
      VALUES(?,?,?,'excluded',?,?)`).run(g.id, g.space_id, id, failure, item.archive_revision);
  }
  private vector(e: Pick<Embedding, 'vector' | 'vector_hash'>, dimensions: number) {
    if (!e.vector || coldHash(e.vector) !== e.vector_hash) throw new AppFailure('cold_vector_hash');
    return decodeVector(e.vector, dimensions);
  }
  private assign(g: Generation, e: Embedding) {
    const item = this.originals.original(e.memory_id);
    if (!item || this.originals.revoked(item.id) || item.text_hash !== e.source_hash) throw new AppFailure('cold_source_changed');
    const vector = this.vector(e, g.dimensions), policy = JSON.parse(g.policy) as ClusterPolicy;
    validateClusterPolicy(policy);
    let chosenId: string | null = null, best = -Infinity;
    for (const cluster of this.rows<Pick<Cluster, 'id' | 'revision'>>("SELECT id,revision FROM cold_clusters WHERE generation_id=? AND state='ready' ORDER BY id", g.id)) {
      const key = g.id + ':' + cluster.id;
      let cached = this.representatives.get(key);
      if (!cached || cached.revision !== cluster.revision) {
        const detail = this.db.prepare('SELECT centroid,anchor_id FROM cold_clusters WHERE generation_id=? AND id=?').get(g.id, cluster.id) as Pick<Cluster, 'centroid' | 'anchor_id'>;
        const anchor = this.db.prepare("SELECT vector,vector_hash FROM cold_embeddings WHERE space_id=? AND memory_id=? AND state='ready'").get(g.space_id, detail.anchor_id) as Embedding | undefined;
        if (!anchor) throw new AppFailure('cold_anchor_missing');
        cached = { revision: cluster.revision, centroid: decodeVector(detail.centroid, g.dimensions), anchor: this.vector(anchor, g.dimensions) };
        this.representatives.set(key, cached);
      }
      const similarity = dot(vector, cached.centroid);
      if (similarity >= policy.centroid && dot(vector, cached.anchor) >= policy.anchor && similarity > best) {
        chosenId = cluster.id; best = similarity;
      }
    }
    const chosen = chosenId === null ? null : this.db.prepare('SELECT * FROM cold_clusters WHERE generation_id=? AND id=?').get(g.id, chosenId) as Cluster;
    const clusterId = chosen?.id ?? item.id;
    const sum = chosen ? decodeVector(chosen.sum_vector, g.dimensions, true) : new Float64Array(g.dimensions);
    for (let i = 0; i < sum.length; i++) sum[i] += vector[i];
    const count = (chosen?.item_count ?? 0) + 1, centroid = encodeVector(normalized(sum));
    if (!chosen) {
      this.db.prepare('INSERT INTO cold_clusters(id,generation_id,sum_vector,centroid,anchor_id,item_count,session_count,cohesion,revision) VALUES(?,?,?,?,?,?,?,?,?)').run(clusterId, g.id, encodeVector(sum, true), centroid, item.id, count, 0, Math.sqrt(dot(sum, sum)) / count, 1);
    } else {
      this.db.prepare('UPDATE cold_clusters SET sum_vector=?,centroid=?,item_count=?,cohesion=?,revision=revision+1 WHERE id=? AND generation_id=?')
        .run(encodeVector(sum, true), centroid, count, Math.sqrt(dot(sum, sum)) / count, clusterId, g.id);
    }
    this.db.prepare("DELETE FROM cold_memberships WHERE generation_id=? AND memory_id=? AND state='excluded'").run(g.id, item.id);
    const sequence = this.db.prepare('UPDATE cluster_generations SET next_assignment=next_assignment+1 WHERE id=? RETURNING next_assignment').pluck().get(g.id) as number;
    this.db.prepare(`INSERT INTO cold_memberships(generation_id,space_id,memory_id,state,cluster_id,assignment_seq,source_revision)
      VALUES(?,?,?,'assigned',?,?,?)`).run(g.id, g.space_id, item.id, clusterId, sequence, item.archive_revision);
    if (item.source_session_id !== null) {
      this.db.prepare(`INSERT INTO cold_cluster_sessions VALUES(?,?,?,1) ON CONFLICT(generation_id,cluster_id,source_session_id)
        DO UPDATE SET item_count=item_count+1`).run(g.id, clusterId, item.source_session_id);
      this.db.prepare('UPDATE cold_clusters SET session_count=(SELECT COUNT(*) FROM cold_cluster_sessions WHERE generation_id=? AND cluster_id=?) WHERE generation_id=? AND id=?')
        .run(g.id, clusterId, g.id, clusterId);
    }
  }
  claim(spaceId: string): EmbeddingJob | null {
    return this.db.transaction(() => {
      const on = this.db.prepare('SELECT enabled FROM memory_preferences WHERE id=1').pluck().get();
      if (!on) return null;
      const item = this.db.prepare(`SELECT c.*,e.attempts FROM cold_embeddings e JOIN cold_memories c ON c.id=e.memory_id
        WHERE e.space_id=? AND e.state='pending' AND EXISTS(SELECT 1 FROM cluster_generations g WHERE g.space_id=e.space_id AND g.state IN ('active','building'))
        ORDER BY c.source_order,c.item_index,c.id LIMIT 1`).get(spaceId) as (ColdMemory & { attempts: number }) | undefined;
      if (!item) return null;
      if (coldHash(item.text) !== item.text_hash || this.originals.revoked(item.id)) {
        this.db.prepare("UPDATE cold_embeddings SET state='failed',failure='cold_original_hash' WHERE memory_id=? AND space_id=?").run(item.id, spaceId);
        return null;
      }
      const lease = randomUUID();
      this.db.prepare("UPDATE cold_embeddings SET state='running',attempts=attempts+1,lease=?,failure=NULL WHERE memory_id=? AND space_id=?").run(lease, item.id, spaceId);
      return { id: item.id, spaceId, text: item.text, sourceHash: item.text_hash, lease, attempts: item.attempts + 1 };
    })();
  }
  complete(job: EmbeddingJob, result: { vector: number[]; inputHash: string; chunkCount: number }): boolean {
    return this.db.transaction(() => {
      const current = this.db.prepare("SELECT 1 FROM cold_embeddings WHERE memory_id=? AND space_id=? AND state='running' AND lease=? AND source_hash=? AND EXISTS(SELECT 1 FROM cluster_generations g WHERE g.space_id=cold_embeddings.space_id AND g.state IN ('active','building'))")
        .get(job.id, job.spaceId, job.lease, job.sourceHash);
      if (!current || this.originals.revoked(job.id)) return false;
      const dims = this.db.prepare('SELECT dimensions FROM embedding_spaces WHERE id=?').pluck().get(job.spaceId) as number;
      const blob = encodeVector(result.vector); decodeVector(blob, dims);
      if (!/^[a-f0-9]{64}$/.test(result.inputHash) || !Number.isInteger(result.chunkCount) || result.chunkCount < 1) throw new AppFailure('cold_embedding_result');
      if (this.originals.original(job.id)?.text_hash !== job.sourceHash) throw new AppFailure('cold_source_changed');
      this.db.prepare("UPDATE cold_embeddings SET state='ready',lease=NULL,vector=?,vector_hash=?,input_hash=?,chunk_count=?,failure=NULL WHERE memory_id=? AND space_id=?")
        .run(blob, coldHash(blob), result.inputHash, result.chunkCount, job.id, job.spaceId);
      return true;
    })();
  }
  fail(job: EmbeddingJob, failure: string, retry = false) {
    return this.db.prepare("UPDATE cold_embeddings SET state=?,lease=NULL,failure=? WHERE memory_id=? AND space_id=? AND state='running' AND lease=?")
      .run(retry && job.attempts < 2 ? 'pending' : 'failed', failure, job.id, job.spaceId, job.lease).changes > 0;
  }
  release(job: EmbeddingJob) {
    return this.db.prepare("UPDATE cold_embeddings SET state='pending',lease=NULL,attempts=0,failure=NULL WHERE memory_id=? AND space_id=? AND state='running' AND lease=?")
      .run(job.id, job.spaceId, job.lease).changes > 0;
  }
  deleteOriginal(id: string, expectedHash: string, expectedRevision: number) {
    return this.db.transaction(() => {
      const item = this.originals.original(id);
      if (!item && this.originals.revoked(id)) return;
      if (!item || item.text_hash !== expectedHash || this.originals.revision() !== expectedRevision) throw new AppFailure('cold_delete_conflict');
      this.originals.revoke(id);
      for (const member of this.rows<{ generation_id: string; cluster_id: string }>("SELECT generation_id,cluster_id FROM cold_memberships WHERE memory_id=? AND state='assigned'", id)) {
        const g = this.generation(member.generation_id);
        try { this.db.transaction(() => this.removeMember(g, member.cluster_id, item))(); }
        catch {
          // Forgetting must remain possible even if this derived generation is corrupt.
          this.db.prepare("UPDATE cluster_generations SET state='failed',failure='cold_delete_rebuild' WHERE id=?").run(g.id);
          this.db.prepare('DELETE FROM cold_memberships WHERE generation_id=?').run(g.id);
          this.db.prepare('DELETE FROM cold_clusters WHERE generation_id=?').run(g.id);
        }
      }
      this.db.prepare('DELETE FROM cold_memories WHERE id=?').run(id);
      for (const row of this.rows<{ id: string }>("SELECT id FROM cluster_generations WHERE state IN ('building','active')")) this.refreshWatermark(row.id);
      this.representatives.clear();
    })();
  }
  private removeMember(g: Generation, clusterId: string, item: ColdMemory) {
    const cluster = this.db.prepare('SELECT * FROM cold_clusters WHERE id=? AND generation_id=?').get(clusterId, g.id) as Cluster;
    const e = this.db.prepare('SELECT * FROM cold_embeddings WHERE memory_id=? AND space_id=?').get(item.id, g.space_id) as Embedding;
    const vector = this.vector(e, g.dimensions), sum = decodeVector(cluster.sum_vector, g.dimensions, true);
    this.db.prepare('DELETE FROM cold_memberships WHERE memory_id=? AND generation_id=?').run(item.id, g.id);
    if (cluster.item_count === 1) {
      this.db.prepare('DELETE FROM cold_clusters WHERE id=? AND generation_id=?').run(clusterId, g.id); return;
    }
    vector.forEach((value, i) => { sum[i] -= value; });
    if (item.source_session_id !== null) {
      this.db.prepare('DELETE FROM cold_cluster_sessions WHERE generation_id=? AND cluster_id=? AND source_session_id=? AND item_count=1')
        .run(g.id, clusterId, item.source_session_id);
      this.db.prepare('UPDATE cold_cluster_sessions SET item_count=item_count-1 WHERE generation_id=? AND cluster_id=? AND source_session_id=?')
        .run(g.id, clusterId, item.source_session_id);
    }
    const count = cluster.item_count - 1, state = cluster.anchor_id === item.id || cluster.state === 'repairing' ? 'repairing' : 'ready';
    this.db.prepare(`UPDATE cold_clusters SET sum_vector=?,centroid=?,item_count=?,cohesion=?,revision=revision+1,state=?,
      anchor_cursor=NULL,anchor_candidate=NULL,anchor_similarity=NULL,
      session_count=(SELECT COUNT(*) FROM cold_cluster_sessions WHERE generation_id=? AND cluster_id=?) WHERE generation_id=? AND id=?`)
      .run(encodeVector(sum, true), encodeVector(normalized(sum)), count, Math.sqrt(dot(sum, sum)) / count, state, g.id, clusterId, g.id, clusterId);
  }
  private repairAnchors(id: string, limit: number) {
    const g = this.generation(id);
    let repaired = 0;
    for (const c of this.rows<Cluster>("SELECT * FROM cold_clusters WHERE generation_id=? AND state='repairing' ORDER BY id LIMIT 1", id)) {
      try {
        repaired++;
        const items = this.rows<Embedding>(`SELECT e.* FROM cold_memberships m JOIN cold_embeddings e ON e.memory_id=m.memory_id AND e.space_id=m.space_id
          WHERE m.generation_id=? AND m.cluster_id=? AND m.memory_id>? AND m.state='assigned' ORDER BY m.memory_id LIMIT ?`, id, c.id, c.anchor_cursor ?? '', limit);
        const centroid = decodeVector(c.centroid, g.dimensions);
        let best = c.anchor_similarity ?? -Infinity, candidate = c.anchor_candidate;
        for (const e of items) { const similarity = dot(centroid, this.vector(e, g.dimensions)); if (similarity > best) { best = similarity; candidate = e.memory_id; } }
        if (items.length < limit) {
          if (!candidate) throw new AppFailure('cold_anchor_missing');
          this.db.prepare("UPDATE cold_clusters SET anchor_id=?,state='ready',revision=revision+1,anchor_cursor=NULL,anchor_candidate=NULL,anchor_similarity=NULL WHERE id=? AND generation_id=?")
            .run(candidate, c.id, id);
        } else this.db.prepare('UPDATE cold_clusters SET anchor_cursor=?,anchor_candidate=?,anchor_similarity=? WHERE id=? AND generation_id=?')
          .run(items.at(-1)!.memory_id, candidate, best, c.id, id);
      } catch {
        this.db.prepare("UPDATE cluster_generations SET state='failed',failure='cold_anchor_repair' WHERE id=?").run(id);
      }
    }
    return repaired;
  }
  retryFailed(spaceId: string) {
    this.db.transaction(() => {
      // Explicit repair validates stored vectors, including corrupt anchors that
      // cannot be repaired by merely constructing another generation.
      const dimensions = this.db.prepare('SELECT dimensions FROM embedding_spaces WHERE id=?').pluck().get(spaceId) as number;
      for (const e of this.rows<Embedding>("SELECT * FROM cold_embeddings WHERE space_id=? AND state='ready'", spaceId)) {
        try { this.vector(e, dimensions); }
        catch {
          this.db.prepare("UPDATE cluster_generations SET state='failed',failure='cold_vector_rebuild' WHERE id IN (SELECT generation_id FROM cold_memberships WHERE memory_id=? AND space_id=?)").run(e.memory_id, spaceId);
          this.db.prepare("UPDATE cold_embeddings SET state='failed',vector=NULL,vector_hash=NULL,input_hash=NULL,chunk_count=NULL,failure='cold_vector_rebuild' WHERE memory_id=? AND space_id=?").run(e.memory_id, spaceId);
        }
      }
      const failed = this.rows<{ memory_id: string }>("SELECT memory_id FROM cold_embeddings WHERE space_id=? AND state='failed' AND failure!='cold_original_hash'", spaceId);
      for (const row of failed) {
        this.db.prepare("INSERT INTO cold_mutations(memory_id,kind) VALUES(?,'repair')").run(row.memory_id);
        this.db.prepare("DELETE FROM cold_memberships WHERE memory_id=? AND space_id=? AND state='excluded'").run(row.memory_id, spaceId);
      }
      this.db.prepare("UPDATE cold_embeddings SET state='pending',attempts=0,failure=NULL WHERE space_id=? AND state='failed' AND failure!='cold_original_hash'").run(spaceId);
    })();
  }
  private prune() {
    // Frozen recalls carry their own original text and space identity; keep the
    // small manifests, one previous generation and one failed diagnostic only.
    for (const state of ['retired', 'failed']) {
      const stale = this.rows<{ id: string }>('SELECT id FROM cluster_generations WHERE state=? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 1', state);
      for (const { id } of stale) {
        this.db.prepare('DELETE FROM cold_memberships WHERE generation_id=?').run(id);
        this.db.prepare('DELETE FROM cluster_generations WHERE id=?').run(id);
      }
    }
    this.db.prepare("DELETE FROM cold_embeddings WHERE space_id NOT IN (SELECT space_id FROM cluster_generations)").run();
  }
  private refreshWatermark(id: string) {
    const g = this.generation(id), revision = this.originals.revision();
    const first = this.db.prepare(`SELECT MIN(c.archive_revision) FROM cold_memories c LEFT JOIN cold_memberships m
      ON m.memory_id=c.id AND m.generation_id=? WHERE m.memory_id IS NULL`).pluck().get(id) as number | null;
    this.db.prepare('UPDATE cluster_generations SET scan_revision=?,completed_revision=? WHERE id=?')
      .run(revision, first === null ? revision : first - 1, g.id);
  }
  activate(id: string): boolean {
    return this.db.transaction(() => {
      if (this.generation(id).state !== 'building') return false;
      this.refreshWatermark(id);
      const complete = this.db.prepare('SELECT completed_revision FROM cluster_generations WHERE id=?').pluck().get(id);
      if (complete !== this.originals.revision() || this.db.prepare("SELECT 1 FROM cold_clusters WHERE generation_id=? AND state='repairing' LIMIT 1").get(id)) return false;
      this.verify(id);
      this.db.prepare("UPDATE cluster_generations SET state='retired' WHERE state='active'").run();
      this.db.prepare("UPDATE cluster_generations SET state='active' WHERE id=?").run(id);
      this.prune();
      this.representatives.clear();
      return true;
    })();
  }
  verify(id: string) {
    const g = this.generation(id);
    for (const cluster of this.rows<Cluster>('SELECT * FROM cold_clusters WHERE generation_id=?', id)) {
      const members = this.rows<Embedding & { source_session_id: string | null }>(`SELECT e.*,c.source_session_id FROM cold_memberships m
        JOIN cold_embeddings e ON e.memory_id=m.memory_id AND e.space_id=m.space_id JOIN cold_memories c ON c.id=m.memory_id
        WHERE m.generation_id=? AND m.cluster_id=? AND m.state='assigned'`, id, cluster.id);
      if (members.length !== cluster.item_count || !members.some(e => e.memory_id === cluster.anchor_id)) throw new AppFailure('cold_cluster_count');
      const sessions = new Map<string, number>(), sum = new Float64Array(g.dimensions);
      for (const e of members) {
        const v = this.vector(e, g.dimensions);
        if (e.state !== 'ready' || this.originals.original(e.memory_id)?.text_hash !== e.source_hash) throw new AppFailure('cold_source_changed');
        v.forEach((value, i) => { sum[i] += value; });
        if (e.source_session_id !== null) sessions.set(e.source_session_id, (sessions.get(e.source_session_id) ?? 0) + 1);
      }
      const stored = decodeVector(cluster.sum_vector, g.dimensions, true);
      if (sum.some((value, i) => Math.abs(value - stored[i]) > 1e-7 * Math.max(1, members.length))) throw new AppFailure('cold_cluster_sum');
      if (dot(normalized(sum), decodeVector(cluster.centroid, g.dimensions)) < 1 - 1e-5 || Math.abs(cluster.cohesion - Math.sqrt(dot(sum, sum)) / members.length) > 1e-6) throw new AppFailure('cold_cluster_centroid');
      const rows = this.rows<{ source_session_id: string; item_count: number }>('SELECT source_session_id,item_count FROM cold_cluster_sessions WHERE generation_id=? AND cluster_id=?', id, cluster.id);
      if (cluster.session_count !== sessions.size || rows.length !== sessions.size || rows.some(r => sessions.get(r.source_session_id) !== r.item_count)) throw new AppFailure('cold_cluster_sessions');
    }
  }
}
