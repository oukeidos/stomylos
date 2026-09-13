// Frozen schema-35 transition: keep this reducer and archival contract independent
// of evolving runtime helpers. The startup runner owns backup and atomic commit.
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export function migrate35Data(db: Database.Database) {
  if (!db.inTransaction) throw new Error('memory_rebalance_transaction');
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const saved = db.prepare('SELECT document,document_hash FROM shared_memory WHERE id=1').get() as { document: string; document_hash: string } | undefined;
  if (!saved || hash(saved.document) !== saved.document_hash) throw new Error('memory_rebalance_hash');
  const doc = JSON.parse(saved.document);
  if (doc.character_id !== 'shared' || !Number.isSafeInteger(doc.revision) || doc.revision < 0 || !Array.isArray(doc.database_records) ||
    doc.database_records.some((item: {id: string; text: string}) => !item || typeof item.id !== 'string' || typeof item.text !== 'string')) throw new Error('memory_rebalance_document');
  const metadata = db.prepare('SELECT * FROM memory_item_metadata ORDER BY source_order,item_index').all() as {
    id: string; source_order: number; item_index: number; source_message_id: string | null; source_session_id: string | null;
    observed_at: string | null; edited_at: string | null; origin: string;
  }[];
  if (JSON.stringify(metadata.map(item => item.id)) !== JSON.stringify(doc.database_records.map((item: {id: string}) => item.id))) throw new Error('memory_rebalance_metadata');
  const count = () => Array.from(doc.database_records.map((item: {text: string}) => '- ' + item.text.replace(/\r\n?/g, '\n').trim()).join('\n') || '- None recorded.').length;
  if (count() > 4000) throw new Error('memory_rebalance_capacity');
  const known = (value: string | null) => value !== null && Number.isFinite(Date.parse(value));
  const archivedAt = new Date().toISOString();
  let removed = 0;
  while (count() > 3000) {
    const item = doc.database_records.shift(), source = metadata[removed++];
    if (db.prepare('SELECT 1 FROM cold_revocations WHERE memory_id=?').get(item.id) ||
      db.prepare('SELECT 1 FROM cold_memories WHERE id=?').get(item.id)) throw new Error('memory_rebalance_conflict');
    const textHash = hash(item.text);
    const revision = Number(db.prepare("INSERT INTO cold_mutations(memory_id,kind) VALUES(?,'archive')").run(item.id).lastInsertRowid);
    const timeBasis = source.origin === 'manual' ? known(source.edited_at) ? 'manual_edit' : 'unknown'
      : known(source.observed_at) ? 'source_message' : 'unknown';
    db.prepare(`INSERT INTO cold_memories(id,text,text_hash,source_order,item_index,source_message_id,
      source_session_id,observed_at,edited_at,archived_at,origin,time_basis,archive_revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.id, item.text, textHash, source.source_order, source.item_index,
      source.source_message_id, source.source_session_id, source.observed_at, source.edited_at, archivedAt, source.origin, timeBasis, revision);
    db.prepare(`INSERT INTO cold_embeddings(memory_id,space_id,source_hash,state)
      SELECT ?,s.id,?,'pending' FROM embedding_spaces s WHERE EXISTS
      (SELECT 1 FROM cluster_generations g WHERE g.space_id=s.id AND g.state IN ('active','building'))`).run(item.id, textHash);
    db.prepare('DELETE FROM memory_item_metadata WHERE id=?').run(item.id);
  }
  if (removed) {
    doc.revision++;
    const encoded = JSON.stringify(doc);
    db.prepare('UPDATE shared_memory SET document=?,document_hash=? WHERE id=1').run(encoded, hash(encoded));
  }
}
