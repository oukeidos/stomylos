import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Store,type StoreMethod} from '../src/main/database';
import {sessionMemoryAddBody,validateSessionMemorySize} from '../src/main/memory-add';
import {memoryHash} from '../src/main/memory-updater';
import {Coordinator} from '../src/main/coordinator';
import type {DatabaseClient} from '../src/main/db-client';
import type {Gateway} from '../src/main/transport';
import type {Json} from '../src/shared/types';
import {MemoryInputRecovery} from '../src/renderer/memory-input-recovery';
import {MemoryChangeHistory} from '../src/renderer/memory-changes';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const fixtures:{dir:string;store:Store;db:Database.Database}[]=[];
afterEach(()=>{for(const f of fixtures.splice(0)){f.store.close();f.db.close();rmSync(f.dir,{recursive:true,force:true});}});
function fixture(){const dir=mkdtempSync('/tmp/stomylos-session-add-'),store=new Store(dir,resolve('native/advisory-lock.node')),db=new Database(join(dir,'stomylos.sqlite3'));const f={dir,store,db};fixtures.push(f);return f;}
function session(store:Store){const s=store.createSession();store.searchMode(s.id,'off');store.selectManual(s.id,'model_01');return s;}
function send(store:Store,id:string,text='I like green tea.'){store.submit(id,text);store.commitRoute(id,null,'fixture',null);return store.startChat(store.prepareChat(id,crypto.randomUUID()).id);}
function prepare(store:Store){const j=store.memoryAddReady()!;const a=store.prepareMemoryAdd(j.ordinal,crypto.randomUUID());const effective=store.prepareProvider('memory_add',a.id,JSON.parse(a.body),(a.phase==='link'?JSON.parse(j.config).linker:JSON.parse(j.config)).identity);expect(effective.body.max_tokens).toBe(a.phase==='link'?4096:128000);store.dispatchMemoryAdd(a.id);return a;}
function controller(f:ReturnType<typeof fixture>,gateway:Gateway,keyPresent=true) {
 const client={ready:Promise.resolve(),call:async(method:StoreMethod,...args:any[])=>(f.store[method] as Function).apply(f.store,args),close:async()=>f.store.close()} as unknown as DatabaseClient;
 return new Coordinator(client,gateway,{keyPresent,keyPath:'',dataPath:f.dir,appVersion:'test',development:true},()=>{},()=>true);
}
it('freezes the complete displayed session only at End with no dates and session provenance',()=>{
 const {store,db}=fixture(),s=session(store),r=send(store,s.id,'I arrived on September 1.');
 expect(store.memoryAddReady()).toBeNull();expect(store.view(s.id).memory.addJobs).toEqual([]);
 store.finishReply(r.request.id,r.bubble.id,'Was it pleasant?',{});
 store.submit(s.id,'Yes, I liked it.');const second=store.startChat(store.prepareChat(s.id,'second').id);
 store.finishReply(second.request.id,second.bubble.id,'Glad to hear it.',{});
 store.end(s.id);store.end(s.id);
 const job=store.memoryAddReady()!;expect(job.source_kind).toBe('session');expect(store.endBlocker()).toBe(s.id);
 expect(db.prepare('SELECT COUNT(*) FROM memory_add_jobs').pluck().get()).toBe(1);
 const expected={conversation:[{role:'user',content:'I arrived on September 1.'},{role:'assistant',content:'Was it pleasant?'},{role:'user',content:'Yes, I liked it.'},{role:'assistant',content:'Glad to hear it.'}]};
 expect(JSON.parse(job.input_json)).toEqual(expected);
 const cfg=JSON.parse(job.config);expect(cfg.timeout_ms).toBe(180000);expect(cfg.body).toEqual(sessionMemoryAddBody(expected));
 expect(cfg.body).toMatchObject({model:'openai/gpt-5.6-terra',max_tokens:128000,reasoning:{effort:'medium',exclude:true}});
 expect(cfg.source_manifest_hash).toBe(memoryHash(job.source_manifest));
 expect(cfg.body.messages[0].content).toBe(readFileSync('src/main/session-memory-add-prompt.txt','utf8'));
 const a=prepare(store);store.receiveMemoryAdd(a.id,'{"add":["The user enjoyed the visit."]}',{});store.acceptMemoryAdd(a.id);store.acceptMemoryAdd(a.id);
 const link=prepare(store);expect(link.phase).toBe('link');store.receiveMemoryAdd(link.id,'{"sources":[{"id":1,"ids":[1,3]}]}',{});store.acceptMemoryAdd(link.id);
 const m=db.prepare('SELECT * FROM memory_item_metadata').get() as Json;
 expect(m).toMatchObject({source_message_id:null,source_session_id:s.id,source_order:job.ordinal,item_index:0});
 expect(m.observed_at).toBe(db.prepare('SELECT sent_at_utc FROM message_times WHERE message_id=?').pluck().get(job.message_id));
 expect(store.currentMemory().revision).toBe(1);expect(store.endBlocker()).toBeNull();
 expect(store.requestHistory(s.id).find(a=>a.kind==='Memory update · Session')?.messageId).toBeUndefined();
 expect(store.requestHistory(s.id).filter(a=>a.kind.includes('Memory')).map(a=>a.kind)).toEqual(['Memory update · Session','Memory source linking · Session']);
});
it('omits interrupted replies and drafts while retaining the user turn whose reply failed',()=>{
 const {store}=fixture(),s=session(store),r=send(store,s.id);store.finishReply(r.request.id,r.bubble.id,'Earlier reply',{});
 store.submit(s.id,'I am still here.');store.startChat(store.prepareChat(s.id,'partial').id);store.end(s.id,'Unsent private draft');
 const wire=JSON.parse(store.memoryAddReady()!.input_json);
 expect(wire.conversation).toEqual([{role:'user',content:'I like green tea.'},{role:'assistant',content:'Earlier reply'},{role:'user',content:'I am still here.'}]);
});
it.each(['undispatched','off','excluded','empty'])('does not backfill %s sessions',kind=>{
 const {store,db}=fixture();if(kind==='off')store.setMemoryPreference(false,0);
 const s=session(store);
 if(kind==='undispatched')store.submit(s.id,'Unsent to provider');
 else if(kind!=='empty'){const r=send(store,s.id);store.finishReply(r.request.id,r.bubble.id,'Thanks',{});if(kind==='excluded'){store.setMemoryPreference(false,0);store.setMemoryPreference(true,1);}}
 store.end(s.id);expect(db.prepare('SELECT count(*) FROM memory_add_jobs').pluck().get()).toBe(0);expect(store.endBlocker()).toBeNull();
});
it('resumes received results without redispatch and archives every overflowing record with session provenance',async()=>{
 const f=fixture(),s=session(f.store),r=send(f.store,s.id);f.store.finishReply(r.request.id,r.bubble.id,'Thanks',{});f.store.end(s.id);
 const a=prepare(f.store);f.store.receiveMemoryAdd(a.id,JSON.stringify({add:['a'.repeat(2998),'b'.repeat(2998),'Newest']}),{});f.store.acceptMemoryAdd(a.id);
 const link=prepare(f.store);f.store.receiveMemoryAdd(link.id,'{"sources":[{"id":1,"ids":[1]},{"id":2,"ids":[1]},{"id":3,"ids":[1]}]}',{});
 f.store.close();f.store=new Store(f.dir,resolve('native/advisory-lock.node'));
 const complete=vi.fn(async()=>{throw Error('No inference');});const c=controller(f,{complete,async stream(){throw Error('No chat');}},false);
 try{await c.initialize();await vi.waitFor(()=>expect(f.store.endBlocker()).toBeNull());expect(complete).not.toHaveBeenCalled();
 expect(f.store.memoryManagement().document.database_records.map(r=>r.text)).toEqual(['Newest']);
 expect(f.db.prepare('SELECT source_message_id,source_session_id FROM cold_memories').all()).toEqual([{source_message_id:null,source_session_id:s.id},{source_message_id:null,source_session_id:s.id}]);
 }finally{await c.command('close',undefined);}
});
it('does not infer during Send; End blocks until Terra extraction and Luna linking are saved',async()=>{
 const f=fixture(),s=session(f.store);let release!:(v:any)=>void;const calls:Json[]=[];
 const c=controller(f,{async complete(body){calls.push(body);return new Promise(resolve=>release=resolve);},async stream(){return {content:'Thanks.',metadata:{}};}});
 try{await c.command('sendMessage',{sessionId:s.id,text:'I like tea.',revision:0});await vi.waitFor(()=>expect(f.store.messages(s.id).at(-1)).toMatchObject({role:'assistant',delivery:'complete'}));
 expect(calls).toEqual([]);await c.command('endSession',{sessionId:s.id});await vi.waitFor(()=>expect(calls).toHaveLength(1));expect(f.store.endBlocker()).toBe(s.id);
 release({content:'{"add":["The user likes tea."]}',metadata:{}});await vi.waitFor(()=>expect(calls).toHaveLength(2));expect(calls[1].model).toBe('openai/gpt-5.6-luna');expect(f.store.endBlocker()).toBe(s.id);release({content:'{"sources":[{"id":1,"ids":[1]}]}',metadata:{}});await vi.waitFor(()=>expect(f.store.endBlocker()).toBeNull());expect(calls[0].max_tokens).toBe(128000);
 }finally{release?.({content:'{"add":[]}',metadata:{}});await c.command('close',undefined);}
});
it('keeps active chats active on restart, makes unknown outcomes explicit, and retries the exact session',()=>{
 const f=fixture(),s=session(f.store),r=send(f.store,s.id);f.store.finishReply(r.request.id,r.bubble.id,'Thanks',{});
 f.store.close();f.store=new Store(f.dir,resolve('native/advisory-lock.node'));expect(f.store.session(s.id).state).toBe('active');expect(f.store.memoryAddReady()).toBeNull();
 f.store.end(s.id);const a=prepare(f.store);f.store.close();f.store=new Store(f.dir,resolve('native/advisory-lock.node'));
 expect(f.store.memoryAddReady()).toBeNull();const j=f.store.view(s.id).memory.addJobs![0];expect(j.failure).toBe('interrupted_unknown_outcome');
 f.store.retryMemoryAdd(s.id,j.ordinal);const b=prepare(f.store);expect(b.body).toBe(a.body);f.store.receiveMemoryAdd(b.id,'{"add":[]}',{});f.store.acceptMemoryAdd(b.id);expect(f.store.endBlocker()).toBeNull();
});
it('cancellation preserves the saved conversation and suppresses late results',()=>{
 const {store}=fixture(),s=session(store),r=send(store,s.id);store.finishReply(r.request.id,r.bubble.id,'Thanks',{});store.end(s.id);const a=prepare(store);
 store.cancelEnd(s.id);store.receiveMemoryAdd(a.id,'{"add":["Late"]}',{});store.acceptMemoryAdd(a.id);
 expect(store.session(s.id).state).toBe('ended');expect(store.messages(s.id)).toHaveLength(2);expect(store.currentMemory().revision).toBe(0);expect(store.endBlocker()).toBeNull();
});
it('uses session recovery labels and bounds the full request without truncation',()=>{
 const job={ordinal:1,source_kind:'session',state:'failed',input_number:4};
 const html=renderToStaticMarkup(createElement(MemoryInputRecovery,{jobs:[job],disabled:false,onAction(){}}));expect(html).toContain('Retry session memories');expect(html).not.toContain('Input 4');
 const f=fixture(),s=session(f.store);const memory={...f.store.view(s.id).memory,addJobs:[job]};expect(renderToStaticMarkup(createElement(MemoryChangeHistory,{memory,ended:true}))).toContain('Session memory');
 const body=sessionMemoryAddBody({conversation:[{role:'user',content:'a'.repeat(1050000)}]});expect(()=>validateSessionMemorySize(body)).toThrow('memory_add_input_limit');expect(body.messages[1].content.length).toBeGreaterThan(1050000);
 expect(()=>validateSessionMemorySize(sessionMemoryAddBody({conversation:[]}))).not.toThrow();
});

it.each([true,false])('uses only the visible generated opening (visible=%s), excluding hidden generation seeds',visible=>{
 const {store}=fixture(),s=session(store);const a=store.prepareOpener(s.id,'opener',store.session(s.id).opening_revision)!;
 store.dispatchOpener(a.id);store.receiveOpener(a.id,'I tried making bread today.',{});store.acceptOpener(a.id);
 if(!visible)store.setOpening(s.id,'hide',store.session(s.id).opening_revision,'user');
 const r=send(store,s.id,'I prefer rice.');store.finishReply(r.request.id,r.bubble.id,'What kind?',{});store.end(s.id);
 const conversation=JSON.parse(store.memoryAddReady()!.input_json).conversation;
 expect(conversation).toEqual([...(visible?[{role:'assistant',content:'I tried making bread today.'}]:[]),{role:'user',content:'I prefer rice.'},{role:'assistant',content:'What kind?'}]);
});
it('rolls back a save failure and applies the received response once without another attempt',()=>{
 const {store,db}=fixture(),s=session(store),r=send(store,s.id);store.finishReply(r.request.id,r.bubble.id,'Thanks',{});store.end(s.id);const a=prepare(store);
 store.receiveMemoryAdd(a.id,'{"add":["The user likes tea."]}',{});store.acceptMemoryAdd(a.id);const link=prepare(store);store.receiveMemoryAdd(link.id,'{"sources":[{"id":1,"ids":[1]}]}',{});
 db.exec("CREATE TRIGGER test_save_fault BEFORE UPDATE ON shared_memory BEGIN SELECT RAISE(ABORT,'test save fault'); END");
 expect(()=>store.acceptMemoryAdd(link.id)).toThrow('test save fault');expect(store.currentMemory().revision).toBe(0);expect(store.view(s.id).memory.addJobs![0].state).toBe('received');
 db.exec('DROP TRIGGER test_save_fault');store.acceptMemoryAdd(link.id);expect(store.currentMemory().revision).toBe(1);expect(store.view(s.id).memory.addAttempts).toHaveLength(2);
});
it('reports oversized input before provider dispatch and allows explicit skip',async()=>{
 const f=fixture(),s=session(f.store),r=send(f.store,s.id,'a'.repeat(5000));f.store.finishReply(r.request.id,r.bubble.id,'Thanks',{});f.store.end(s.id);
 const job=f.store.memoryAddReady()!,a=f.store.prepareMemoryAdd(job.ordinal,'too-big');
 // A real serialized request bound is tested above; exercise the durable pre-dispatch failure path here.
 f.store.failMemoryAdd(a.id,'memory_add_input_limit');expect(f.store.view(s.id).memory.addJobs![0].failure).toBe('memory_add_input_limit');
 f.store.skipMemoryAdd(s.id,job.ordinal);expect(f.store.endBlocker()).toBeNull();expect(f.store.currentMemory().revision).toBe(0);
});
it('queries the exact user input with local embeddings and freezes recall into the reply without an ADD',async()=>{
 const f=fixture(),s=session(f.store);f.store.coldInitialize();
 const {ColdMemoryStore}=await import('../src/main/cold-memory-store');
 f.db.transaction(()=>{
  f.db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin) VALUES('old',0,0,'legacy')").run();
  new ColdMemoryStore(f.db).archive([{id:'old',text:'The user enjoys hiking.'}]);f.db.prepare("DELETE FROM memory_item_metadata WHERE id='old'").run();
 })();
 f.store.associativeTick();const job=f.store.associativeClaim()!,vector=Array.from({length:384},(_,i)=>i===0?1:0);
 f.store.associativeComplete(job,{vector,inputHash:memoryHash(job.text),chunkCount:1});
 const query=vi.fn(async(_text:string,_signal:AbortSignal)=>vector),complete=vi.fn(async()=>{throw Error('No ADD before End');});const bodies:Json[]=[];
 const c=controller(f,{complete,async stream(body){bodies.push(body);return {content:'Which trail?',metadata:{}};}});
 c.cold={query,async close(){},async preferenceChanged(){},wake(){}} as unknown as NonNullable<Coordinator['cold']>;
 try{await c.command('sendMessage',{sessionId:s.id,text:'I want to hike tomorrow.\nCan we discuss it?',revision:0});
  await vi.waitFor(()=>expect(bodies).toHaveLength(1));expect(query.mock.calls[0][0]).toBe('I want to hike tomorrow.\nCan we discuss it?');expect(complete).not.toHaveBeenCalled();
  const request=f.store.requests(s.id).find(r=>r.role==='chat')!;const saved=JSON.parse(request.config).associative_recall;
  expect(saved).toMatchObject({query_source:'user_input',query_ids:[f.store.messages(s.id)[0].id],items:[{id:'old'}]});
  expect(JSON.stringify(bodies[0])).toContain('The user enjoys hiking.');expect(f.store.view(s.id).memory.addJobs).toEqual([]);
 }finally{await c.command('close',undefined);}
});
