import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { ColdMemory, ColdPage } from '../shared/cold-memory';
import type { MemoryItem } from '../shared/memory';
import { AppFailure } from './errors';

export const coldHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type Provenance = Pick<ColdMemory, 'source_order' | 'item_index' | 'source_message_id' |
  'source_session_id' | 'observed_at' | 'edited_at' | 'origin'>;
const knownTime = (value: string | null) => value !== null && Number.isFinite(Date.parse(value));

/** Owns original records; inference and clustering never rewrite these rows. */
const searchable = new WeakSet<Database.Database>();
export class ColdMemoryStore {
  constructor(private db: Database.Database) {
    if (!searchable.has(db)) {
      db.function('cold_search_text', { deterministic: true }, (value: string) => value.normalize('NFC').toLowerCase());
      searchable.add(db);
    }
  }

  revision(): number {
    return this.db.prepare('SELECT COALESCE(MAX(revision),0) FROM cold_mutations').pluck().get() as number;
  }

  original(id: string): ColdMemory | null {
    const value = this.db.prepare('SELECT * FROM cold_memories WHERE id=?').get(id) as ColdMemory | undefined;
    if (!value) return null;
    if (coldHash(value.text) !== value.text_hash) throw new AppFailure('cold_original_hash');
    return value;
  }

  /** Called inside ADD's transaction, before any evicted HOT provenance is removed. */
  archive(items: MemoryItem[], archivedAt = new Date().toISOString()) {
    if (!this.db.inTransaction) throw new AppFailure('cold_archive_transaction');
    for (const item of items) {
      if (this.revoked(item.id)) throw new AppFailure('cold_memory_revoked');
      const source = this.db.prepare(`SELECT source_order,item_index,source_message_id,source_session_id,
        observed_at,edited_at,origin FROM memory_item_metadata WHERE id=?`).get(item.id) as Provenance | undefined;
      if (!source) throw new AppFailure('cold_provenance_missing');
      const existing = this.original(item.id);
      if (existing) {
        if (existing.text !== item.text || (Object.keys(source) as (keyof Provenance)[])
          .some(key => source[key] !== existing[key])) {
          throw new AppFailure('cold_original_conflict');
        }
        continue;
      }
      const revision = Number(this.db.prepare("INSERT INTO cold_mutations(memory_id,kind) VALUES(?,'archive')").run(item.id).lastInsertRowid);
      const timeBasis = source.origin === 'manual'
        ? knownTime(source.edited_at) ? 'manual_edit' : 'unknown'
        : knownTime(source.observed_at) ? 'source_message' : 'unknown';
      this.db.prepare(`INSERT INTO cold_memories(id,text,text_hash,source_order,item_index,source_message_id,
        source_session_id,observed_at,edited_at,archived_at,origin,time_basis,archive_revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.id, item.text, coldHash(item.text), source.source_order,
        source.item_index, source.source_message_id, source.source_session_id, source.observed_at,
        source.edited_at, archivedAt, source.origin, timeBasis, revision);
      // A new model space may be registered later; reconciliation also discovers missing rows.
      this.db.prepare(`INSERT INTO cold_embeddings(memory_id,space_id,source_hash,state)
        SELECT ?,s.id,?,'pending' FROM embedding_spaces s WHERE EXISTS
        (SELECT 1 FROM cluster_generations g WHERE g.space_id=s.id AND g.state IN ('active','building'))`)
        .run(item.id, coldHash(item.text));
    }
  }

  revoked(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM cold_revocations WHERE memory_id=?').get(id);
  }

  /** Also used by HOT deletion, so an old frozen snapshot cannot reintroduce that ID. */
  revoke(id: string): number {
    if (!this.db.inTransaction) throw new AppFailure('cold_delete_transaction');
    const old = this.db.prepare('SELECT revision FROM cold_revocations WHERE memory_id=?').pluck().get(id) as number | undefined;
    if (old !== undefined) return old;
    const revision = Number(this.db.prepare("INSERT INTO cold_mutations(memory_id,kind) VALUES(?,'delete')").run(id).lastInsertRowid);
    this.db.prepare('INSERT INTO cold_revocations VALUES(?,?)').run(id, revision);
    return revision;
  }

  page(query = '', offset = 0, limit = 50): ColdPage {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || query.length > 1000) {
      throw new AppFailure('cold_page_invalid');
    }
    const terms = query.normalize('NFC').toLowerCase().trim().split(/\s+/u).filter(Boolean);
    // Literal parameterized search: %, _ and SQL syntax never become query operators.
    const where = terms.length ? ' WHERE ' + terms.map(() => 'instr(cold_search_text(text),?)>0').join(' AND ') : '';
    const total = this.db.prepare('SELECT COUNT(*) FROM cold_memories' + where).pluck().get(...terms) as number;
    const items = this.db.prepare('SELECT * FROM cold_memories' + where + ' ORDER BY archive_revision DESC,id LIMIT ? OFFSET ?')
      .all(...terms, limit, offset) as ColdMemory[];
    for (const item of items) if (coldHash(item.text) !== item.text_hash) throw new AppFailure('cold_original_hash');
    return { items, total, next: offset + items.length < total ? offset + items.length : null, revision: this.revision() };
  }
}
