import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {jevPacket,jevQuestion,jevPolicy,jevHash,jevVersion,jevModel,jevScores,jevSelection,type JevSnapshot} from '../src/main/associative-jev';
import {validateAssociative,selectAssociative} from '../src/main/associative-recall';
import {coldFixture} from './cold-memory-fixtures';
import {ColdMemoryStore,coldHash} from '../src/main/cold-memory-store';
import {characters} from '../src/main/contracts';
import {Coordinator} from '../src/main/coordinator';
import type {DatabaseClient} from '../src/main/db-client';
import type {Store,StoreMethod} from '../src/main/database';
import type {Gateway} from '../src/main/transport';
const fs:ReturnType<typeof coldFixture>[]=[];
afterEach(()=>{for(const f of fs.splice(0))f.close();vi.restoreAllMocks();});
const vector=Array.from({length:384},(_,i)=>i===0?1:0);
function setup(){const f=coldFixture();fs.push(f);f.store.coldInitialize();const s=f.store.createSession();
 for(let i=0;i<22;i++){
  const id='r'+i;f.db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin) VALUES(?,?,0,'legacy')").run(id,i);
  if(i===21)f.db.prepare('UPDATE memory_item_metadata SET source_session_id=? WHERE id=?').run(s.id,id);
  f.db.transaction(()=>new ColdMemoryStore(f.db).archive([{id,text:'Historical synthetic fact '+i}]))();
  f.db.prepare('DELETE FROM memory_item_metadata WHERE id=?').run(id);
 }
 f.store.associativeTick();let job;
 while((job=f.store.associativeClaim()))f.store.associativeComplete(job,{vector,inputHash:coldHash(job.text),chunkCount:1});
 f.store.searchMode(s.id,'off');f.store.selectManual(s.id,characters[0].id);
 const u=f.store.submit(s.id,'Tell me about my interests.');f.store.commitRoute(s.id,null,'fixture',null);
 return {...f,s,u};}
function begin(f:ReturnType<typeof setup>){const a=f.store.jevBegin(f.s.id,f.u.id,Date.now()+10000);const p=f.store.jevPrepare(a.id,vector);return {a,p};}
function answer(body:any,value=.6){return {model:jevModel+'-20260917',provider:'TypeSafe',usage:{cost:.0001},answers:Object.fromEntries(Object.keys(body.questions).map(k=>[k,{type:'noul',noul:value}]))};}
function launch(f:ReturnType<typeof setup>){const {a,p}=begin(f);const routed=f.store.prepareProvider('associative',a.id,p.body,null);expect(routed.endpoint).toBe('decisions');f.store.jevDispatch(a.id);return {a,p};}
it('retains exact integrated prompt and keeps aliases independent of retrieval order',()=>{
 expect(jevQuestion).toEqual(JSON.parse(readFileSync('tests/fixtures/jev-question-v1.json','utf8')));
 const candidates=[{id:'r',text:'Text',text_hash:coldHash('Text'),source_order:1,cosine:.1}];
 const p=jevPacket('m','yes',null,['Available'],candidates);expect(p.body.state).toEqual({current_user:'yes',previous_assistant:null,already_available_records:['Available'],candidate_records:{c01:'Text'}});
 expect(()=>jevPacket('m','x'.repeat(32000),null,[],candidates)).toThrow('associative_input_limit');
});
it('uses the inclusive Noul boundary instead of a cosine floor, validates and packs Unicode whole records',()=>{
 const candidates=Array.from({length:7},(_,i)=>({id:String(i),text:String(i)+'🙂'.repeat(220),text_hash:coldHash(String(i)+'🙂'.repeat(220)),source_order:i,cosine:.1}));
 const packet=jevPacket('m','Current',null,[],candidates);const snapshot:JevSnapshot={sessionId:'s',messageId:'m',contextHash:jevHash('context'),revision:0,candidates,...packet};
 const scores=jevScores(answer(packet.body),Object.keys(packet.mapping));const selected=jevSelection(snapshot,scores,'a');validateAssociative(selected);expect(selected.items).toHaveLength(5);expect(Array.from(selected.block).length).toBeLessThanOrEqual(1500);
 expect(jevSelection(snapshot,Object.fromEntries(Object.keys(scores).map(k=>[k,.599])),'a').items).toEqual([]);
 for(const raw of [{...answer(packet.body),model:'unknown'},{...answer(packet.body),answers:{}},{...answer(packet.body),answers:{c01:{type:'noul',noul:NaN}}}])expect(()=>jevScores(raw,Object.keys(scores))).toThrow();
});
it('freezes at most 20 eligible records, accounts attempts, injects only the final user and reuses retry selection',()=>{
 const f=setup();expect(JSON.parse(f.store.session(f.s.id).chat_config)).toMatchObject({associative_context_version:jevVersion,associative_policy:jevPolicy});
 const {a,p}=launch(f);expect(p.count).toBeGreaterThan(0);expect(p.count).toBeLessThanOrEqual(20);
 const selected=f.store.jevFinish(a.id,answer(p.body),null)!;expect(selected.threshold).toBe(.6);
 const prepared=f.store.prepareChat(f.s.id,randomUUID(),'send',selected);const body=f.store.chatBody(prepared.id);expect(body.messages.at(-1).content).toBe(f.u.content+selected.block);expect(f.store.messages(f.s.id).find(m=>m.id===f.u.id)?.content).toBe(f.u.content);
 f.store.failRequest(prepared.id,'synthetic',null,{});
 const retry=f.store.prepareChat(f.s.id,randomUUID(),'retry');expect(JSON.parse(retry.config).associative_recall).toEqual(JSON.parse(prepared.config).associative_recall);
 expect(f.store.jevBegin(f.s.id,f.u.id,Date.now()+10000)).toMatchObject({id:a.id,reused:true});
});
it('filters supplied IDs/text, same-session records and revoked sources before top20',()=>{
 const f=setup();const initial=f.store.jevBegin(f.s.id,f.u.id,Date.now()+10000);const context=JSON.parse(f.db.prepare('SELECT snapshot FROM associative_attempts WHERE id=?').pluck().get(initial.id) as string);

 const p=f.store.jevPrepare(initial.id,vector);const snapshot=JSON.parse(f.db.prepare('SELECT snapshot FROM associative_attempts WHERE id=?').pluck().get(initial.id) as string);
 expect(snapshot.candidates.some((r:any)=>r.id==='r21')).toBe(false);
 const texts=p.body.state.already_available_records;expect(snapshot.candidates.every((r:any)=>!texts.includes(r.text))).toBe(true);expect(context.contextHash).toBe(snapshot.contextHash);
});
it('does not redispatch failed or interrupted attempts and preserves old session policy',()=>{
 const f=setup();const {a}=begin(f);f.store.jevFinish(a.id,null,'synthetic');expect(f.store.jevBegin(f.s.id,f.u.id,Date.now()+10000)).toMatchObject({reused:true,selection:null});
 const config=JSON.parse(f.store.session(f.s.id).chat_config);delete config.associative_policy;config.associative_context_version='stomylos_associative_recall_v1';f.db.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(config),f.s.id);
 expect(f.store.associativeInput(f.s.id,f.u.id)?.version).toBe('stomylos_associative_recall_v1');expect(()=>f.store.jevBegin(f.s.id,f.u.id,Date.now()+10000)).toThrow('associative_inactive');
 const legacy=selectAssociative([{id:'q',vector:[1]}],[{id:'r',text:'Old',text_hash:coldHash('Old'),source_order:1,vector:[.8]}],0);validateAssociative(legacy);expect(legacy.threshold).toBe(.78);
});
it('checks deadline, memory permission and source edits before accepting or dispatching',()=>{
 const f=setup();expect(()=>f.store.jevBegin(f.s.id,f.u.id,Date.now()-1)).toThrow('associative_timeout');
 const {a,p}=launch(f);f.db.prepare('UPDATE associative_attempts SET deadline=0 WHERE id=?').run(a.id);expect(()=>f.store.jevFinish(a.id,answer(p.body),null)).toThrow('associative_timeout');
});
it('rejects Memory Off before Jev dispatch and after a response',()=>{
 const f=setup();const {a,p}=begin(f);f.store.prepareProvider('associative',a.id,p.body,null);const pref=f.store.memoryPreference();f.store.setMemoryPreference(false,pref.revision);
 expect(()=>f.store.jevDispatch(a.id)).toThrow('associative_inactive');expect(()=>f.store.jevFinish(a.id,answer(p.body),null)).toThrow('associative_inactive');
});
it('recovers queued attempts as interrupted without changing session snapshots',()=>{
 const f=setup();const {a}=begin(f);const before=f.store.session(f.s.id).chat_config;f.reopen();
 expect(f.db.prepare('SELECT chat_config FROM sessions WHERE id=?').pluck().get(f.s.id)).toBe(before);
 expect(f.db.prepare('SELECT status FROM associative_attempts WHERE id=?').pluck().get(a.id)).toBe('interrupted');
});
function controller(f:ReturnType<typeof setup>,gateway:Gateway){const client={call:async(method:StoreMethod,...args:any[])=>(f.store[method] as any).apply(f.store,args)} as DatabaseClient;
 const c=new Coordinator(client,gateway,{keyPresent:true,keyPath:'',dataPath:f.directory,appVersion:'test',development:true},()=>{},()=>true);
 c.cold={query:async()=>vector} as any;return c;}
it('coordinator runs one decision and reuses the result without a second call',async()=>{
 const f=setup(),decisions=vi.fn(async(body:any)=>answer(body));const c=controller(f,{decisions,complete:vi.fn(),stream:vi.fn()});
 const first=await (c as any).recallFromInput(f.s.id,f.u.id,new AbortController().signal);expect(first?.version).toBe(jevVersion);
 await (c as any).recallFromInput(f.s.id,f.u.id,new AbortController().signal);expect(decisions).toHaveBeenCalledTimes(1);
});
it('coordinator returns without recall on failure, and on cancellation ignores a late result',async()=>{
 const f=setup();let resolve!:(v:any)=>void;const decisions=vi.fn((_body:any)=>new Promise<any>(r=>resolve=r));const c=controller(f,{decisions,complete:vi.fn(),stream:vi.fn()});const abort=new AbortController();
 const pending=(c as any).recallFromInput(f.s.id,f.u.id,abort.signal);await vi.waitFor(()=>expect(decisions).toHaveBeenCalledTimes(1));abort.abort();expect(await pending).toBeNull();resolve(answer(decisions.mock.calls[0][0]));await new Promise(r=>setTimeout(r,20));
 expect(f.db.prepare('SELECT selection FROM associative_attempts').pluck().get()).toBeNull();
});
it('shares the 1500 ms deadline with embedding and never attaches a late result',async()=>{
 const f=setup();let resolve!:(v:any)=>void;const decisions=vi.fn((_body:any,_signal:AbortSignal,_timeout:number)=>new Promise<any>(r=>resolve=r));const c=controller(f,{decisions,complete:vi.fn(),stream:vi.fn()});
 c.cold={query:async()=>{await new Promise(r=>setTimeout(r,800));return vector;}} as any;
 const start=performance.now();const selected=await (c as any).recallFromInput(f.s.id,f.u.id,new AbortController().signal);
 expect(selected).toBeNull();expect(performance.now()-start).toBeLessThan(1900);expect(decisions.mock.calls[0][2]).toBeLessThan(750);
 resolve(answer(decisions.mock.calls[0][0]));await new Promise(r=>setTimeout(r,20));expect(f.db.prepare('SELECT selection FROM associative_attempts').pluck().get()).toBeNull();
});
it('skips Jev for no eligible records and preserves a terminal empty selection on retry',async()=>{
 const f=setup();f.db.prepare("UPDATE associative_embeddings SET state='pending'").run();const decisions=vi.fn();const c=controller(f,{decisions,complete:vi.fn(),stream:vi.fn()});
 const selected=await (c as any).recallFromInput(f.s.id,f.u.id,new AbortController().signal);expect(selected).toMatchObject({items:[],reason:'empty'});expect(decisions).not.toHaveBeenCalled();
});
it('failed Jev continues chat without a recall block and is not rescored',async()=>{
 const f=setup();const decisions=vi.fn(async()=>{throw new Error('synthetic HTTP failure');});const c=controller(f,{decisions,complete:vi.fn(),stream:vi.fn()});
 expect(await (c as any).recallFromInput(f.s.id,f.u.id,new AbortController().signal)).toBeNull();
 const request=f.store.prepareChat(f.s.id,randomUUID());expect(f.store.chatBody(request.id).messages.at(-1).content).toBe(f.u.content);
 expect(await (c as any).recallFromInput(f.s.id,f.u.id,new AbortController().signal)).toBeNull();expect(decisions).toHaveBeenCalledTimes(1);
});
it('rejects revoked candidate evidence before dispatch, acceptance and final chat transmission',()=>{
 const f=setup();const {a,p}=launch(f);const selected=f.store.jevFinish(a.id,answer(p.body),null)!;
 const prepared=f.store.prepareChat(f.s.id,randomUUID(),'send',selected);
 const id=selected.items[0].id;f.db.transaction(()=>new ColdMemoryStore(f.db).revoke(id))();
 const started=f.store.startChat(prepared.id);expect(started.body.messages.at(-1).content).toBe(f.u.content);expect(JSON.parse(started.request.config).associative_recall).toBeUndefined();
});

it.each(['dispatch','accept'])('rejects a candidate revoked before %s',stage=>{
 const f=setup();const {a,p}=begin(f);f.store.prepareProvider('associative',a.id,p.body,null);
 if(stage==='accept')f.store.jevDispatch(a.id);
 const snapshot=JSON.parse(f.db.prepare('SELECT snapshot FROM associative_attempts WHERE id=?').pluck().get(a.id) as string);
 f.db.transaction(()=>new ColdMemoryStore(f.db).revoke(snapshot.candidates[0].id))();
 expect(()=>stage==='dispatch'?f.store.jevDispatch(a.id):f.store.jevFinish(a.id,answer(p.body),null)).toThrow('associative_stale');
});

it('keeps a dispatched retry exact and refuses retransmitting revoked recall',()=>{
 const f=setup();const {a,p}=launch(f);const selected=f.store.jevFinish(a.id,answer(p.body),null)!;
 const first=f.store.startChat(f.store.prepareChat(f.s.id,randomUUID(),'send',selected).id);f.store.failRequest(first.request.id,'synthetic');
 const retry=f.store.prepareChat(f.s.id,randomUUID(),'retry');expect(JSON.parse(retry.config).associative_recall).toEqual(selected);
 f.db.transaction(()=>new ColdMemoryStore(f.db).revoke(selected.items[0].id))();expect(()=>f.store.startChat(retry.id)).toThrow('memory_retry_revoked');
});

it('never attaches a result delivered after the preparation race has expired',async()=>{
 const f=setup(),decisions=vi.fn(async(body:any)=>answer(body));const c=controller(f,{decisions,complete:vi.fn(),stream:vi.fn()});
 const original=(c as any).db.call.bind((c as any).db);let accepted!:()=>void;const committed=new Promise<void>(r=>accepted=r);
 (c as any).db.call=async(method:StoreMethod,...args:any[])=>{const result=await original(method,...args);if(method==='jevFinish' && args[1]){accepted();await new Promise(r=>setTimeout(r,100));}return result;};
 const abort=new AbortController();const pending=(c as any).recallFromInput(f.s.id,f.u.id,abort.signal);await committed;abort.abort();expect(await pending).toBeNull();
 await new Promise(r=>setTimeout(r,120));const request=f.store.prepareChat(f.s.id,randomUUID(),'send');expect(JSON.parse(request.config).associative_recall).toBeUndefined();
 expect(f.db.prepare('SELECT selection FROM associative_attempts').pluck().get()).toBeNull();
});
