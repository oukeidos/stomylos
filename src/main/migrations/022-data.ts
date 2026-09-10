import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
// Frozen schema-22 conversion: do not depend on moving runtime contracts.
const categories = ['traits', 'relationships', 'experiences', 'intentions'];
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const encode = (v: any) => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
export function migrate22Data(db: Database.Database) {
  const saved = db.prepare('SELECT document,document_hash FROM shared_memory WHERE id=1').get() as {document:string;document_hash:string} | undefined;
  if (!saved || hash(saved.document) !== saved.document_hash) throw new Error('migration_memory_hash');
  const doc = JSON.parse(saved.document), ids = new Set<string>();
  if (!doc || doc.character_id !== 'shared' || !Number.isSafeInteger(doc.revision) || doc.revision < 0 || Object.keys(doc).sort().join() !== ['character_id','revision',...categories].sort().join()) throw new Error('migration_memory_document');
  for (const c of categories) {
    if (!Array.isArray(doc[c])) throw new Error('migration_memory_document');
    for (const item of doc[c]) {
      if (!item || Object.keys(item).sort().join() !== 'id,text' || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.text !== 'string' || !item.text.trim() || Array.from(item.text).length > 1000000) throw new Error('migration_memory_item');
      ids.add(item.id);
    }
  }
  if (ids.size > 1000000 || Buffer.byteLength(encode(doc)) > 1000000) throw new Error('migration_memory_budget');
  const rendered = categories.map(c => c[0].toUpperCase()+c.slice(1)+':\n'+(doc[c].map((i:any)=>'- '+i.text.replace(/\r\n?/g,'\n').trim()).join('\n')||'- None recorded.')).join('\n');
  if (Array.from(rendered).length > 30000) throw new Error('migration_memory_over_cap');
  if (db.prepare("SELECT 1 FROM memory_jobs WHERE state NOT IN ('completed','skipped') LIMIT 1").get()) db.prepare('INSERT INTO memory_legacy_bridge VALUES(1,?,?)').run(saved.document,saved.document_hash);
  // Pin only unsnapshotted open legacy sessions; never rewrite frozen evidence.
  db.prepare(`INSERT INTO memory_legacy_seeds(session_id,document,document_hash)
    SELECT id,?,? FROM sessions WHERE state!='ended'
    AND json_extract(chat_config,'$.memory_version') IS NOT NULL
    AND id NOT IN (SELECT session_id FROM session_memories)`).run(saved.document,saved.document_hash);
  const flat = encode({character_id:doc.character_id,revision:doc.revision,database_records:categories.flatMap(c=>doc[c])});
  db.prepare('UPDATE shared_memory SET document=?,document_hash=? WHERE id=1').run(flat,hash(flat));
}
