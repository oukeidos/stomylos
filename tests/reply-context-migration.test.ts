import { memoryHash } from '../src/main/memory-updater';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StarterStore } from '../src/main/starter-store';
import old from '../src/main/migrations/schema-v30.sql?raw';
import current from '../src/main/schema.sql?raw';
import { migrateDatabase, validateSchema, currentSchema } from '../src/main/database-migrations';
import { conversationSnapshot } from '../src/main/contracts';
import { Store } from '../src/main/database';
const fixtures: {dir:string;db:Database.Database}[]=[];
afterEach(()=>{for(const {dir,db} of fixtures.splice(0)){if(db.open)db.close();rmSync(dir,{recursive:true,force:true});}});
it.each(['draft','active','ended'])('migrates 30 to 31 preserving a %s chat, rollback/restart, backup and fresh schema parity',(state)=>{
  const dir=mkdtempSync('/tmp/stomylos-reply-migration-'),db=new Database(join(dir,'stomylos.sqlite3')); fixtures.push({dir,db});
  db.exec(old);db.pragma('user_version=30'); db.transaction(()=>new StarterStore(db).initialize())();
  const memory=JSON.stringify({character_id:'shared',revision:0,database_records:[]});
  db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run(memory,memoryHash(memory));
  const config=JSON.stringify(conversationSnapshot('user'));
  db.prepare("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind,draft) VALUES(?,?,?,?,'user','Original draft')").run(state,state,'2026-09-01',config);
  if(state==='active') db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES('message','active',0,'user','Original words','learner','complete')").run();
  const history=db.prepare('SELECT * FROM messages').all(); const exec=db.exec.bind(db);
  const fault=vi.spyOn(db,'exec').mockImplementation(sql=>{const value=exec(sql);if(sql.includes('CREATE TABLE reply_preferences'))throw new Error('simulated interruption');return value;});
  expect(()=>migrateDatabase(db,dir)).toThrow('simulated interruption');fault.mockRestore();
  expect(db.pragma('user_version',{simple:true})).toBe(30);validateSchema(db,old);
  const backup=join(dir,'stomylos.pre-migration-v30.sqlite3'),bytes=readFileSync(backup);
  migrateDatabase(db,dir); expect(db.pragma('user_version',{simple:true})).toBe(currentSchema);validateSchema(db,current);
  expect(db.prepare('SELECT * FROM messages').all()).toEqual(history);
  for(const row of db.prepare('SELECT chat_config,draft,reply_context_revision,last_reply_context_operation FROM sessions').all() as any[]) expect(row).toEqual({chat_config:config,draft:'Original draft',reply_context_revision:0,last_reply_context_operation:null});
  expect(db.prepare('SELECT mode FROM reply_preferences').pluck().get()).toBe('one_point');
  migrateDatabase(db,dir);expect(readFileSync(backup)).toEqual(bytes);
  db.close(); const store=new Store(dir,resolve('native/advisory-lock.node'));
  try {
    expect(store.replyContextView(state)).toMatchObject({mode:'standard',canChange:state==='draft'});
  } finally {store.close();}
});
