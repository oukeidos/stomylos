import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/main/database';
import { GenieController } from '../src/main/genie-controller';
import { CompletionFailure, type Gateway } from '../src/main/transport';
import type { GenieSource } from '../src/shared/genie';
import type { Json } from '../src/shared/types';
const resources: {store:Store;directory:string; controller?:GenieController}[]=[];
afterEach(async()=>{for(const r of resources.splice(0)){await r.controller?.dispose();r.store.close();rmSync(r.directory,{recursive:true,force:true});}});
function setup() {
  const directory=mkdtempSync(join(tmpdir(),'stomylos-genie-history-'));
  const r={directory,store:new Store(directory,resolve('native/advisory-lock.node')),controller:undefined as GenieController|undefined};resources.push(r);
  const s=r.store.createSession(), source:GenieSource={sessionId:s.id,text:'private unsent draft',revision:1,contextHash:'h',messages:[]};
  const pending:{resolve:(result:{content:string;metadata:Json})=>void;reject:(e:unknown)=>void}[]=[];
  const complete=vi.fn((_body:Json,_identity:Json,signal:AbortSignal)=>new Promise<{content:string;metadata:Json}>((resolve,reject)=>{
    pending.push({resolve,reject});signal.addEventListener('abort',()=>reject(new CompletionFailure('request_cancelled',null,{})),{once:true});
  }));
  const hooks={source:async()=>source,save:async()=>{},emit:()=>{},
    requestStart:async(id:string,session:string,parent:string|null,settings:Json)=>r.store.genieRequestStart(id,session,parent,settings),
    requestFinish:async(id:string,metadata:Json,failure:string|null)=>r.store.genieRequestFinish(id,metadata,failure)};
  r.controller=new GenieController({complete} as unknown as Gateway,hooks);
  const open=()=>r.controller!.open({sessionId:s.id,text:source.text,revision:1,range:{scope:'draft',start:0,end:source.text.length,direction:'none'},operationId:'open'});
  return {r,id:s.id,pending,complete,hooks,open};
}
it('retains content-free successful/failed retries across episode disposal and process restart',async()=>{
  const {r,id,open,pending,complete}=setup();await open();await vi.waitFor(()=>expect(pending).toHaveLength(1));
  pending[0].reject(new CompletionFailure('request_timeout',null,{usage:{cost:0.01}}));
  await vi.waitFor(()=>expect(r.store.requestHistory(id)[0].status).toBe('failed'));
  const episode=r.controller!.snapshot().episode!;await r.controller!.retry(episode.id,'retry');await vi.waitFor(()=>expect(pending).toHaveLength(2));
  pending[1].resolve({content:'{"reply":"A private suggestion","suggested_text":null}',metadata:{model:'openai/gpt-5.6-luna',usage:{cost:0.125},private:'must not persist'}});
  await vi.waitFor(()=>expect(r.store.requestHistory(id)[1].status).toBe('succeeded'));
  await r.controller!.dispose();r.store.close();r.store=new Store(r.directory,resolve('native/advisory-lock.node'));
  const rows=r.store.requestHistory(id);expect(rows).toHaveLength(2);expect(rows[1].parentId).toBe(rows[0].id);
  expect(rows[1].metadata.usage.cost).toBe(0.125);expect(rows[0].metadata.usage.cost).toBe(0.01);
  const text=JSON.stringify(rows);expect(text).not.toContain('private');expect(text).not.toContain('suggestion');expect(text).not.toContain('must not persist');
  expect(rows[1].settings).toMatchObject({model:'openai/gpt-5.6-luna',provider:{allow_fallbacks:true,data_collection:'deny'}});
  expect(complete).toHaveBeenCalledTimes(2);
});
it('records cancellation during durable admission as known unsent and never dispatches',async()=>{
  const {r,id,open,hooks,complete}=setup();let release!:()=>void;
  const original=hooks.requestStart;hooks.requestStart=async(...args)=>{await original(...args);await new Promise<void>(resolve=>{release=resolve;});};
  await open();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  const cancel=r.controller!.cancel(r.controller!.snapshot().episode!.id,true);release();await cancel;
  expect(complete).not.toHaveBeenCalled();expect(r.store.requestHistory(id)[0]).toMatchObject({status:'interrupted',failure:'queued_not_dispatched',dispatchedAt:null});
});
it('recovers dispatched attempts without replay and deletes their metadata with the chat',()=>{
  const {r,id,complete}=setup();r.store.genieRequestStart('pending',id,null,{model:'m',messages:[{content:'do not store'}]});
  r.store.close();r.store=new Store(r.directory,resolve('native/advisory-lock.node'));
  expect(r.store.requestHistory(id)[0]).toMatchObject({status:'interrupted',failure:'interrupted_unknown_outcome',settings:{model:'m'}});
  expect(complete).not.toHaveBeenCalled();r.store.end(id);r.store.deleteSession(id);
  expect(()=>r.store.requestHistory(id)).toThrow('session_not_found');expect(r.store.integrity().foreignKeys).toEqual([]);
});
it('waits for saving a received result without allowing another inference or losing the receipt',async()=>{
  const {r,id,open,hooks,pending,complete}=setup();let release!:()=>void;
  const finish=hooks.requestFinish;hooks.requestFinish=async(...args)=>{await new Promise<void>(resolve=>{release=resolve;});await finish(...args);};
  await open();await vi.waitFor(()=>expect(pending).toHaveLength(1));pending[0].resolve({content:'{"reply":"Hello","suggested_text":null}',metadata:{usage:{cost:0.25}}});
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  const e=r.controller!.snapshot().episode!;await expect(r.controller!.retry(e.id,'retry')).rejects.toThrow('genie_busy');
  release();await vi.waitFor(()=>expect(r.store.requestHistory(id)[0].status).toBe('succeeded'));
  expect(complete).toHaveBeenCalledTimes(1);expect(r.store.requestHistory(id)[0].metadata.usage.cost).toBe(0.25);
});
