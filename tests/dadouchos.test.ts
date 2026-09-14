import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { dadouchosBody, dadouchosSource, parseDadouchos } from '../src/main/dadouchos';
import { DadouchosController } from '../src/main/dadouchos-controller';
import { validateCommand } from '../src/main/ipc';
import { Store, type StoreMethod } from '../src/main/database';
import { Coordinator } from '../src/main/coordinator';
import { CompletionFailure, OpenRouter, type Gateway } from '../src/main/transport';
import { UsageStore } from '../src/main/usage-store';
import type { DatabaseClient } from '../src/main/db-client';
import type { SessionView, Message, Json } from '../src/shared/types';
const cleanups: (()=>void)[]=[];
afterEach(()=>{cleanups.splice(0).forEach(f=>f());vi.unstubAllGlobals();});
function view(count=4):SessionView {
 const messages:Message[]=[{id:'opener',session_id:'s',sequence:0,origin:'starter',role:'assistant',content:'An unrelated opener',delivery:'complete',request_id:null}];
 for(let i=1;i<=count;i++)for(const role of ['user','assistant'] as const)messages.push({id:`${role}${i}`,session_id:'s',sequence:messages.length,role,origin:role==='user'?'learner':'model',content:role==='user'?`User ${i} é`:`Partner ${i}`,delivery:'complete',request_id:null});
 return {session:{id:'s',state:'active',draft:'PRIVATE DRAFT'},partner:{revision:0,pending:null},messages,memory:{text:'PRIVATE MEMORY'}} as unknown as SessionView;
}
it('preserves prompt/wrapper and latest 1/2/3 exchanges without draft, memory or opening',()=>{
 for(const count of [1,2,3,4]){
  const v=view(count),source=dadouchosSource(v),body=dadouchosBody(source);
  expect(source.messages).toEqual(v.messages.slice(-Math.min(count,3)*2).map(({role,content})=>({role,content})));
  expect(body.messages[0].content).toBe(readFileSync('tests/fixtures/dadouchos-prompt-v1.txt','utf8'));
  expect(body.messages[1].content).toBe('Recent conversation (JSON data):\n'+JSON.stringify(source.messages));
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE|unrelated|opener/);
  expect(body.reasoning).toEqual({enabled:false,exclude:true});expect(body.max_tokens).toBe(4096);
  const draft=dadouchosSource({...v,session:{...v.session,draft:'changed'}});expect(draft.hash).toBe(source.hash);
 }
 for(const change of [(v:SessionView)=>{v.messages.at(-1)!.delivery='interrupted';},(v:SessionView)=>{v.messages.pop();},(v:SessionView)=>{v.partner.pending={id:'p',choice:null,state:'failed'};}]){const v=view();change(v);expect(()=>dadouchosSource(v)).toThrow('dadouchos_unavailable');}
 expect(()=>dadouchosSource(view(0))).toThrow();expect(()=>parseDadouchos(' \n ')).toThrow();
 expect(parseDadouchos('  Consider silence.\nOr pause.  ')).toBe('Consider silence.\nOr pause.');
 expect(()=>validateCommand('dadouchosOpen',{sessionId:'s',operationId:'o',messages:[]})).toThrow('invalid_command');
 validateCommand('dadouchosClose',{sessionId:'s'});
});
function setup(){
 const dir=mkdtempSync('/tmp/stomylos-dadouchos-'),store=new Store(dir,resolve('native/advisory-lock.node'));
 cleanups.push(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const id=store.createSession().id;let src={...dadouchosSource(view()),sessionId:id};
 const pending:{resolve:(x:{content:string;metadata:Json})=>void;reject:(e:unknown)=>void}[]=[];
 const complete=vi.fn((_b:Json,_i:Json,_s:AbortSignal)=>new Promise<{content:string;metadata:Json}>((resolve,reject)=>{pending.push({resolve,reject});}));
 const hooks={source:async()=>src,emit:vi.fn(),start:async(a:string,s:string,p:string|null,b:Json)=>store.dadouchosRequestStart(a,s,p,b),finish:async(a:string,m:Json,f:string|null)=>store.dadouchosRequestFinish(a,m,f)};
 const controller=new DadouchosController({complete} as unknown as Gateway,hooks);
 return {dir,store,id,pending,complete,hooks,controller,change:()=>{src={...src,hash:'changed'};}};
}
it('deduplicates, reopens cached text and rejects late cancelled results while preserving billed metadata',async()=>{
 const r=setup();await r.controller.open(r.id,'one');await vi.waitFor(()=>expect(r.pending).toHaveLength(1));
 await r.controller.open(r.id,'one');await r.controller.open(r.id,'two');expect(r.complete).toHaveBeenCalledTimes(1);
 r.pending[0].resolve({content:'A private guide.',metadata:{usage:{cost:.01},private:'secret'}});await r.controller.settle();
 r.controller.hide();await r.controller.open(r.id,'three');expect(r.controller.snapshot()).toMatchObject({open:true,text:'A private guide.'});expect(r.complete).toHaveBeenCalledTimes(1);
 r.change();await r.controller.open(r.id,'four');await vi.waitFor(()=>expect(r.pending).toHaveLength(2));r.controller.dispose();
 r.pending[1].resolve({content:'Stale guide',metadata:{usage:{cost:.02}}});await r.controller.settle();expect(r.controller.snapshot().text).toBeNull();
 const rows=r.store.requestHistory(r.id);expect(rows).toHaveLength(2);expect(rows[1].status).toBe('interrupted');expect(rows[1].metadata.usage.cost).toBe(.02);
 expect(JSON.stringify(rows)).not.toMatch(/private guide|Stale guide|PRIVATE|secret|Partner 4/);
});
it('retries only explicitly and waits for metadata saves; restart does not retain content or replay',async()=>{
 const r=setup();await r.controller.open(r.id,'one');await vi.waitFor(()=>expect(r.pending).toHaveLength(1));
 r.pending[0].reject(new CompletionFailure('request_timeout',null,{usage:{cost:.01}}));await r.controller.settle();
 r.controller.hide();await r.controller.open(r.id,'reopen');expect(r.pending).toHaveLength(1);
 await r.controller.open(r.id,'retry',true);await vi.waitFor(()=>expect(r.pending).toHaveLength(2));
 let release!:()=>void;const finish=r.hooks.finish;r.hooks.finish=async(...args)=>{await new Promise<void>(resolve=>{release=resolve;});await finish(...args);};
 r.pending[1].resolve({content:'Ready',metadata:{usage:{cost:.02}}});await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 await r.controller.open(r.id,'not-another-retry',true);expect(r.pending).toHaveLength(2);release();await r.controller.settle();
 const rows=r.store.requestHistory(r.id);expect(rows[1].parentId).toBe(rows[0].id);expect(rows[1].settings.reasoning).toEqual({enabled:false,exclude:true});
 r.store.dadouchosRequestStart('unfinished',r.id,null,{model:'selected'});r.store.close();const restarted=new Store(r.dir,resolve('native/advisory-lock.node'));
 expect(restarted.requestHistory(r.id).find(x=>x.id==='unfinished')?.status).toBe('interrupted');restarted.close();expect(r.pending).toHaveLength(2);
});
it('rejects a changed source before accepting the result',async()=>{const r=setup();await r.controller.open(r.id,'one');await vi.waitFor(()=>expect(r.pending).toHaveLength(1));r.change();r.pending[0].resolve({content:'Late',metadata:{}});await r.controller.settle();expect(r.controller.snapshot()).toMatchObject({phase:'failed',error:'dadouchos_stale',text:null});});
it('uses common real transport accounting on success and wrong-model failure with explicit retry only',async()=>{
 const r=setup(),usage=new UsageStore(r.dir,()=>undefined);cleanups.unshift(()=>usage.close());let model='wrong';
 const fetch=vi.fn(async()=>new Response(JSON.stringify({model,provider:'Any',choices:[{message:{content:'Consider silence.'},finish_reason:'stop'}],usage:{cost:.001}})));vi.stubGlobal('fetch',fetch);
 const c=new DadouchosController(new OpenRouter(()=>'synthetic','https://mock.invalid',usage),r.hooks);
 await c.open(r.id,'first');await c.settle();expect(c.snapshot().phase).toBe('failed');
 model='google/gemma-4-31b-it';await c.open(r.id,'retry',true);await c.settle();expect(c.snapshot().phase).toBe('ready');
 c.hide();await c.open(r.id,'cached');expect(fetch).toHaveBeenCalledTimes(2);expect(usage.snapshot()).toMatchObject({requests:2,total:'0.002'});
});
it('coordinator preserves draft on rejected send, clears on accepted send, and invalidates on navigation',async()=>{
 const r=setup(),sql=(r.store as any).db;
 sql.prepare("UPDATE sessions SET state='active' WHERE id=?").run(r.id);
 sql.prepare("INSERT INTO messages VALUES('u',?,1,'user','You said it was open.','learner','complete',NULL)").run(r.id);
 sql.prepare("INSERT INTO messages VALUES('a',?,2,'assistant','I was wrong. I am sorry.','model','complete',NULL)").run(r.id);
 const db={ready:Promise.resolve(),call:async(method:StoreMethod,...args:any[])=>(r.store[method] as Function).apply(r.store,args),close:async()=>{}} as unknown as DatabaseClient;
 const gateway={complete:vi.fn(async()=>({content:'Consider the correction.',metadata:{}})),stream:vi.fn(async()=>{throw Error('mock offline');})} as unknown as Gateway;
 const c=new Coordinator(db,gateway,{keyPresent:true,keyPath:'',dataPath:r.dir,appVersion:'test',development:true},()=>{},()=>true);
 await c.command('dadouchosOpen',{sessionId:r.id,operationId:'open'});await c.dadouchos.settle();expect(c.dadouchos.snapshot().phase).toBe('ready');
 await c.command('saveDraft',{sessionId:r.id,text:'My draft',revision:2});
 await expect(c.command('sendMessage',{sessionId:r.id,text:'old',revision:1,expectedReplyContextRevision:0})).rejects.toThrow('draft_changed');expect(c.dadouchos.snapshot().text).toBe('Consider the correction.');
 await c.command('dadouchosClose',{sessionId:r.id});await c.command('dadouchosOpen',{sessionId:r.id,operationId:'again'});expect(gateway.complete).toHaveBeenCalledTimes(1);
 await c.command('loadSession',{sessionId:r.id});expect(c.dadouchos.snapshot().open).toBe(true);
 (c as any).startReply=vi.fn();
 await c.command('sendMessage',{sessionId:r.id,text:'My draft',revision:2,expectedReplyContextRevision:0});expect(c.dadouchos.snapshot().text).toBeNull();expect(r.store.messages(r.id).at(-1)?.content).toBe('My draft');
 // A pending optional request must not hold backup admission indefinitely.
 (c.dadouchos as any).flight={abort:new AbortController(),done:new Promise(()=>{})};
 await expect(c.withBackup(async()=>{})).rejects.toThrow('backup_busy');
 (c.dadouchos as any).flight=null;
});

it.each([
 ['length',{content:'Partial'},'response_incomplete'],
 ['stop',{content:''},'response_empty'],
 ['stop',{content:'Words',tool_calls:[{id:'x'}]},'response_tool_call']
])('rejects unusable real envelopes (%s)',async(reason,message,code)=>{
 const r=setup();vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({model:'google/gemma-4-31b-it',provider:'Any',choices:[{message,finish_reason:reason}],usage:{cost:0}}))));
 const c=new DadouchosController(new OpenRouter(()=>'synthetic','https://mock.invalid'),r.hooks);await c.open(r.id,'one');await c.settle();expect(c.snapshot()).toMatchObject({phase:'failed',error:code,text:null});
});
it('cancels before dispatch during admission without blocking or replaying',async()=>{
 const r=setup();let release!:()=>void;const start=r.hooks.start;r.hooks.start=async(...args)=>{await new Promise<void>(resolve=>{release=resolve;});await start(...args);};
 await r.controller.open(r.id,'one');await vi.waitFor(()=>expect(release).toBeTypeOf('function'));r.controller.hide();release();await r.controller.settle();expect(r.complete).not.toHaveBeenCalled();expect(r.store.requestHistory(r.id)[0]).toMatchObject({status:'interrupted',dispatchedAt:null});
});

it('navigation during source admission prevents a late open and dispatch',async()=>{
 const r=setup();const source=r.hooks.source;let release!:()=>void;r.hooks.source=async()=>{await new Promise<void>(resolve=>{release=resolve;});return source();};
 const opening=r.controller.open(r.id,'one');await vi.waitFor(()=>expect(release).toBeTypeOf('function'));r.controller.dispose(r.id);release();await expect(opening).rejects.toThrow('dadouchos_stale');expect(r.complete).not.toHaveBeenCalled();expect(r.controller.snapshot().sessionId).toBeNull();
});
