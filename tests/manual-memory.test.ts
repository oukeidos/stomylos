import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { memoryJson, memoryHash, capacityMemoryVersion } from '../src/main/memory-updater';
import { conversationComponents } from '../src/main/contracts';
import { memoryCharacters } from '../src/main/memory-render';
import { matchingMemories } from '../src/shared/memory-management';
import { validateCommand } from '../src/main/ipc';
import { currentSchema, migrateDatabase, validateSchema } from '../src/main/database-migrations';
import schema from '../src/main/schema.sql?raw';
const fixtures: {dir:string;store:Store;db:Database.Database}[]=[];
afterEach(() => { for (const f of fixtures) { f.store.close(); if (f.db.open) f.db.close(); rmSync(f.dir,{recursive:true,force:true}); } fixtures.length=0; });
function fixture() {
  const dir=mkdtempSync('/tmp/stomylos-manual-memory-'), store=new Store(dir,resolve('native/advisory-lock.node'));
  const db=new Database(join(dir,'stomylos.sqlite3')); const f={dir,store,db};fixtures.push(f);
  const document=memoryJson({character_id:'shared',revision:3,database_records:[{id:'a',text:'Coffee in the morning.'},{id:'b',text:'Lives in 서울.'}]});
  db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(document,memoryHash(document));return f;
}
function edit(store: Store,text:string|null='Tea in the evening.',id='a') {
  const current=store.memoryManagement();return {id,text,revision:current.document.revision,hash:current.hash};
}
function change(store:Store,text:string|null='Tea in the evening.',id='a') {return store.commitMemoryEdit(store.prepareMemoryEdit(edit(store,text,id)));}
function send(store:Store,id:string) {store.searchMode(id,'off');store.selectManual(id,'model_04');store.submit(id,'I enjoy museums.');store.commitRoute(id,null,'fixture',null);}
it('edits exactly one record, preserves text and IDs, deletes the final record and persists across restart',()=>{
 const f=fixture();expect(change(f.store,' Tea\n한글  detail. ').document).toMatchObject({revision:4,database_records:[{id:'a',text:' Tea\n한글  detail. '},{id:'b',text:'Lives in 서울.'}]});
 change(f.store,null);const empty=change(f.store,null,'b');expect(empty.document).toMatchObject({revision:6,database_records:[]});
 f.store.close();f.store=new Store(f.dir,resolve('native/advisory-lock.node'));expect(f.store.memoryManagement().document).toEqual(empty.document);
});
it.each(['starter','user'] as const)('allows untouched %s sessions and drafts, without freezing from reads; first request receives the edit',kind=>{
 const {store,db}=fixture();const s=store.createSession();if(kind==='user')store.setOpening(s.id,'opening',s.opening_revision,kind);
 store.saveDraft(s.id,'Exact draft 한글');store.selectManual(s.id,'model_04');
 const before=store.session(s.id);store.view(s.id);store.memoryManagement();expect(db.prepare('SELECT COUNT(*) FROM session_memories').pluck().get()).toBe(0);
 expect(store.memoryManagement().blocker).toBeNull();const updated=change(store);
 expect(store.session(s.id)).toEqual(before);send(store,s.id);const request=store.prepareChat(s.id,'reply');
 expect(JSON.parse(request.config).memory_context).toEqual(updated.document);expect(store.chatBody(request.id)).toBeTruthy();
});
it('blocks accepted Send even before a snapshot and after failed preparation/restart; a rejected empty Send does not lock',()=>{
 const f=fixture(),s=f.store.createSession();expect(()=>f.store.submit(s.id,' ')).toThrow();expect(f.store.memoryManagement().blocker).toBeNull();
 const prepared=f.store.prepareMemoryEdit(edit(f.store));f.store.submit(s.id,'My first message.');
 expect(f.db.prepare('SELECT COUNT(*) FROM session_memories').pluck().get()).toBe(0);
 expect(f.store.memoryManagement().blocker).toEqual({reason:'chat',sessionId:s.id});expect(()=>f.store.commitMemoryEdit(prepared)).toThrow('memory_in_use');
 f.store.close();f.store=new Store(f.dir,resolve('native/advisory-lock.node'));expect(()=>change(f.store)).toThrow('memory_in_use');
});
it('blocks frozen retry and unresolved end work; cancellation releases edits without changing history or accepting late results',()=>{
 const {store,db}=fixture(),s=store.createSession();send(store,s.id);const request=store.prepareChat(s.id,'reply');store.dispatch(request.id);store.failRequest(request.id,'request_timeout');
 const history=db.prepare('SELECT * FROM session_memories').all(),requests=db.prepare('SELECT * FROM model_requests').all();
 expect(()=>change(store)).toThrow('memory_in_use');store.end(s.id);expect(store.memoryManagement().blocker?.reason).toBe('processing');
 const attempt=store.prepareMemory(s.id,'update');store.dispatchMemory(attempt.id);store.failMemory(attempt.id,'request_timeout');expect(()=>change(store)).toThrow('memory_in_use');
 store.cancelEnd(s.id);expect(store.memoryManagement().blocker).toBeNull();change(store);
 expect(()=>store.saveMemory(attempt.id,'{"add":[],"update":[],"delete":[]}',{})).toThrow();
 expect(db.prepare('SELECT * FROM session_memories').all()).toEqual(history);expect(db.prepare('SELECT * FROM model_requests').all()).toEqual(requests);
});
it('allows edits after successful end update and preserves the stored per-chat change evidence',()=>{
 const {store}=fixture(),s=store.createSession();send(store,s.id);store.freezeMemory(s.id);store.end(s.id);
 const attempt=store.prepareMemory(s.id,'update');store.dispatchMemory(attempt.id);store.saveMemory(attempt.id,'{"add":[],"update":[],"delete":[]}',{});
 const {current: _before,...history}=store.view(s.id).memory;expect(store.memoryManagement().blocker).toBeNull();change(store);const {current: _after,...saved}=store.view(s.id).memory;expect(saved).toEqual(history);
});
it('rejects stale/missing/invalid targets and capacity overflow, keeps a boundary Unicode edit, and acknowledges only the exact committed result',()=>{
 const {store}=fixture(),before=store.memoryManagement(),stale=edit(store);const prepared=store.prepareMemoryEdit(stale);
 expect(()=>store.prepareMemoryEdit({...stale,id:'missing'})).toThrow('memory_edit_conflict');expect(()=>store.prepareMemoryEdit({...stale,text:' '})).toThrow('memory_item');
 expect(()=>store.prepareMemoryEdit({...stale,text:'한'.repeat(30000)})).toThrow('memory_edit_capacity');expect(store.memoryManagement()).toEqual(before);
 store.commitMemoryEdit(prepared);expect(store.commitMemoryEdit(prepared).document.revision).toBe(4);
 expect(()=>store.prepareMemoryEdit(stale)).toThrow('memory_edit_conflict');
 const base=store.currentMemory(), overhead=memoryCharacters({...base,database_records:[{id:'a',text:'한'}, {id:'b',text:'Lives in 서울.'}]} as any)-1;
 const boundaryText=' '.repeat(30)+'한'.repeat(30000-overhead)+'\n';expect(()=>validateCommand('editMemory',edit(store,boundaryText))).not.toThrow();const boundary=change(store,boundaryText);expect(memoryCharacters(boundary.document)).toBe(30000);
 expect(()=>store.commitMemoryEdit(prepared)).toThrow('memory_edit_conflict');
});
it('rolls back the entire manual write on storage failure',()=>{
 const {store,db}=fixture();const before=store.memoryManagement();
 db.exec("CREATE TRIGGER fixture_failure BEFORE UPDATE ON shared_memory BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;");
 expect(()=>change(store)).toThrow('fixture write failure');expect(store.memoryManagement()).toEqual(before);
 db.exec('DROP TRIGGER fixture_failure');change(store);expect(store.currentMemory().revision).toBe(4);
});
it('updates an untouched legacy memory wrapper without changing roster, opening/draft or frozen evidence; latest memory enters first request',()=>{
 const {store,db}=fixture(),s=store.createSession();store.saveDraft(s.id,'Untouched draft');store.selectManual(s.id,'model_04');
 const saved=JSON.parse(s.chat_config);saved.memory_version=capacityMemoryVersion;saved.component_hashes=conversationComponents(saved.version,capacityMemoryVersion);
 db.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(saved),s.id);
 const seed=memoryJson({character_id:'shared',revision:0,traits:[],relationships:[],experiences:[],intentions:[]});db.prepare('INSERT INTO memory_legacy_seeds VALUES(?,?,?)').run(s.id,seed,memoryHash(seed));
 const updated=change(store),next=store.session(s.id);expect(next.draft).toBe('Untouched draft');expect(next.starter_text).toBe(s.starter_text);expect(next.manual_character).toBe('model_04');
 expect(JSON.parse(next.chat_config).characters).toEqual(saved.characters);expect(db.prepare('SELECT COUNT(*) FROM memory_legacy_seeds').pluck().get()).toBe(0);
 send(store,s.id);const request=store.prepareChat(s.id,'reply');expect(JSON.parse(request.config).memory_context).toEqual(updated.document);expect(store.chatBody(request.id)).toBeTruthy();
});
it('matches literal multi-term NFC/case text in order without translation or regular expressions',()=>{
 const rows=[{id:'a',text:'CAFÉ (Coffee) morning?'},{id:'b',text:'Coffee at night + tea'},{id:'c',text:'서울 커피'}];
 expect(matchingMemories(rows,'  ')).toEqual(rows);expect(matchingMemories(rows,'morning coffee')).toEqual([rows[0]]);
 expect(matchingMemories(rows,'CAFE\u0301')).toEqual([rows[0]]);expect(matchingMemories(rows,'(')).toEqual([rows[0]]);expect(matchingMemories(rows,'+')).toEqual([rows[1]]);expect(matchingMemories(rows,'커피')).toEqual([rows[2]]);
});
it('validates the narrow management commands and rejects arbitrary documents, empty edits and malformed versions',()=>{
 const {store}=fixture(),args=edit(store);expect(()=>validateCommand('memoryManagement',undefined)).not.toThrow();expect(()=>validateCommand('editMemory',args)).not.toThrow();expect(()=>validateCommand('editMemory',{...args,text:null})).not.toThrow();
 for(const bad of [undefined,{...args,document:{}},{...args,text:''},{...args,revision:-1},{...args,hash:'bad'},{...args,text:'a'.repeat(1_000_001)}])expect(()=>validateCommand('editMemory',bad)).toThrow('invalid_command');
});
it('admits schema 24 through step 25 with unchanged data, verified backup, rollback/restart, no-op and newer-version refusal',()=>{
 const {store,db,dir}=fixture();store.close();db.exec('DROP TABLE session_memory_policy; DROP TABLE memory_preferences;');db.pragma('user_version=24');
 const before=db.prepare('SELECT * FROM shared_memory').all();const exec=db.exec.bind(db);
 const fault=vi.spyOn(db,'exec').mockImplementation(sql=>{const result=exec(sql);if(sql.includes('Admit direct user memory edits'))throw new Error('step25 fault');return result;});
 expect(()=>migrateDatabase(db,dir)).toThrow('step25 fault');fault.mockRestore();expect(db.pragma('user_version',{simple:true})).toBe(24);expect(db.prepare('SELECT * FROM shared_memory').all()).toEqual(before);
 const backup=readFileSync(join(dir,'stomylos.pre-migration-v24.sqlite3'));migrateDatabase(db,dir);expect(db.pragma('user_version',{simple:true})).toBe(currentSchema);validateSchema(db,schema);
 expect(db.prepare('SELECT * FROM shared_memory').all()).toEqual(before);expect(readFileSync(join(dir,'stomylos.pre-migration-v24.sqlite3'))).toEqual(backup);
 const changes=db.prepare('SELECT total_changes()').pluck().get();migrateDatabase(db,dir);expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes);
 db.pragma(`user_version=${currentSchema+1}`);expect(()=>migrateDatabase(db,dir)).toThrow('unsupported_schema_version');
});
