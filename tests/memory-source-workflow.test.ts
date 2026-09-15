import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Store} from '../src/main/database';
import {memoryHash} from '../src/main/memory-updater';
import {sourceLinkIdentity} from '../src/main/memory-source-link';
const fixtures:{dir:string;store:Store;db:Database.Database}[]=[];
afterEach(()=>{for(const f of fixtures.splice(0)){f.store.close();f.db.close();rmSync(f.dir,{recursive:true,force:true});}});
function fixture(){
 const dir=mkdtempSync('/tmp/stomylos-source-workflow-'),store=new Store(dir,'isolated' as const),db=new Database(join(dir,'stomylos.sqlite3'));const f={dir,store,db};fixtures.push(f);
 const s=store.createSession();store.searchMode(s.id,'off');store.selectManual(s.id,'model_01');
 for(const text of ['Earlier hobby.','Later activity.']){store.submit(s.id,text);store.commitRoute(s.id,null,'fixture',null);const r=store.startChat(store.prepareChat(s.id,crypto.randomUUID()).id);store.finishReply(r.request.id,r.bubble.id,'Tell me more.',{});}
 store.end(s.id);return {...f,f,sid:s.id};
}
function attempt(store:Store){const j=store.memoryAddReady()!,a=store.prepareMemoryAdd(j.ordinal,crypto.randomUUID());store.prepareProvider('memory_add',a.id,JSON.parse(a.body),a.phase==='link'?sourceLinkIdentity:JSON.parse(j.config).identity);store.dispatchMemoryAdd(a.id);return a;}
function extract(store:Store,records=['Later note.','Earlier note.']){const a=attempt(store);store.receiveMemoryAdd(a.id,JSON.stringify({add:records}),{usage:{cost:.01}});store.acceptMemoryAdd(a.id);return a;}
const links='{"sources":[{"id":1,"ids":[1,3]},{"id":2,"ids":[1,2]}]}';
it('checkpoints extraction, retries only identical Luna input, and orders FIFO with stable record IDs',()=>{
 const {f,sid}=fixture();extract(f.store);expect(f.store.currentMemory().revision).toBe(0);const a=attempt(f.store);expect(a.phase).toBe('link');
 f.store.receiveMemoryAdd(a.id,'{"sources":[{"id":1,"ids":[1]},{"id":1,"ids":[3]}]}',{usage:{cost:.002}});expect(()=>f.store.acceptMemoryAdd(a.id)).toThrow('memory_source_format');f.store.failMemoryAdd(a.id,'memory_source_format');
 expect(f.store.endBlocker()).toBe(sid);expect(f.store.memoryAddReady()).toBeNull();f.store.close();f.store=new Store(f.dir,'isolated' as const);
 f.store.retryMemoryAdd(sid,f.store.view(sid).memory.addJobs![0].ordinal);const b=attempt(f.store);expect(b.body).toBe(a.body);expect(b.phase).toBe('link');f.store.receiveMemoryAdd(b.id,links,{usage:{cost:.002}});f.store.acceptMemoryAdd(b.id);f.store.acceptMemoryAdd(b.id);
 expect(f.store.currentMemory().revision).toBe(1);expect(f.store.endBlocker()).toBeNull();
 const records=f.store.memoryManagement().document.database_records;expect(records.map(r=>r.text)).toEqual(['Earlier note.','Later note.']);
 expect(records[0].id).toBe('add_'+memoryHash(JSON.stringify(['stomylos_session_memory_add_v1',sid,1])).slice(0,24));
 const h=f.store.requestHistory(sid).filter(r=>r.kind.includes('Memory'));expect(h.map(r=>r.kind)).toEqual(['Memory update · Session','Memory source linking · Session','Memory source linking · Session']);expect(h[1].parentId).toBeNull();expect(h[2].parentId).toBe(a.id);
 expect(h.reduce((n,r)=>n+(r.metadata.usage?.cost??0),0)).toBe(.014);
});
it('archives the earlier record, not the first model output, when sorted additions overflow HOT',()=>{
 const {store,db}=fixture();extract(store,['N'.repeat(1800),'O'.repeat(1800)]);const a=attempt(store);store.receiveMemoryAdd(a.id,links,{});store.acceptMemoryAdd(a.id);
 expect(store.memoryManagement().document.database_records.map(r=>r.text)).toEqual(['N'.repeat(1800)]);
 expect(db.prepare('SELECT text,item_index FROM cold_memories').get()).toEqual({text:'O'.repeat(1800),item_index:0});
 expect(db.prepare('SELECT item_index FROM memory_item_metadata').pluck().get()).toBe(1);
});
it.each(['skip','off'])('keeps shared memory untouched and ignores late link results after %s',mode=>{
 const {store,sid}=fixture();extract(store);const a=attempt(store);
 if(mode==='skip'){store.failMemoryAdd(a.id,'http_504');store.skipMemoryAdd(sid,store.view(sid).memory.addJobs![0].ordinal);}else {expect(()=>store.setMemoryPreference(false,0)).toThrow('end_processing_pending');store.cancelEnd(sid);}
 if(mode==='off'){store.receiveMemoryAdd(a.id,links,{});store.acceptMemoryAdd(a.id);}
 expect(store.currentMemory().revision).toBe(0);expect(store.endBlocker()).toBeNull();
});
it('does not redispatch a received link on restart, and marks in-flight linking as explicit recovery',()=>{
 const {f,sid}=fixture();extract(f.store);const a=attempt(f.store);f.store.close();f.store=new Store(f.dir,'isolated' as const);
 expect(f.store.memoryAddReady()).toBeNull();expect(f.store.view(sid).memory.addJobs![0]).toMatchObject({phase:'link',state:'interrupted'});
 f.store.retryMemoryAdd(sid,f.store.view(sid).memory.addJobs![0].ordinal);const b=attempt(f.store);f.store.receiveMemoryAdd(b.id,links,{});f.store.close();f.store=new Store(f.dir,'isolated' as const);
 const replay=f.store.prepareMemoryAdd(f.store.memoryAddReady()!.ordinal,'unused');expect(replay.id).toBe(b.id);expect(replay.phase).toBe('link');f.store.acceptMemoryAdd(replay.id);
 expect(f.store.view(sid).memory.addAttempts).toHaveLength(3);expect(f.store.endBlocker()).toBeNull();
});
it('retains a frozen legacy session job with no linker and applies it without extra calls',()=>{
 const {store,db,sid}=fixture();const j=store.memoryAddReady()!,c=JSON.parse(j.config);delete c.linker;
 const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE name='immutable_memory_add_input'").pluck().get() as string;
 db.exec('DROP TRIGGER immutable_memory_add_input');const config=JSON.stringify(c);db.prepare('UPDATE memory_add_jobs SET config=?,config_hash=? WHERE ordinal=?').run(config,memoryHash(config),j.ordinal);db.exec(trigger);
 const a=attempt(store);store.receiveMemoryAdd(a.id,'{"add":["Legacy note"]}',{});store.acceptMemoryAdd(a.id);expect(store.endBlocker()).toBeNull();expect(store.view(sid).memory.addAttempts).toHaveLength(1);
});
it('retries a local save failure without another model attempt',()=>{
 const {store,db,sid}=fixture();extract(store);const a=attempt(store);store.receiveMemoryAdd(a.id,links,{});
 db.exec("CREATE TRIGGER test_link_save BEFORE UPDATE ON shared_memory BEGIN SELECT RAISE(ABORT,'save fault'); END");
 expect(()=>store.acceptMemoryAdd(a.id)).toThrow('save fault');store.failMemoryAdd(a.id,'operation_failed');expect(store.memoryAddReady()).toBeNull();
 db.exec('DROP TRIGGER test_link_save');store.retryMemoryAdd(sid,store.view(sid).memory.addJobs![0].ordinal);
 const resumed=store.prepareMemoryAdd(store.memoryAddReady()!.ordinal,'not-a-new-call');expect(resumed.id).toBe(a.id);expect(resumed.status).toBe('received');store.acceptMemoryAdd(resumed.id);
 expect(store.view(sid).memory.addAttempts).toHaveLength(2);expect(store.currentMemory().revision).toBe(1);
});
it('reuses completed batches after a later link failure and applies only after all batches',()=>{
 const {store,db,sid}=fixture();extract(store,Array.from({length:1000},(_,i)=>'Record '+i+' '+ 'x'.repeat(2200)));
 const total=db.prepare('SELECT count(*) FROM memory_source_batches').pluck().get() as number;expect(total).toBeGreaterThan(1);
 let failedBody:string|undefined;
 for(let i=0;i<total;i++){
  let a=attempt(store);expect(a.phase).toBe('link');expect(a.batch_index).toBe(i);
  if(i===1){failedBody=a.body;store.failMemoryAdd(a.id,'http_504');store.retryMemoryAdd(sid,store.view(sid).memory.addJobs![0].ordinal);a=attempt(store);expect(a.body).toBe(failedBody);}
  const input=JSON.parse(JSON.parse(a.body).messages[1].content);
  store.receiveMemoryAdd(a.id,JSON.stringify({sources:input.records.map((r:any)=>({id:r[0],ids:[1]}))}),{});store.acceptMemoryAdd(a.id);
  expect(store.currentMemory().revision).toBe(i===total-1?1:0);
 }
 expect(store.endBlocker()).toBeNull();expect(store.view(sid).memory.addAttempts).toHaveLength(total+2);
 const checkpoint=db.prepare('SELECT projection,projection_hash FROM memory_source_checkpoints').get() as any;expect(memoryHash(checkpoint.projection)).toBe(checkpoint.projection_hash);expect(JSON.parse(checkpoint.projection)).toHaveLength(1000);
},30000);
it('deletes private source checkpoints with the chat while retaining applied memory',()=>{
 const {store,db,sid}=fixture();extract(store);const a=attempt(store);store.receiveMemoryAdd(a.id,links,{});store.acceptMemoryAdd(a.id);store.deleteSession(sid);
 for(const table of ['memory_source_checkpoints','memory_source_batches','memory_source_attempts'])expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
 expect(store.memoryManagement().document.database_records).toHaveLength(2);expect(db.pragma('foreign_key_check')).toEqual([]);
});
it('preserves successful extraction if freezing link batches fails',()=>{
 const {store,db,sid}=fixture();db.exec("CREATE TRIGGER test_batch_fault BEFORE INSERT ON memory_source_batches BEGIN SELECT RAISE(ABORT,'batch fault'); END");
 expect(()=>extract(store)).toThrow('batch fault');expect(store.view(sid).memory.addJobs![0]).toMatchObject({phase:'link',state:'failed',failure:'operation_failed'});
 expect(store.view(sid).memory.addAttempts![0].status).toBe('succeeded');expect(store.currentMemory().revision).toBe(0);
 db.exec('DROP TRIGGER test_batch_fault');store.retryMemoryAdd(sid,store.view(sid).memory.addJobs![0].ordinal);const a=attempt(store);expect(a.phase).toBe('link');store.receiveMemoryAdd(a.id,links,{});store.acceptMemoryAdd(a.id);
 expect(store.view(sid).memory.addAttempts).toHaveLength(2);expect(store.endBlocker()).toBeNull();
});
