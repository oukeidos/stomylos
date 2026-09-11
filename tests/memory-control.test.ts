import { universalSnapshot } from './time-fixtures';
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../src/main/database';
import { memoryHash, memoryJson } from '../src/main/memory-updater';
import { validateCommand } from '../src/main/ipc';
import { migrateDatabase, currentSchema, validateSchema } from '../src/main/database-migrations';
import schema from '../src/main/schema.sql?raw';
const fixtures:{dir:string;store:Store;db:Database.Database}[]=[];
afterEach(()=>{ for(const f of fixtures.splice(0)){f.store.close();if(f.db.open)f.db.close();rmSync(f.dir,{recursive:true,force:true});} });
function fixture() {
 const dir=mkdtempSync('/tmp/stomylos-memory-control-'),store=new Store(dir,resolve('native/advisory-lock.node'));
 const db=new Database(join(dir,'stomylos.sqlite3'));const f={dir,store,db};fixtures.push(f);
 const document=memoryJson({character_id:'shared',revision:3,database_records:[{id:'a',text:'MEMORY_SENTINEL likes tea.'}]});
 db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(document,memoryHash(document));
 db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin) VALUES('a',0,0,'legacy')").run();return f;
}
function toggle(store:Store, enabled:boolean) {return store.setMemoryPreference(enabled,store.memoryPreference().revision);}
function send(store:Store,id:string,text='I enjoy museums.') {store.searchMode(id,'off');store.selectManual(id,'model_04');store.submit(id,text);store.commitRoute(id,null,'fixture',null);}
function complete(store:Store,start:ReturnType<Store['startChat']>) {store.finishReply(start.request.id,start.bubble.id,'Tell me about the museum.',{});}
it.each(['starter','user'] as const)('Off before the first %s handoff replaces only an undispatched request and preserves the learner source',kind=>{
 const {store,db}=fixture(),s=store.createSession();if(kind==='user')store.setOpening(s.id,'opening',s.opening_revision,kind);
 store.saveDraft(s.id,'Draft 한글');send(store,s.id);const request=store.prepareChat(s.id,'first');const old=store.request(request.id);
 toggle(store,false);const started=store.startChat(request.id);
 expect(started.request.id).not.toBe(request.id);expect(store.request(request.id).config).toBe(old.config);
 expect(JSON.stringify(started.body)).not.toContain('MEMORY_SENTINEL');expect(store.view(s.id).memoryPolicy).toEqual({firstEnabled:false,updatesDisabled:true});
 expect(db.prepare("SELECT count(*) FROM messages WHERE origin='learner'").pluck().get()).toBe(1);
 complete(store,started);toggle(store,true);store.submit(s.id,'I also like galleries.');const next=store.startChat(store.prepareChat(s.id,'second').id);
 expect(JSON.stringify(next.body)).not.toContain('MEMORY_SENTINEL');complete(store,next);store.end(s.id);expect(store.memoryJob(s.id)).toBeNull();expect(store.endBlocker()).toBeNull();
});
it('Off and On before handoff uses the final preference; an untouched draft stays unbound',()=>{
 const {store}=fixture(),s=store.createSession();toggle(store,false);expect(store.view(s.id).memoryPolicy?.firstEnabled).toBeNull();
 send(store,s.id);const q=store.prepareChat(s.id,'first');toggle(store,true);const start=store.startChat(q.id);
 expect(JSON.stringify(start.body)).toContain('MEMORY_SENTINEL');expect(store.view(s.id).memoryPolicy?.updatesDisabled).toBe(false);
});
it('On chat revokes writes after Off, blocks exact memory retries, and never rewrites a saved retry',()=>{
 const {store}=fixture(),s=store.createSession();send(store,s.id);const first=store.startChat(store.prepareChat(s.id,'first').id);store.failRequest(first.request.id,'request_timeout');
 const saved=first.request.config;toggle(store,false);expect(()=>store.prepareChat(s.id,'retry','retry')).toThrow('memory_retry_disabled');
 toggle(store,true);const retry=store.prepareChat(s.id,'retry-on','retry');expect(retry.config).toBe(saved);const started=store.startChat(retry.id);complete(store,started);
 toggle(store,false);store.submit(s.id,'Today I visited a garden.');const off=store.startChat(store.prepareChat(s.id,'off-send').id);expect(JSON.stringify(off.body)).not.toContain('MEMORY_SENTINEL');
 store.failRequest(off.request.id,'request_timeout');toggle(store,true);const exact=store.prepareChat(s.id,'off-retry','retry');expect(exact.config).toBe(off.request.config);complete(store,store.startChat(exact.id));
 store.end(s.id);expect(store.memoryJob(s.id)).toBeNull();expect(store.view(s.id).memoryPolicy?.updatesDisabled).toBe(true);
});
it('settings stays locked by end work; existing cancellation stays terminal after Off/On and restart',()=>{
 const f=fixture(),s=f.store.createSession();send(f.store,s.id);complete(f.store,f.store.startChat(f.store.prepareChat(s.id,'first').id));f.store.end(s.id);
 const a=f.store.prepareMemory(s.id,'update');f.store.dispatchMemory(a.id);
 expect(()=>toggle(f.store,false)).toThrow('end_processing_pending');expect(f.store.memoryPreference().enabled).toBe(true);
 f.store.cancelEnd(s.id);toggle(f.store,false);toggle(f.store,true);
 expect(()=>f.store.saveMemory(a.id,'{"add":[],"update":[],"delete":[]}',{})).toThrow();expect(()=>f.store.retryMemory(s.id)).toThrow('end_processing_cancelled');
 f.store.close();f.store=new Store(f.dir,resolve('native/advisory-lock.node'));expect(f.store.memoryJob(s.id)?.state).toBe('skipped');expect(f.store.endBlocker()).toBeNull();expect(f.store.memoryPreference().enabled).toBe(true);
});
it('persists Off and unbound drafts, rejects stale/conflicting commands and applies no backfill at End',()=>{
 const f=fixture(),s=f.store.createSession();const before=f.store.memoryPreference();toggle(f.store,false);
 expect(f.store.setMemoryPreference(false,before.revision)).toEqual(f.store.memoryPreference());expect(()=>f.store.setMemoryPreference(true,before.revision)).toThrow('memory_setting_conflict');
 f.store.close();f.store=new Store(f.dir,resolve('native/advisory-lock.node'));expect(f.store.memoryPreference().enabled).toBe(false);expect(f.store.view(s.id).memoryPolicy?.firstEnabled).toBeNull();
 send(f.store,s.id);f.store.end(s.id);expect(f.store.memoryJob(s.id)).toBeNull();toggle(f.store,true);expect(f.store.memoryJob(s.id)).toBeNull();
 for(const value of [{enabled:0,revision:0},{enabled:false,revision:-1},{enabled:true,revision:1,extra:true}]) expect(()=>validateCommand('setMemoryPreference',value)).toThrow();
 expect(()=>validateCommand('setMemoryPreference',{enabled:false,revision:0})).not.toThrow();
});
it('upgrades schema 25 with exact history preservation, dispatch-only defaults and current-schema parity',()=>{
 const f=fixture(),s=f.store.createSession();send(f.store,s.id);const first=f.store.startChat(f.store.prepareChat(s.id,'first').id);complete(f.store,first);f.store.end(s.id);f.store.cancelEnd(s.id);
 const draft=f.store.createSession();send(f.store,draft.id);f.store.prepareChat(draft.id,'unsent');
 const history=f.db.prepare('SELECT * FROM model_requests ORDER BY id').all(),snapshots=f.db.prepare('SELECT * FROM session_memories ORDER BY session_id').all();
 f.store.close();f.db.exec('DROP TABLE session_memory_policy; DROP TABLE memory_preferences; PRAGMA user_version=25;');
 migrateDatabase(f.db,f.dir);validateSchema(f.db,schema);expect(f.db.pragma('user_version',{simple:true})).toBe(currentSchema);
 expect(f.db.prepare('SELECT * FROM session_memory_policy').all()).toEqual([{session_id:s.id,first_enabled:1,updates_disabled:0}]);
 expect(f.db.prepare('SELECT * FROM model_requests ORDER BY id').all()).toEqual(history);expect(f.db.prepare('SELECT * FROM session_memories ORDER BY session_id').all()).toEqual(snapshots);
 const backup=readFileSync(join(f.dir,'stomylos.pre-migration-v25.sqlite3'));migrateDatabase(f.db,f.dir);expect(readFileSync(join(f.dir,'stomylos.pre-migration-v25.sqlite3'))).toEqual(backup);
 f.store=new Store(f.dir,resolve('native/advisory-lock.node'));expect(f.store.memoryPreference()).toEqual({enabled:true,revision:0});
});

it('rolls back a failed v26 step and preserves its backup on retry',()=>{
 const f=fixture();f.store.close();f.db.exec('DROP TABLE session_memory_policy; DROP TABLE memory_preferences; PRAGMA user_version=25;');
 const execute=f.db.exec.bind(f.db);
 f.db.exec=((sql:string)=>{const result=execute(sql);if(sql.includes('CREATE TABLE memory_preferences'))throw new Error('injected-v26');return result;}) as typeof f.db.exec;
 expect(()=>migrateDatabase(f.db,f.dir)).toThrow('injected-v26');f.db.exec=execute;
 expect(f.db.pragma('user_version',{simple:true})).toBe(25);expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='memory_preferences'").get()).toBeUndefined();
 const backup=readFileSync(join(f.dir,'stomylos.pre-migration-v25.sqlite3'));migrateDatabase(f.db,f.dir);expect(readFileSync(join(f.dir,'stomylos.pre-migration-v25.sqlite3'))).toEqual(backup);
 f.store=new Store(f.dir,resolve('native/advisory-lock.node'));
});

it('keeps an older no-memory conversation contract dispatchable without inventing a snapshot',()=>{
 const {store,db}=fixture(),s=store.createSession();db.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(universalSnapshot()),s.id);
 send(store,s.id);const started=store.startChat(store.prepareChat(s.id,'legacy').id);expect(JSON.stringify(started.body)).not.toContain('MEMORY_SENTINEL');
 complete(store,started);store.end(s.id);expect(store.memoryJob(s.id)).toBeNull();
});

it('applies Off to an undispatched first request recovered after restart rather than blocking it as an exact sent retry',()=>{
 const f=fixture(),s=f.store.createSession();send(f.store,s.id);const queued=f.store.prepareChat(s.id,'prepared');
 f.store.close();f.store=new Store(f.dir,resolve('native/advisory-lock.node'));toggle(f.store,false);
 const recovered=f.store.prepareChat(s.id,'recovered','retry');expect(recovered.parent_id).toBeNull();
 const start=f.store.startChat(recovered.id);expect(JSON.stringify(start.body)).not.toContain('MEMORY_SENTINEL');
 expect(f.store.request(queued.id).config).toBe(queued.config);expect(f.store.view(s.id).memoryPolicy?.firstEnabled).toBe(false);
});
