import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/database';
import { conversationSnapshot, routerSnapshot, routerBody, verifyRuntime } from '../src/main/contracts';
import { recoverRouter } from '../src/main/router-recovery';
import { CompletionFailure, type Gateway } from '../src/main/transport';
import { AppFailure } from '../src/main/errors';
import { partnerRouterBody } from '../src/main/partner-router';
import { partnerOrder, orderedPartners, partnerDisplayName } from '../src/shared/partners';
import type { Json } from '../src/shared/types';

const dirs: string[] = [], stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d,{recursive:true,force:true}); vi.restoreAllMocks(); });
function setup(reselection = false) {
  const dir=mkdtempSync(join(tmpdir(),'stomylos-router-chain-'));dirs.push(dir);
  const store=new Store(dir,resolve('native/advisory-lock.node'));stores.push(store);
  const session=store.createSession();store.searchMode(session.id,'off');store.submit(session.id,'Explain this idea.');
  if(reselection) { store.commitRoute(session.id,{model_03:2},null,null);store.changePartner(session.id,null,randomUUID(),0); }
  const saved=JSON.parse(store.session(session.id).chat_config);
  const first=reselection?store.preparePartner(session.id,'send',randomUUID())!:store.createRequest(session.id,'router',routerSnapshot(saved));
  const body=reselection?partnerRouterBody(JSON.parse(first.config)):routerBody(session.starter_text,'Explain this idea.',saved);
  const io={dispatch:async(id:string)=>store.dispatch(id),finish:async(...args:Parameters<Store['finishRecoveryRoute']>)=>store.finishRecoveryRoute(...args),secondary:async(id:string)=>store.prepareRouterRecovery(id,randomUUID())};
  const scores=(target='model_09')=>JSON.stringify(Object.fromEntries(saved.characters.map((c:Json)=>[c.id,c.id===target?2:1])));
  return {store,session,saved,first,body,io,scores,dir};
}
it.each([false,true])('recovers %s routing with identical input/schema, durable lineage and one result', async reselection => {
  const f=setup(reselection),calls:Json[]=[];
  const gateway={complete:vi.fn(async(body:Json,_identity:Json,_signal:AbortSignal,timeout:number)=>{calls.push({body,timeout});if(calls.length===1)throw new CompletionFailure('response_length_limit','partial',{usage:{cost:0.0001}});return{content:f.scores(),metadata:{usage:{cost:0.0002}}};}),stream:vi.fn()} as Gateway;
  const result=await recoverRouter(f.first,f.saved,f.body,f.io,gateway,new AbortController().signal);
  expect(calls.map(c=>c.body.model)).toEqual(['openai/gpt-5.6-luna','openai/gpt-5.6-terra']);
  expect(calls.map(c=>c.timeout)).toEqual([3000,5000]);expect(calls[1].body.messages).toEqual(calls[0].body.messages);
  expect(calls[1].body.response_format).toEqual(calls[0].body.response_format);
  const attempts=f.store.requests(f.session.id);expect(attempts).toHaveLength(2);expect(attempts[1].parent_id).toBe(attempts[0].id);
  expect(attempts[0].response_content).toBe('partial');expect(JSON.parse(attempts[0].metadata).usage.cost).toBe(0.0001);
  expect(result.scores?.model_09).toBe(2);
  if(reselection)expect(f.store.view(f.session.id).partner.pending?.state).toBe('ready');
  else {f.store.commitRoute(f.session.id,result.scores,result.failure,result.request.id);expect(f.store.session(f.session.id).character).toBe('model_09');}
  expect(f.store.integrity().foreignKeys).toEqual([]);
});
it.each(['low','invalid','both','cancel','late','admission'])('handles %s without extra inference or invented cost',async mode=>{
  const f=setup(true),abort=new AbortController();let calls=0;
  const gateway={complete:vi.fn(async()=>{calls++;if(mode==='cancel'){abort.abort();throw new AppFailure('request_cancelled');}if(mode==='late'){abort.abort();return{content:f.scores(),metadata:{}};}if(mode==='admission')throw new AppFailure('api_key_missing');if(mode==='both'||mode==='invalid'&&calls===1)return{content:'{}',metadata:{}};return{content:mode==='low'?f.scores('none'):f.scores(),metadata:{}};}),stream:vi.fn()} as Gateway;
  const pending=recoverRouter(f.first,f.saved,f.body,f.io,gateway,abort.signal);
  if(mode==='admission'){await expect(pending).rejects.toThrow('api_key_missing');expect(calls).toBe(1);return;}
  const result=await pending;
  expect(calls).toBe(['both','invalid'].includes(mode)?2:1);
  expect(f.store.view(f.session.id).partner.pending?.state).toBe(['cancel','late','admission'].includes(mode)?'failed':'ready');
  if(['cancel','late','both'].includes(mode))expect(result.scores).toBeNull();
  for(const r of f.store.requests(f.session.id))expect(JSON.parse(r.metadata).usage).toBeUndefined();
});
it('does not dispatch a secondary on save failure, and restart requires explicit selection recovery',async()=>{
  const f=setup(true),gateway={complete:vi.fn(async()=>({content:'{}',metadata:{}})),stream:vi.fn()} as Gateway;
  const save=vi.spyOn(f.io,'finish').mockRejectedValue(new AppFailure('operation_failed'));
  await expect(recoverRouter(f.first,f.saved,f.body,f.io,gateway,new AbortController().signal)).rejects.toThrow('operation_failed');
  expect(gateway.complete).toHaveBeenCalledTimes(1);expect(f.store.requests(f.session.id)).toHaveLength(1);save.mockRestore();
  f.store.close();stores.splice(stores.indexOf(f.store),1);
  const reopened=new Store(f.dir,resolve('native/advisory-lock.node'));stores.push(reopened);
  expect(reopened.view(f.session.id).partner.pending?.state).toBe('failed');
  expect(reopened.requests(f.session.id)).toHaveLength(1);
});
it('keeps the ordered definition contract and frozen historical display identities',()=>{
  verifyRuntime();const f=setup(true);
  for(const body of [routerBody(null,'Hello',conversationSnapshot('user')),routerBody('Question','Answer',conversationSnapshot('starter')),f.body]){
    expect(body.messages[0].content.match(/model_\d+/g)).toEqual(partnerOrder);
    expect(Object.keys(body.response_format.json_schema.schema.properties)).toEqual(partnerOrder);
  }
  const saved=[{id:'model_08',label:'Taste',model:'deepseek/deepseek-v4-pro-0813',description:''},{id:'model_03',label:'Explain',model:'anthropic/claude-sonnet-5',description:''}];
  expect(orderedPartners(saved).map(c=>c.id)).toEqual(['model_03','model_08']);expect(saved[0].label).toBe('Taste');
  expect(partnerDisplayName(saved[0])).toBe('Taste · DeepSeek V4 Pro 0813');expect(partnerDisplayName()).toBe('Automatic');
  expect(f.saved.characters.find((c:Json)=>c.id==='model_09').reasoning).toEqual({enabled:false,exclude:true});
});

it('caps the remaining network budget without charging save time to it',async()=>{
  const f=setup(),timeouts:number[]=[];let tick=0;
  vi.spyOn(performance,'now').mockImplementation(()=>tick);
  const gateway={complete:vi.fn(async(_b:Json,_i:Json,_s:AbortSignal,t:number)=>{timeouts.push(t);tick+=timeouts.length===1?7000:500; if(timeouts.length===1)throw new AppFailure('request_timeout');return {content:f.scores(),metadata:{}};}),stream:vi.fn()} as Gateway;
  const finish=f.io.finish;f.io.finish=async(...args)=>{tick+=20000;return finish(...args);};
  const result=await recoverRouter(f.first,f.saved,f.body,f.io,gateway,new AbortController().signal);
  expect(timeouts).toEqual([3000,1000]);expect(result.scores?.model_09).toBe(2);
  expect(JSON.parse(f.store.request(result.request.id).metadata).routing_chain_network_ms).toBe(7500);
});
it('cancels between attempts without leaving reselection routing or dispatching again',async()=>{
  const f=setup(true),abort=new AbortController(),finish=f.io.finish;
  f.io.finish=async(...args)=>{await finish(...args);abort.abort();};
  const gateway={complete:vi.fn(async()=>{throw new AppFailure('request_timeout');}),stream:vi.fn()} as Gateway;
  await recoverRouter(f.first,f.saved,f.body,f.io,gateway,abort.signal);
  expect(gateway.complete).toHaveBeenCalledTimes(1);expect(f.store.requests(f.session.id)).toHaveLength(1);
  expect(f.store.view(f.session.id).partner.pending?.state).toBe('failed');
});
