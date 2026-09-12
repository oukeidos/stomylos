import type Database from 'better-sqlite3';
import { ColdMemoryStore, coldHash } from './cold-memory-store';
import { MemoryStore } from './memory-store';
import { flattenMemory } from './memory-flat';
import { decodeVector, encodeVector } from './memory-vectors';
import { embeddingSpaceId } from './memory-embedding';
import { AppFailure } from './errors';
import { selectAssociative, validateAssociative, type AssociativeSelection } from './associative-recall';

export interface AssociativeEmbeddingJob { id: string; spaceId: string; text: string; sourceHash: string; lease: string; attempts: number; }
type Source = { id: string; text: string; text_hash: string; source_order: number };

/** Derived vectors only; source text stays in HOT shared memory or immutable COLD originals. */
export class AssociativeRecallStore {
  private cold: ColdMemoryStore;
  private memory: MemoryStore;
  constructor(private db: Database.Database) { this.cold = new ColdMemoryStore(db); this.memory = new MemoryStore(db); }
  private sources(): Source[] {
    const active = flattenMemory(this.memory.load()).database_records;
    const metadata = this.db.prepare('SELECT id,source_order FROM memory_item_metadata ORDER BY source_order,item_index,id').all() as { id: string; source_order: number }[];
    const hot = new Map<string, string>(active.map(item => [item.id, item.text]));
    const result: Source[] = [];
    for (const row of metadata) {
      const text = hot.get(row.id);
      if (text === undefined) throw new AppFailure('associative_hot_source_missing');
      result.push({ id: row.id, text, text_hash: coldHash(text), source_order: row.source_order });
    }
    for (const item of this.db.prepare('SELECT id,text,text_hash,source_order FROM cold_memories ORDER BY source_order,item_index,id').all() as Source[]) result.push(item);
    return result;
  }
  revision(): number {
    const hot = this.memory.load().revision;
    return Math.max(hot, this.cold.revision());
  }
  reconcile(limit = 32): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new AppFailure('associative_limit');
    if (!this.db.prepare('SELECT 1 FROM embedding_spaces WHERE id=?').get(embeddingSpaceId)) return 0;
    return this.db.transaction(() => {
      let changed = 0;
      for (const source of this.sources()) {
        if (changed >= limit || this.cold.revoked(source.id)) continue;
        const prior = this.db.prepare('SELECT source_hash,state FROM associative_embeddings WHERE memory_id=?').get(source.id) as { source_hash: string; state: string } | undefined;
        if (!prior) {
          this.db.prepare("INSERT INTO associative_embeddings(memory_id,space_id,source_hash,state) VALUES(?,?,?,'pending')").run(source.id, embeddingSpaceId, source.text_hash); changed++;
        } else if (prior.source_hash !== source.text_hash) {
          this.db.prepare("UPDATE associative_embeddings SET source_hash=?,input_hash=NULL,state='pending',vector=NULL,vector_hash=NULL,chunk_count=NULL,attempts=0,lease=NULL,failure=NULL WHERE memory_id=?").run(source.text_hash, source.id); changed++;
        }
      }
      return changed;
    })();
  }
  pending(): number { return this.db.prepare("SELECT COUNT(*) FROM associative_embeddings WHERE space_id=? AND state IN ('pending','running')").pluck().get(embeddingSpaceId) as number; }
  claim(): AssociativeEmbeddingJob | null {
    return this.db.transaction(() => {
      this.reconcile();
      const row = this.db.prepare("SELECT memory_id,source_hash,attempts FROM associative_embeddings WHERE space_id=? AND state='pending' ORDER BY memory_id LIMIT 1").get(embeddingSpaceId) as { memory_id: string; source_hash: string; attempts: number } | undefined;
      if (!row) return null;
      const source = this.sources().find(item => item.id === row.memory_id);
      if (!source || this.cold.revoked(row.memory_id) || source.text_hash !== row.source_hash) {
        this.db.prepare("UPDATE associative_embeddings SET state='failed',failure='associative_source_changed' WHERE memory_id=?").run(row.memory_id); return null;
      }
      const lease = globalThis.crypto.randomUUID();
      this.db.prepare("UPDATE associative_embeddings SET state='running',attempts=attempts+1,lease=?,failure=NULL WHERE memory_id=? AND state='pending'").run(lease, row.memory_id);
      return { id: row.memory_id, spaceId: embeddingSpaceId, text: source.text, sourceHash: source.text_hash, lease, attempts: row.attempts + 1 };
    })();
  }
  complete(job: AssociativeEmbeddingJob, result: { vector: number[]; inputHash: string; chunkCount: number }) {
    return this.db.transaction(() => {
      const source = this.sources().find(item => item.id === job.id);
      if (!source || this.cold.revoked(job.id) || source.text_hash !== job.sourceHash) return false;
      const dimensions = this.db.prepare('SELECT dimensions FROM embedding_spaces WHERE id=?').pluck().get(job.spaceId) as number;
      const blob = encodeVector(result.vector); decodeVector(blob, dimensions);
      if (!/^[a-f0-9]{64}$/.test(result.inputHash) || !Number.isInteger(result.chunkCount) || result.chunkCount < 1) throw new AppFailure('associative_embedding_result');
      return this.db.prepare("UPDATE associative_embeddings SET state='ready',lease=NULL,vector=?,vector_hash=?,input_hash=?,chunk_count=?,failure=NULL WHERE memory_id=? AND space_id=? AND state='running' AND lease=? AND source_hash=?")
        .run(blob, coldHash(blob), result.inputHash, result.chunkCount, job.id, job.spaceId, job.lease, job.sourceHash).changes === 1;
    })();
  }
  fail(job: AssociativeEmbeddingJob, failure: string, retry = false) {
    return this.db.prepare("UPDATE associative_embeddings SET state=?,lease=NULL,failure=? WHERE memory_id=? AND state='running' AND lease=?")
      .run(retry && job.attempts < 2 ? 'pending' : 'failed', failure, job.id, job.lease).changes === 1;
  }
  release(job: AssociativeEmbeddingJob) {
    return this.db.prepare("UPDATE associative_embeddings SET state='pending',lease=NULL,attempts=0,failure=NULL WHERE memory_id=? AND state='running' AND lease=?")
      .run(job.id, job.lease).changes === 1;
  }
  selection(query: { id: string; vector: number[] }[], currentOrder: number, alreadySent: string[]): AssociativeSelection {
    if (!Number.isSafeInteger(currentOrder) || currentOrder < 0) throw new AppFailure('associative_source_order');
    const sent = new Set(alreadySent), source = new Map(this.sources().map(item => [item.id, item]));
    const dimensions = this.db.prepare('SELECT dimensions FROM embedding_spaces WHERE id=?').pluck().get(embeddingSpaceId) as number | undefined;
    if (!dimensions) return { version: 'stomylos_associative_recall_v1', query_ids: query.map(item => item.id).sort(), source_revision: this.revision(), threshold: 0.78, items: [], block: '', reason: 'unavailable' };
    const rows = this.db.prepare("SELECT memory_id,vector,vector_hash FROM associative_embeddings WHERE space_id=? AND state='ready'").all(embeddingSpaceId) as { memory_id: string; vector: Uint8Array; vector_hash: string }[];
    try {
      const candidates = rows.flatMap(row => {
        const item = source.get(row.memory_id);
        if (!item || item.source_order >= currentOrder || sent.has(item.id) || this.cold.revoked(item.id) || coldHash(row.vector) !== row.vector_hash) return [];
        return [{ ...item, vector: Array.from(decodeVector(row.vector, dimensions)) }];
      });
      return selectAssociative(query, candidates, this.revision());
    } catch { return { version: 'stomylos_associative_recall_v1', query_ids: query.map(item => item.id).sort(), source_revision: this.revision(), threshold: 0.78, items: [], block: '', reason: 'integrity' }; }
  }
  selectionFor(queryIds: string[], currentOrder: number, alreadySent: string[]): AssociativeSelection | null {
    const dimensions = this.db.prepare('SELECT dimensions FROM embedding_spaces WHERE id=?').pluck().get(embeddingSpaceId) as number | undefined;
    if (!dimensions || !queryIds.length) return null;
    const query = queryIds.map(id => this.db.prepare("SELECT vector,vector_hash FROM associative_embeddings WHERE memory_id=? AND space_id=? AND state='ready'").get(id, embeddingSpaceId) as { vector: Uint8Array; vector_hash: string } | undefined);
    if (query.some(row => !row)) return null;
    try {
      return this.selection(queryIds.map((id, index) => {
        const row = query[index]!;
        if (coldHash(row.vector) !== row.vector_hash) throw new AppFailure('associative_vector_hash');
        return { id, vector: Array.from(decodeVector(row.vector, dimensions)) };
      }), currentOrder, alreadySent);
    } catch { return null; }
  }
  assertNotRevoked(selection: AssociativeSelection) {
    validateAssociative(selection);
    if (selection.items.some(item => this.cold.revoked(item.id))) throw new AppFailure('memory_retry_revoked');
  }
}
