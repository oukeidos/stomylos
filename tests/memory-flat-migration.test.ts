import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import source13 from '../src/main/migrations/schema-v13.sql?raw';
import source18 from '../src/main/migrations/schema-v18.sql?raw';
import source19 from '../src/main/migrations/schema-v19.sql?raw';
import source21 from '../src/main/migrations/schema-v21.sql?raw';
import current from '../src/main/schema.sql?raw';
import { installCatalog19 } from '../src/main/migrations/019-data';
import { migrateDatabase, validateSchema } from '../src/main/database-migrations';
import { MemoryStore } from '../src/main/memory-store';
import { emptyMemory, memoryHash, memoryJson, memoryConfig, memoryBody, candidateLimits } from '../src/main/memory-updater';
import { flattenMemory } from '../src/main/memory-flat';
const fixtures:{db:Database.Database;dir:string}[]=[];
afterEach(()=>{for(const f of fixtures){if(f.db.open)f.db.close();rmSync(f.dir,{recursive:true,force:true});}fixtures.length=0;});
function fixture(version=21) {
 const dir=mkdtempSync(join(tmpdir(),'stomylos-flat-upgrade-')), db=new Database(join(dir,'stomylos.sqlite3'));fixtures.push({db,dir});
 db.exec(version===13?source13:version<19?source18:version===19?source19:source21);
 if(version>=19)db.transaction(()=>installCatalog19(db))();
 db.pragma(`user_version=${version}`);
 const legacy=emptyMemory('shared');legacy.revision=8;
 legacy.traits=[{id:'first',text:'Same text.'}];legacy.intentions=[{id:'last',text:'Same text.'}];
 const encoded=memoryJson(legacy);db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run(encoded,memoryHash(encoded));
 return {db,dir,legacy};
}
function job(db:Database.Database,id='old',version='stomylos_memory_updater_v6') {
 db.prepare("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind) VALUES(?,'ended','2026-09-09','{}','user')").run(id);
 const source=memoryJson({id,character_id:'model_04',ended_at:'2026-09-09',timezone:'UTC',messages:[{id:'user-'+id,role:'user',origin:'learner',delivery:'complete',content:'I changed this.',sent_time:null}]});
 const config=memoryJson(memoryConfig(version));
 db.prepare("INSERT INTO memory_jobs(session_id,character_id,source,source_hash,config,config_hash,created_at,state) VALUES(?,'model_04',?,?,?,?,'2026-09-09','pending')").run(id,source,memoryHash(source),config,memoryHash(config));
 return config;
}
it.each([13,14,15,16,17,18,19,20,21])('upgrades supported schema %i to flat memory without dropping equal-text records',version=>{
 const {db,dir,legacy}=fixture(version);migrateDatabase(db,dir);
 expect(db.pragma('user_version',{simple:true})).toBe(22);validateSchema(db,current);
 const saved=db.prepare('SELECT * FROM shared_memory').get() as any;
 expect(JSON.parse(saved.document)).toEqual(flattenMemory(legacy));expect(saved.document_hash).toBe(memoryHash(saved.document));
 expect(db.prepare('SELECT * FROM memory_legacy_bridge').all()).toEqual([]);
 const backup=readFileSync(join(dir,`stomylos.pre-migration-v${version}.sqlite3`));migrateDatabase(db,dir);expect(readFileSync(join(dir,`stomylos.pre-migration-v${version}.sqlite3`))).toEqual(backup);
 expect(db.pragma('foreign_key_check')).toEqual([]);
});
it('rolls back the changed step and restarts with the same pre-upgrade backup',()=>{
 const {db,dir,legacy}=fixture();const exec=db.exec.bind(db);
 const fault=vi.spyOn(db,'exec').mockImplementation(sql=>{const result=exec(sql);if(sql.includes('CREATE TABLE memory_legacy_bridge'))throw new Error('step22 fault');return result;});
 expect(()=>migrateDatabase(db,dir)).toThrow('step22 fault');fault.mockRestore();
 expect(db.pragma('user_version',{simple:true})).toBe(21);validateSchema(db,source21);
 expect(JSON.parse(db.prepare('SELECT document FROM shared_memory').pluck().get() as string)).toEqual(legacy);
 const backup=readFileSync(join(dir,'stomylos.pre-migration-v21.sqlite3'));migrateDatabase(db,dir);
 expect(readFileSync(join(dir,'stomylos.pre-migration-v21.sqlite3'))).toEqual(backup);
});
it.each(['unattempted','failed','received'])('preserves a %s legacy job through migration and commits it before v7',state=>{
 const {db,dir,legacy}=fixture(), config=job(db);job(db,'new','stomylos_memory_updater_v7');
 let memory=new MemoryStore(db), original:any;
 if(state!=='unattempted') {
  original=memory.prepare('old','first');memory.dispatch('first');
  if(state==='failed')memory.fail('first','request_timeout',null,{});
 }
 const rows=db.prepare('SELECT * FROM memory_jobs').all();migrateDatabase(db,dir);
 expect(db.prepare('SELECT * FROM memory_jobs').all()).toEqual(rows);memory=new MemoryStore(db);
 expect(()=>memory.prepare('new','premature')).toThrow('memory_not_ready');
 let attempt=original;
 if(state==='failed'){memory.retry('old');attempt=memory.prepare('old','retry');expect(attempt.input_json).toBe(original.input_json);memory.dispatch(attempt.id);}
 if(state==='unattempted'){attempt=memory.prepare('old','first');memory.dispatch(attempt.id);}
 expect(memoryBody(JSON.parse(config),JSON.parse(attempt.input_json))).toEqual(memoryBody(JSON.parse(config),{current_memory:legacy,limits:candidateLimits,session:JSON.parse(memory.job('old')!.source)}));
 const result=memory.save(attempt.id,JSON.stringify({operations:[{op:'update',id:'m2',category:'experiences',text:'Corrected.',source_message_ids:['u1']}]}),{});
 expect(memory.load()).toEqual(flattenMemory(result));expect(db.prepare('SELECT * FROM memory_legacy_bridge').all()).toEqual([]);
 const next=memory.prepare('new','next');expect(JSON.parse(next.input_json).current_memory).toEqual(memory.load());
 memory.dispatch('next');memory.save('next','{"add":[],"update":[],"delete":[]}',{});
 expect(memory.job('new')!.state).toBe('completed');
});
it('keeps old pending cleanup config/input and accepts its received response after upgrade',()=>{
 const {db,dir}=fixture();job(db);let memory=new MemoryStore(db);
 const a=memory.prepare('old','a');memory.dispatch(a.id);
 memory.save(a.id,JSON.stringify({operations:[{op:'add',id:null,category:'traits',text:'x'.repeat(31000),source_message_ids:['u1']}]}),{});
 const c=memory.prepareCleanup('old','cleanup');memory.dispatchCleanup(c.id);
 memory.receiveCleanup(c.id,'Traits\nUseful retained information.\nRelationships\nExperiences\nIntentions',{});
 const before=db.prepare('SELECT * FROM memory_candidates').get();migrateDatabase(db,dir);memory=new MemoryStore(db);memory.recover();
 expect(db.prepare('SELECT * FROM memory_candidates').get()).toEqual(before);
 memory.retry('old');
 expect(memory.prepareCleanup('old','unused').id).toBe('cleanup');
 const result=memory.acceptCleanup('cleanup');expect(memory.load()).toEqual(flattenMemory(result));
 expect(memory.cleanupAttempts('old')).toHaveLength(1);expect(db.prepare('SELECT * FROM memory_legacy_bridge').all()).toEqual([]);
});
it('preserves frozen snapshots and pins only unsnapshotted legacy sessions',()=>{
 const {db,dir,legacy}=fixture();
 for(const id of ['saved','waiting'])db.prepare("INSERT INTO sessions(id,state,character,created_at,chat_config,opening_kind) VALUES(?,?,'model_04','2026-09-09',?,'user')").run(id,id==='saved'?'ended':'draft',JSON.stringify({memory_version:'stomylos_memory_context_v4'}));
 const encoded=memoryJson(legacy);db.prepare('INSERT INTO session_memories VALUES(?,?,?,?)').run('saved','model_04',encoded,memoryHash(encoded));
 const before=db.prepare('SELECT * FROM session_memories').all();migrateDatabase(db,dir);
 expect(db.prepare('SELECT * FROM session_memories').all()).toEqual(before);
 expect(db.prepare('SELECT session_id FROM memory_legacy_seeds').pluck().all()).toEqual(['waiting']);
 const memory=new MemoryStore(db);expect(memory.snapshot(db.prepare("SELECT * FROM sessions WHERE id='waiting'").get() as any)).toEqual(legacy);
 expect(db.prepare('SELECT * FROM memory_legacy_seeds').all()).toEqual([]);
});
it('rejects corrupt bridge evidence and duplicate persistent IDs without silently repairing either',()=>{
 const {db,dir,legacy}=fixture();job(db);migrateDatabase(db,dir);
 db.prepare("UPDATE memory_legacy_bridge SET document_hash='broken'").run();
 const memory=new MemoryStore(db), before=memory.load();
 expect(()=>memory.prepare('old','attempt')).toThrow('memory_legacy_bridge_missing');expect(memory.load()).toEqual(before);
 const other=fixture();other.legacy.intentions[0].id=other.legacy.traits[0].id;
 const duplicate=memoryJson(other.legacy);other.db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(duplicate,memoryHash(duplicate));
 expect(()=>migrateDatabase(other.db,other.dir)).toThrow('migration_memory_item');
 expect(other.db.pragma('user_version',{simple:true})).toBe(21);validateSchema(other.db,source21);
});
it('keeps a seed until the old session chooses a partner and verifies its hash',()=>{
 const {db,dir,legacy}=fixture();
 db.prepare("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind) VALUES('waiting','draft','2026-09-09',?,'user')").run(JSON.stringify({memory_version:'stomylos_memory_context_v4'}));
 migrateDatabase(db,dir);const memory=new MemoryStore(db);
 const session=()=>db.prepare("SELECT * FROM sessions WHERE id='waiting'").get() as any;
 expect(memory.snapshot(session())).toBeNull();expect(db.prepare('SELECT COUNT(*) FROM memory_legacy_seeds').pluck().get()).toBe(1);
 db.prepare("UPDATE sessions SET character='model_04' WHERE id='waiting'").run();
 db.prepare("UPDATE memory_legacy_seeds SET document_hash='broken'").run();
 expect(()=>memory.snapshot(session())).toThrow('memory_legacy_snapshot_missing');
 db.prepare('UPDATE memory_legacy_seeds SET document_hash=?').run(memoryHash(memoryJson(legacy)));
 expect(memory.snapshot(session())).toEqual(legacy);expect(db.prepare('SELECT COUNT(*) FROM memory_legacy_seeds').pluck().get()).toBe(0);
});

import { Store } from '../src/main/database';
import { resolve } from 'node:path';
it('resumes an already received v6 updater response through actual startup migration without a new attempt',()=>{
 const {db,dir}=fixture();job(db);const memory=new MemoryStore(db);
 const attempt=memory.prepare('old','received');memory.dispatch(attempt.id);
 const response=JSON.stringify({operations:[{op:'update',id:'m2',category:'experiences',text:'Completed before upgrade.',source_message_ids:['u1']}]});
 db.prepare("INSERT INTO end_processing(session_id,created_at) VALUES('old','2026-09-09')").run();
 db.prepare("INSERT INTO end_stage_state(session_id,stage,response_id,response_content,response_metadata) VALUES('old','update',?,?,'{}')").run(attempt.id,response);
 db.close();const store=new Store(dir,resolve('native/advisory-lock.node'));
 try {
  expect(store.memoryJob('old')!.state).toBe('interrupted');
  expect(store.resumeEndResponse('old','update')).toBe(true);
  expect(store.resumeEndResponse('old','update')).toBe(false);
  expect(store.memoryJob('old')!.selected_attempt_id).toBe(attempt.id);
  const result=store.currentMemory();expect(result).toMatchObject({database_records:[{id:'first',text:'Same text.'},{id:'last',text:'Completed before upgrade.'}]});
  const inspect=new Database(join(dir,'stomylos.sqlite3'));
  try { expect(inspect.prepare('SELECT COUNT(*) FROM memory_attempts').pluck().get()).toBe(1);expect(inspect.prepare('SELECT input_json FROM memory_attempts').pluck().get()).toBe(attempt.input_json); }
  finally {inspect.close();}
 } finally {store.close();}
});
it('retires compatibility state when the last unfinished legacy job is cancelled',()=>{
 const {db,dir}=fixture();job(db);
 db.prepare("INSERT INTO end_processing(session_id,created_at) VALUES('old','2026-09-09')").run();db.close();
 const store=new Store(dir,resolve('native/advisory-lock.node'));
 try {
  const inspect=new Database(join(dir,'stomylos.sqlite3'));
  try {
   expect(inspect.prepare('SELECT COUNT(*) FROM memory_legacy_bridge').pluck().get()).toBe(1);
   const before=store.currentMemory();store.cancelEnd('old');
   expect(inspect.prepare('SELECT COUNT(*) FROM memory_legacy_bridge').pluck().get()).toBe(0);
   expect(store.currentMemory()).toEqual(before);store.deleteSession('old');expect(store.currentMemory()).toEqual(before);
  } finally {inspect.close();}
 } finally {store.close();}
});
