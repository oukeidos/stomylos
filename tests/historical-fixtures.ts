import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Store } from '../src/main/database';
import type { Json, OpeningKind } from '../src/shared/types';
import seven from '../src/main/conversation-v7-config.json';
import { conversationComponents, hash } from '../src/main/contracts';

/** The retained v7 / flat-memory contract, not today's new-conversation defaults. */
export function historicalConversation(kind: OpeningKind = 'starter'): Json {
  return { ...structuredClone(seven.conversation), system_prompt: seven.conversationPrompt,
    prompt_id: 'stomylos_conversation_prompt_v5', prompt_sha256: hash(seven.conversationPrompt), app_version: '0.22.0',
    memory_version: 'stomylos_memory_context_v5', time_version: 'stomylos_time_context_v1',
    component_hashes: conversationComponents(seven.conversation.version, 'stomylos_memory_context_v5'),
    router_prompt_version: 'stomylos_compact_router_v1', opening: { version: 'stomylos_opening_v1', kind } };
}
/** Insert an unsent historical session through its retained opening transition. */
export function historicalSession(store: Store, kind: OpeningKind = 'starter', snapshot = historicalConversation('user')) {
  const active = store.unfinished(); if (active) return store.session(active.id);
  if (store.endBlocker()) throw new Error('end_processing_pending');
  const db = (store as unknown as {db: Database.Database}).db, id = randomUUID();
  db.prepare("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind) VALUES(?,'draft',?,?,'user')")
    .run(id, new Date().toISOString(), JSON.stringify({...snapshot, opening: {version:'stomylos_opening_v1',kind:'user'}}));
  if (kind === 'starter') store.setOpening(id, randomUUID(), 0, 'starter');
  db.prepare('UPDATE sessions SET opening_revision=0,last_opening_operation=NULL WHERE id=?').run(id);
  return store.session(id);
}
/** Rebuild a synthetic fixture using an immutable schema and its original columns.
 * The caller must supply historically valid generation contracts and data values.
 * This is never a downgrade operation for application or user data.
 */
export function historicalSchema(db: Database.Database, version: number) {
  const frozen = `src/main/migrations/schema-v${version}.sql`;
  const current = readFileSync('src/main/schema.sql','utf8');
  const cutoff = version===40 || version===41 ? 42 : version===36 ? 37 : version;
  const marker = current.indexOf(`\n-- Public schema ${cutoff} -> ${cutoff+1}:`);
  const aliases: Record<number,number> = {14:18,15:18,16:18,17:18,20:21,22:23,24:25};
  const sql = existsSync(frozen) ? readFileSync(frozen,'utf8') : marker >= 0 ? current.slice(0,marker) : readFileSync(`src/main/migrations/schema-v${aliases[version]}.sql`,'utf8');
  const template = new Database(':memory:'); template.exec(sql);
  const tables = template.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[];
  const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all());
  const data = tables.map(table => {
    const columns = (template.pragma(`table_info(${table})`) as {name:string}[]).map(c=>c.name);
    const available = new Set((db.pragma(`table_info(${table})`) as {name:string}[]).map(c=>c.name));
    const common = columns.filter(c=>available.has(c));
    return {table, common, rows: existing.has(table) ? db.prepare(`SELECT ${common.join(',')} FROM ${table}`).all() : []};
  });
  template.close();
  const foreignKeys = db.pragma('foreign_keys', {simple:true}); db.pragma('foreign_keys=OFF');
  db.transaction(()=>{
    for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]) db.exec(`DROP TABLE "${name}"`);
    db.exec(sql);
    const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all() as {name:string;sql:string}[];
    for(const t of triggers)db.exec(`DROP TRIGGER "${t.name}"`);
    for(const {table,common,rows} of data) {
      db.exec(`DELETE FROM ${table}`);
      if(common.length) { const insert=db.prepare(`INSERT INTO ${table}(${common.join(',')}) VALUES(${common.map(()=>'?').join(',')})`);
        for(const row of rows as Json[])insert.run(...common.map(c=>row[c])); }
    }
    for(const t of triggers)db.exec(t.sql);
    db.pragma(`user_version=${version}`);
  })();
  db.pragma(`foreign_keys=${foreignKeys ? 'ON':'OFF'}`);
}

import { memoryHash } from '../src/main/memory-updater';
/** Synthetic HOT records need matching provenance just like migrated legacy records. */
export function seedMemory(db: Database.Database, document: string) {
  db.transaction(()=>{
    db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(document,memoryHash(document));
    db.exec('DELETE FROM memory_item_metadata');
    const insert=db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin) VALUES(?,0,?,'legacy')");
    for(const [i,item] of JSON.parse(document).database_records.entries())insert.run(item.id,i);
  })();
}
