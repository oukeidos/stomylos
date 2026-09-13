import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coldFixture, coldSession } from './cold-memory-fixtures';
import { coldHash } from '../src/main/cold-memory-store';
import { currentSchema, migrateDatabase, validateSchema } from '../src/main/database-migrations';
import { memoryCharacters } from '../src/main/memory-render';
import current from '../src/main/schema.sql?raw';

const fixtures: ReturnType<typeof coldFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.close()));
function fixture() {
  const f = coldFixture(); fixtures.push(f);
  f.db.pragma('user_version=34');
  const document = {character_id:'shared',revision:7,database_records:[
    {id:'old',text:'🙂'.repeat(1100)}, {id:'recent',text:'r'.repeat(2700)}
  ]};
  const encoded = JSON.stringify(document);
  f.db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(encoded,coldHash(encoded));
  f.db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,source_session_id,observed_at,origin) VALUES('old',1,0,'deleted-source','2026-08-01T00:00:00Z','add'),('recent',2,0,NULL,NULL,'legacy')").run();
  const session = coldSession(f.store);
  f.store.close();
  return Object.assign(f, {session, document, encoded});
}
function history(db: Database.Database) {
  return ['sessions','messages','model_requests','session_memories','session_cold_recollections','memory_add_jobs','memory_add_attempts'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
}
it('archives schema-34 overflow with provenance and a verified backup while retaining frozen chats and pending ADD', () => {
  const f=fixture(), before=history(f.db);
  migrateDatabase(f.db,f.directory);
  expect(f.db.pragma('user_version',{simple:true})).toBe(currentSchema);
  validateSchema(f.db,current);
  const hot=JSON.parse(f.db.prepare('SELECT document FROM shared_memory').pluck().get() as string);
  expect(hot).toEqual({...f.document,revision:8,database_records:[f.document.database_records[1]]});
  expect(memoryCharacters(hot)).toBeLessThanOrEqual(3000);
  expect(f.db.prepare('SELECT * FROM cold_memories').get()).toMatchObject({id:'old',text:f.document.database_records[0].text,text_hash:coldHash(f.document.database_records[0].text),source_order:1,item_index:0,source_session_id:'deleted-source',observed_at:'2026-08-01T00:00:00Z',time_basis:'source_message'});
  expect(f.db.prepare('SELECT id FROM memory_item_metadata').all()).toEqual([{id:'recent'}]);
  expect(history(f.db)).toEqual(before);
  const file=join(f.directory,'stomylos.pre-migration-v34.sqlite3'), bytes=readFileSync(file);
  const backup=new Database(file,{readonly:true});
  try { expect(backup.pragma('user_version',{simple:true})).toBe(34);expect(backup.prepare('SELECT document FROM shared_memory').pluck().get()).toBe(f.encoded); } finally {backup.close();}
  migrateDatabase(f.db,f.directory);
  expect(readFileSync(file)).toEqual(bytes);
  expect(f.db.prepare('SELECT COUNT(*) FROM cold_memories').pluck().get()).toBe(1);
  f.reopen();
  expect(f.store.freezeMemory(f.session.id)).toEqual(f.document);
  f.store.end(f.session.id);f.store.cancelEnd(f.session.id);
  const next=f.store.createSession();f.store.selectManual(next.id,'model_04');
  f.store.submit(next.id,'A new chat.');f.store.commitRoute(next.id,null,'fixture',null);
  expect(f.store.freezeMemory(next.id)).toEqual(hot);
});
it('rolls back archival failure and restarts with the same backup', () => {
  const f=fixture(), before=history(f.db), prepare=f.db.prepare.bind(f.db);
  const fault=vi.spyOn(f.db,'prepare').mockImplementation((sql: string) => {
    if(sql.startsWith('INSERT INTO cold_memories')) throw new Error('rebalance disk failure');
    return prepare(sql);
  });
  expect(()=>migrateDatabase(f.db,f.directory)).toThrow('rebalance disk failure');fault.mockRestore();
  expect(f.db.pragma('user_version',{simple:true})).toBe(34);
  expect(f.db.prepare('SELECT document FROM shared_memory').pluck().get()).toBe(f.encoded);
  expect(f.db.prepare('SELECT COUNT(*) FROM cold_mutations').pluck().get()).toBe(0);
  expect(history(f.db)).toEqual(before);
  const file=join(f.directory,'stomylos.pre-migration-v34.sqlite3'), bytes=readFileSync(file);
  f.reopen();
  expect(f.db.pragma('user_version',{simple:true})).toBe(currentSchema);
  expect(readFileSync(file)).toEqual(bytes);
  expect(memoryCharacters(f.store.currentMemory())).toBeLessThanOrEqual(3000);
});
