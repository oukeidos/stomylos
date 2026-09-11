import { AppFailure } from '../src/main/errors';
import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Store,type StoreMethod} from '../src/main/database';
import {addAndFifo,memoryAddBody} from '../src/main/memory-add';
import {memoryCharacters,renderMemoryBody} from '../src/main/memory-render';
import {memoryHash,memoryJson} from '../src/main/memory-updater';
import {Coordinator} from '../src/main/coordinator';
import type {DatabaseClient} from '../src/main/db-client';
import type {Gateway} from '../src/main/transport';
import type {Json} from '../src/shared/types';
import {validateCommand} from '../src/main/ipc';
const fixtures:{dir:string;store:Store;db:Database.Database}[]=[];
afterEach(()=>{for(const f of fixtures.splice(0)){f.store.close();f.db.close();rmSync(f.dir,{recursive:true,force:true});}});
function fixture(){const dir=mkdtempSync('/tmp/stomylos-add-'),store=new Store(dir,resolve('native/advisory-lock.node')),db=new Database(join(dir,'stomylos.sqlite3'));const f={dir,store,db};fixtures.push(f);return f;}
function session(store:Store){const s=store.createSession();store.searchMode(s.id,'off');store.selectManual(s.id,'model_04');return s;}
function send(store:Store,id:string,text='I like green tea.'){store.submit(id,text);store.commitRoute(id,null,'fixture',null);return store.startChat(store.prepareChat(id,crypto.randomUUID()).id);}
function prepare(store:Store){const j=store.memoryAddReady()!;const a=store.prepareMemoryAdd(j.ordinal,crypto.randomUUID());store.prepareProvider('memory_add',a.id,JSON.parse(a.body),JSON.parse(j.config).identity);store.dispatchMemoryAdd(a.id);return a;}
function finish(store:Store,texts:string[]){const a=prepare(store);store.receiveMemoryAdd(a.id,JSON.stringify({add:texts}),{usage:{cost:0.001}});store.acceptMemoryAdd(a.id);return a;}
it('uses the tested prompt/schema without old memory, counts rendered Unicode and rejects a single oversized note atomically',()=>{
 const body=memoryAddBody({current_user:{content:'Tea.'}});expect(body.messages[0].content).toBe(readFileSync('../experiments/EXP-033-add-only-memory/add-prompt.txt','utf8'));expect(body.max_tokens).toBe(2048);expect(body.reasoning).toEqual({effort:'none',exclude:true});
 const empty={character_id:'shared',revision:0,database_records:[]};
 const first=addAndFifo(empty,JSON.stringify({add:['🙂'.repeat(3998)]}),'m1');expect(memoryCharacters(first.document)).toBe(4000);
 const second=addAndFifo(first.document,JSON.stringify({add:['한글','Again','Again']}),'m2');expect(second.changes.evicted).toEqual(first.document.database_records);expect(second.document.database_records).toHaveLength(3);
 expect(addAndFifo(second.document,'{"add":[]}','m3').document).toEqual(second.document);
 expect(()=>addAndFifo(first.document,JSON.stringify({add:['x'.repeat(3999)]}),'m4')).toThrow('memory_add_item_capacity');expect(memoryCharacters(first.document)).toBe(4000);
});
it('captures only accepted source and preceding delivered reply, waits for dispatch policy, and keeps snapshot/date metadata separate',()=>{
 const {store,db}=fixture(),s=session(store);const starter=store.messages(s.id).at(-1)!;
 store.submit(s.id,'Yes, every Wednesday.','source');store.submit(s.id,'Yes, every Wednesday.','source');expect(store.memoryAddReady()).toBeNull();
 const job=db.prepare('SELECT * FROM memory_add_jobs').get() as Json;expect(JSON.parse(job.input_json)).toMatchObject({previous_assistant:{content:starter.content},current_user:{content:'Yes, every Wednesday.'}});
 store.commitRoute(s.id,null,'fixture',null);const start=store.startChat(store.prepareChat(s.id,'chat').id);const frozen=JSON.parse(start.request.config).memory_context;
 const a=finish(store,['The user swims on Wednesdays.']);store.acceptMemoryAdd(a.id);
 expect(db.prepare('SELECT count(*) FROM memory_add_attempts').pluck().get()).toBe(1);
 expect(store.view(s.id).memory.snapshot).toEqual(frozen);expect(renderMemoryBody(store.currentMemory())).not.toContain(job.created_at);
 expect(db.prepare('SELECT source_message_id,observed_at FROM memory_item_metadata').get()).toEqual({source_message_id:'source',observed_at:job.created_at});
 store.finishReply(start.request.id,start.bubble.id,'How long do you swim?',{});store.submit(s.id,'About forty minutes.');
 const next=db.prepare('SELECT input_json FROM memory_add_jobs ORDER BY ordinal DESC').pluck().get() as string;
 expect(JSON.parse(next).previous_assistant.content).toBe('How long do you swim?');expect(next).not.toContain('The user swims');
 store.end(s.id);expect(store.memoryJob(s.id)).toBeNull();expect(store.endStatus(s.id)?.stages.update).toBe('pending');store.cancelEnd(s.id);expect(store.currentMemory().revision).toBe(1);
});
it('persists response before atomic apply, recovers save-only after restart, preserves FIFO under reversed clocks and manual edits',()=>{
 const f=fixture(),s=session(f.store),start=send(f.store,s.id);const a=prepare(f.store);
 f.store.receiveMemoryAdd(a.id,JSON.stringify({add:['x'.repeat(2100),'y'.repeat(1000)]}),{});
 f.db.exec("CREATE TRIGGER fixture_fail BEFORE UPDATE ON shared_memory BEGIN SELECT RAISE(ABORT,'disk failure'); END;");
 expect(()=>f.store.acceptMemoryAdd(a.id)).toThrow('disk failure');expect(f.db.prepare('SELECT count(*) FROM memory_item_metadata').pluck().get()).toBe(0);f.db.exec('DROP TRIGGER fixture_fail');
 f.store.close();f.store=new Store(f.dir,resolve('native/advisory-lock.node'),undefined,()=>({utc:'2020-01-01T00:00:00.000Z',timezone:'UTC',utc_offset_minutes:0,local_date:'2020-01-01'}));expect(f.store.memoryAddReady()?.state).toBe('received');expect(f.store.prepareMemoryAdd(1,'unused').id).toBe(a.id);f.store.acceptMemoryAdd(a.id);
 // Interrupted chat still needs an explicit reply recovery; complete its stored bubble for this isolated source-order fixture.
 f.db.prepare("UPDATE messages SET delivery='complete',content='And then?' WHERE id=?").run(start.bubble.id);
 f.store.submit(s.id,'A later source.');finish(f.store,['z'.repeat(2000)]);
 const doc=f.store.memoryManagement().document;expect(doc.database_records.map(r=>r.text[0])).toEqual(['y','z']);
 f.store.end(s.id);const row=doc.database_records[0],before=f.db.prepare('SELECT * FROM memory_item_metadata WHERE id=?').get(row.id) as Json;
 const view=f.store.memoryManagement();const edit={id:row.id,text:'Edited detail',revision:doc.revision,hash:view.hash};f.store.commitMemoryEdit(f.store.prepareMemoryEdit(edit));
 expect(f.db.prepare('SELECT * FROM memory_item_metadata WHERE id=?').get(row.id)).toEqual({...before,origin:'manual',edited_at:expect.any(String)});
 const current=f.store.memoryManagement();expect(()=>f.store.prepareMemoryEdit({...edit,text:'x'.repeat(4000),revision:current.document.revision,hash:current.hash})).toThrow('memory_edit_capacity');
 f.store.commitMemoryEdit(f.store.prepareMemoryEdit({...edit,text:null,revision:current.document.revision,hash:current.hash}));expect(f.db.prepare('SELECT 1 FROM memory_item_metadata WHERE id=?').get(row.id)).toBeUndefined();
 f.store.deleteSession(s.id);expect(f.store.memoryManagement().document.database_records).toHaveLength(1);expect(f.db.pragma('foreign_key_check')).toEqual([]);
});
it('does not auto-retry unknown calls, blocks later sources, and rejects stale attempt commits after exact-job retry/skip',()=>{
 const f=fixture(),s=session(f.store),start=send(f.store,s.id);const a=prepare(f.store);expect(f.store.prepareMemoryAdd(a.job_id,a.id).id).toBe(a.id);
 f.store.finishReply(start.request.id,start.bubble.id,'Tell me more.',{});f.store.submit(s.id,'I also like mint tea.');
 f.store.close();f.store=new Store(f.dir,resolve('native/advisory-lock.node'));expect(f.store.memoryAddReady()).toBeNull();
 expect(()=>f.store.retryMemoryAdd(s.id,999)).toThrow('memory_add_not_retryable');f.store.retryMemoryAdd(s.id,a.job_id);const b=prepare(f.store);
 f.store.failMemoryAdd(a.id,'late failure');expect(()=>f.store.receiveMemoryAdd(a.id,'{"add":["Late"]}',{})).toThrow();
 f.store.receiveMemoryAdd(b.id,'{"add":["Fresh"]}',{});f.store.acceptMemoryAdd(b.id);const attempts=f.store.view(s.id).memory.addAttempts!;
 expect(attempts.map(a=>a.id)).toEqual([a.id,b.id]);expect(attempts.map(a=>a.status)).toEqual(['interrupted','succeeded']);expect(attempts[1].model).toBe('openai/gpt-5.6-luna');expect(attempts[1]).not.toHaveProperty('body');expect(attempts[1]).not.toHaveProperty('response_content');
expect(f.store.memoryAddReady()?.ordinal).toBe(2);
 const c=prepare(f.store);f.store.failMemoryAdd(c.id,'bad_output');f.store.skipMemoryAdd(s.id,2);expect(f.store.memoryAddReady()).toBeNull();expect(renderMemoryBody(f.store.currentMemory())).toBe('- Fresh');
});
it('Off cancels waiting and in-flight inputs, On never backfills, and malformed results cannot mutate active memory',()=>{
 const {store,db}=fixture(),s=session(store);const start=send(store,s.id);const a=prepare(store);
 store.setMemoryPreference(false,0);store.receiveMemoryAdd(a.id,'{"add":["Late"]}',{});store.acceptMemoryAdd(a.id);store.setMemoryPreference(true,1);
 expect(store.currentMemory().revision).toBe(0);store.finishReply(start.request.id,start.bubble.id,'More?',{});store.submit(s.id,'Still excluded.');expect(db.prepare('SELECT count(*) FROM memory_add_jobs').pluck().get()).toBe(1);
 store.end(s.id);const s2=session(store);send(store,s2.id);const b=prepare(store);store.receiveMemoryAdd(b.id,'{"update":[]}',{});expect(()=>store.acceptMemoryAdd(b.id)).toThrow('memory_add_format');expect(store.currentMemory().revision).toBe(0);
});
it('validates exact-job IPC and detects metadata membership corruption',()=>{
 for(const name of ['retryMemoryAdd','skipMemoryAdd']){expect(()=>validateCommand(name,{sessionId:'s',jobId:1})).not.toThrow();expect(()=>validateCommand(name,{sessionId:'s',jobId:0})).toThrow();}
 const {store,db}=fixture();db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,source_message_id,source_session_id,observed_at,origin) VALUES('orphan',0,0,NULL,NULL,NULL,'legacy')").run();expect(()=>store.currentMemory()).toThrow('memory_metadata_mismatch');
});
it('runs ADD in parallel with a held reply, sends one request per input, and drains End without Gemini or cleanup',async()=>{
 const f=fixture(),s=session(f.store);let release!:()=>void;const held=new Promise<void>(r=>release=r);const calls:Json[]=[];
 const client={ready:Promise.resolve(),call:async(method:StoreMethod,...args:any[])=>(f.store[method] as Function).apply(f.store,args),close:async()=>f.store.close()} as unknown as DatabaseClient;
 const gateway:Gateway={async complete(body,identity){calls.push(body);expect(identity.allowed_models).toContain(body.model);return {content:'{"add":["Likes tea."]}',metadata:{usage:{cost:0.001}}};},async stream(_body,_signal,chunk){await held;chunk('Tell me more.');return {content:'Tell me more.',metadata:{}};}};
 const c=new Coordinator(client,gateway,{keyPresent:true,keyPath:'',dataPath:f.dir,appVersion:'test',development:true},()=>{},()=>true);
 try{await c.command('sendMessage',{sessionId:s.id,text:'I like tea.',revision:0});await vi.waitFor(()=>expect(f.store.currentMemory().revision).toBe(1));expect(f.store.messages(s.id).at(-1)?.delivery).toBe('streaming');
 release();await vi.waitFor(()=>expect(f.store.messages(s.id).at(-1)?.delivery).toBe('complete'));await c.command('endSession',{sessionId:s.id});expect(f.store.endBlocker()).toBeNull();expect(calls.map(b=>b.model)).toEqual(['openai/gpt-5.6-luna']);
 expect(f.db.prepare('SELECT provider_request FROM memory_add_attempts').pluck().get()).toContain('"allow_fallbacks":true');
 }finally{release();await c.command('close',undefined);}
});

function controller(f:ReturnType<typeof fixture>,gateway:Gateway) {
 const client={ready:Promise.resolve(),call:async(method:StoreMethod,...args:any[])=>(f.store[method] as Function).apply(f.store,args),close:async()=>f.store.close()} as unknown as DatabaseClient;
 return new Coordinator(client,gateway,{keyPresent:true,keyPath:'',dataPath:f.dir,appVersion:'test',development:true},()=>{},()=>true);
}
it.each(['retryMemoryAdd','skipMemoryAdd'] as const)('End %s targets exactly the failed input and drains remaining inputs',async action=>{
 const f=fixture(),s=session(f.store);const first=send(f.store,s.id,'First detail');f.store.finishReply(first.request.id,first.bubble.id,'More?',{});
 f.store.submit(s.id,'Second detail');const second=f.store.startChat(f.store.prepareChat(s.id,'second-chat').id);f.store.finishReply(second.request.id,second.bubble.id,'Thanks.',{});f.store.end(s.id);
 const calls:string[]=[];const c=controller(f,{async complete(body){const source=JSON.parse(body.messages[1].content).current_user.content;calls.push(source);if(calls.length===1)throw new AppFailure('request_timeout');return {content:JSON.stringify({add:[source]}),metadata:{usage:{total_tokens:20,cost:0.001}}};},async stream(){throw new Error('No conversation expected');}});
 try {
  await c.initialize();await vi.waitFor(()=>expect(f.store.view(s.id).memory.addJobs?.[0].state).toBe('failed'));
  expect(calls).toEqual(['First detail']);expect(f.store.endStatus(s.id)?.details.update).toEqual({attempts:1,failure:'request_timeout'});
  const attempt=f.store.view(s.id).memory.addAttempts![0];expect(JSON.parse(attempt.metadata).elapsed_seconds).toBeGreaterThanOrEqual(0);
  const jobId=f.store.view(s.id).memory.addJobs![0].ordinal;
  await c.command(action,{sessionId:s.id,jobId});await vi.waitFor(()=>expect(f.store.endStatus(s.id)?.complete).toBe(true));
  expect(calls).toEqual(action==='retryMemoryAdd'?['First detail','First detail','Second detail']:['First detail','Second detail']);
  expect(f.store.endStatus(s.id)?.details.update).toEqual({attempts:calls.length,failure:null});
  expect(f.store.memoryManagement().document.database_records.map(r=>r.text)).toEqual(action==='retryMemoryAdd'?['First detail','Second detail']:['Second detail']);
 }finally{await c.command('close',undefined);}
});
it('actual coordinator quit interrupts a dispatched ADD, preserves the queued source and makes no unknown-outcome retry after restart',async()=>{
 const f=fixture(),s=session(f.store);let calls=0;
 const gateway:Gateway={async complete(_body,_identity,signal){calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new AppFailure('request_cancelled')),{once:true}));},async stream(_body,_signal,chunk){chunk('More?');return {content:'More?',metadata:{}};}};
 const c=controller(f,gateway);
 await c.command('sendMessage',{sessionId:s.id,text:'First detail',revision:0});
 await vi.waitFor(()=>{expect(calls).toBe(1);expect(f.store.messages(s.id).at(-1)?.delivery).toBe('complete');});
 f.store.submit(s.id,'Second detail');await c.command('close',undefined);
 f.store=new Store(f.dir,resolve('native/advisory-lock.node'));
 expect(f.store.view(s.id).memory.addJobs?.map(j=>j.state)).toEqual(['interrupted','pending']);expect(f.store.currentMemory().revision).toBe(0);
 const resumed=controller(f,{async complete(){calls++;return {content:'{"add":["Second detail"]}',metadata:{}};},async stream(){throw new Error('No reply expected');}});
 try{await resumed.initialize();expect(f.store.memoryAddReady()).toBeNull();expect(calls).toBe(1);
  await resumed.command('skipMemoryAdd',{sessionId:s.id,jobId:f.store.view(s.id).memory.addJobs![0].ordinal});
  await vi.waitFor(()=>expect(f.store.currentMemory().revision).toBe(1));expect(calls).toBe(2);
 }finally{await resumed.command('close',undefined);}
});
it('restart distinguishes an attempt prepared but never dispatched',()=>{
 const f=fixture(),s=session(f.store);send(f.store,s.id);const job=f.store.memoryAddReady()!;f.store.prepareMemoryAdd(job.ordinal,'unsent');
 f.store.close();f.store=new Store(f.dir,resolve('native/advisory-lock.node'));
 expect(f.store.view(s.id).memory.addJobs![0].failure).toBe('queued_not_dispatched');expect(f.store.view(s.id).memory.addAttempts![0].failure).toBe('queued_not_dispatched');
});
it('startup applies a received response without an API key or another provider call',async()=>{
 const f=fixture(),s=session(f.store);send(f.store,s.id);const a=prepare(f.store);f.store.receiveMemoryAdd(a.id,'{"add":["Received before quit"]}',{usage:{cost:0.001}});
 f.store.close();f.store=new Store(f.dir,resolve('native/advisory-lock.node'));
 const complete=vi.fn(async()=>{throw new Error('Unexpected paid call');});
 const client={ready:Promise.resolve(),call:async(method:StoreMethod,...args:any[])=>(f.store[method] as Function).apply(f.store,args),close:async()=>f.store.close()} as unknown as DatabaseClient;
 const c=new Coordinator(client,{complete,async stream(){throw new Error('No reply expected');}},{keyPresent:false,keyPath:'',dataPath:f.dir,appVersion:'test',development:true},()=>{},()=>true);
 try{await c.initialize();await vi.waitFor(()=>expect(f.store.currentMemory().revision).toBe(1));expect(complete).not.toHaveBeenCalled();expect(f.store.view(s.id).memory.addAttempts).toHaveLength(1);}finally{await c.command('close',undefined);}
});
it('End cancel preserves earlier committed notes and suppresses a late in-flight result',async()=>{
 const f=fixture(),s=session(f.store),first=send(f.store,s.id,'First');finish(f.store,['Already committed']);f.store.finishReply(first.request.id,first.bubble.id,'More?',{});
 f.store.submit(s.id,'Second');let release!:(value:{content:string;metadata:Json})=>void;let entered=false;
 const c=controller(f,{async complete(){entered=true;return new Promise(resolve=>release=resolve);},async stream(){throw new Error('No reply expected');}});
 try{await c.initialize();await vi.waitFor(()=>expect(entered).toBe(true));await c.command('endSession',{sessionId:s.id});await c.command('cancelEnd',{sessionId:s.id});
  release({content:'{"add":["Late note"]}',metadata:{}});await vi.waitFor(()=>expect(f.store.view(s.id).memory.addAttempts?.at(-1)?.status).toBe('cancelled'));
  expect(f.store.endStatus(s.id)?.complete).toBe(true);expect(f.store.memoryManagement().document.database_records.map(r=>r.text)).toEqual(['Already committed']);
 }finally{release?.({content:'{"add":[]}',metadata:{}});await c.command('close',undefined);}
});
