import type Database from 'better-sqlite3';
import type { FlatMemoryDocument } from '../shared/memory';
import type { ColdMemory } from '../shared/cold-memory';
import { ColdMemoryStore, coldHash } from './cold-memory-store';
import { AppFailure } from './errors';
import { coldRecallPolicy, recallPrng, codePoints, observationTime, recallSeed, renderCold, renderColdItem,
  sampleRecollections, seededRecall, validateRecall, type RecallCandidate, type RecallItem, type RecallSelection } from './memory-recall';

export class MemoryRecallStore {
  private originals: ColdMemoryStore;
  constructor(private db: Database.Database) { this.originals = new ColdMemoryStore(db); }
  cacheMetadata(limit = 32): number {
    return this.db.transaction(() => {
      const items = this.db.prepare(`SELECT c.* FROM cold_memories c LEFT JOIN cold_render_metadata r
        ON r.memory_id=c.id AND r.policy_version=? WHERE r.memory_id IS NULL AND NOT EXISTS (SELECT 1 FROM cold_embeddings e WHERE e.memory_id=c.id AND e.failure='cold_original_hash') ORDER BY c.archive_revision LIMIT ?`).all(coldRecallPolicy, limit) as ColdMemory[];
      let cached = 0;
      for (const item of items) {
        if (coldHash(item.text) !== item.text_hash) continue;
        cached++;
        this.db.prepare('INSERT OR IGNORE INTO cold_render_metadata VALUES(?,?,?,?)').run(item.id, coldRecallPolicy, item.text_hash, codePoints(renderColdItem(item)));
      }
      return cached;
    })();
  }
  private save(session: string, selection: RecallSelection) {
    validateRecall(selection);
    const json = JSON.stringify(selection);
    this.db.prepare('INSERT INTO session_cold_recollections VALUES(?,?,?,?,?)').run(session, selection.revision, json, coldHash(json), new Date().toISOString());
    return selection;
  }
  snapshot(session: string, hot: FlatMemoryDocument): RecallSelection {
    const saved = this.db.prepare('SELECT * FROM session_cold_recollections WHERE session_id=? ORDER BY revision DESC LIMIT 1').get(session) as { selection: string; selection_hash: string } | undefined;
    if (saved) {
      if (coldHash(saved.selection) !== saved.selection_hash) throw new AppFailure('cold_snapshot_changed');
      const selection = JSON.parse(saved.selection) as RecallSelection; validateRecall(selection);
      const items = selection.items.filter(item => !this.originals.revoked(item.id));
      if (items.length === selection.items.length) return selection;
      return this.save(session, { ...selection, items, block: renderCold(items), revision: this.originals.revision(), reason: 'revoked' });
    }
    const selection: RecallSelection = { policy: coldRecallPolicy, prng: recallPrng, seed: recallSeed(), generation: null,
      space: null, revision: this.originals.revision(), items: [], block: '', reason: 'unavailable' };
    const generation = this.db.prepare("SELECT id,space_id FROM cluster_generations WHERE state='active'").get() as { id: string; space_id: string } | undefined;
    if (!generation) return this.save(session, selection);
    selection.generation = generation.id; selection.space = generation.space_id;
    const rows = this.db.prepare(`SELECT c.id,c.text_hash,c.observed_at,c.edited_at,c.time_basis,k.id group_id,k.session_count,r.rendered_length
      FROM cold_memberships m JOIN cold_memories c ON c.id=m.memory_id
      JOIN cold_clusters k ON k.id=m.cluster_id AND k.generation_id=m.generation_id
      JOIN cold_render_metadata r ON r.memory_id=c.id AND r.policy_version=? AND r.text_hash=c.text_hash
      WHERE m.generation_id=? AND m.state='assigned' AND k.state='ready' AND NOT EXISTS
      (SELECT 1 FROM cold_revocations v WHERE v.memory_id=c.id) ORDER BY c.id`).all(coldRecallPolicy, generation.id) as
      (RecallItem & { group_id: string; session_count: number; rendered_length: number })[];
    const candidates: RecallCandidate[] = rows.map(item => ({ id: item.id, group: item.group_id, sessions: item.session_count,
      length: item.rendered_length, textHash: item.text_hash, time: observationTime(item) }));
    try {
      selection.items = sampleRecollections(candidates, hot.database_records.map(i => i.text), id => {
        const item = this.originals.original(id); if (!item) throw new AppFailure('cold_original_missing');
        return { id: item.id, text: item.text, text_hash: item.text_hash, observed_at: item.observed_at, edited_at: item.edited_at, time_basis: item.time_basis };
      }, seededRecall(selection.seed));
      selection.block = renderCold(selection.items); selection.reason = selection.items.length ? 'selected' : 'empty';
    } catch {
      this.db.prepare("UPDATE cluster_generations SET state='failed',failure='cold_recall_integrity' WHERE id=?").run(generation.id);
      selection.items = []; selection.block = ''; selection.reason = 'integrity';
    }
    return this.save(session, selection);
  }
  assertNotRevoked(selection: RecallSelection) {
    validateRecall(selection);
    if (selection.items.some(item => this.originals.revoked(item.id))) throw new AppFailure('memory_retry_revoked');
  }
}
