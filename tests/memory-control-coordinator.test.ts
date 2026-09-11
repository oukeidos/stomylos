import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store,type StoreMethod } from '../src/main/database';
import { Coordinator } from '../src/main/coordinator';
import type { DatabaseClient } from '../src/main/db-client';
import type { Gateway } from '../src/main/transport';
import type { Json } from '../src/shared/types';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanup.splice(0))await f();});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
it('honors Off after preparation but before gateway handoff, then On does not enable the same chat',async()=>{
 const dir=mkdtempSync('/tmp/stomylos-memory-handoff-'),store=new Store(dir,resolve('native/advisory-lock.node'));
 const prepared=deferred(),release=deferred(),reply=deferred();let hold=true;
 const client={ready:Promise.resolve(),call:async(method:StoreMethod,...args:any[])=>{
   const result=(store[method] as Function).apply(store,args);
   if(method==='prepareChat'&&hold){hold=false;prepared.resolve();await release.promise;}
   return result;
 },close:async()=>store.close()} as unknown as DatabaseClient;
 const packets:Json[]=[];
 const gateway:Gateway={async complete(){throw new Error('unexpected call');},async stream(body,_signal,chunk){packets.push(body);await reply.promise;chunk('Hello.');return {content:'Hello.',metadata:{}};}};
 const coordinator=new Coordinator(client,gateway,{keyPresent:true,keyPath:'',dataPath:dir,appVersion:'test',development:true},()=>{},()=>true);
 cleanup.push(async()=>{release.resolve();reply.resolve();await coordinator.command('close',undefined);rmSync(dir,{recursive:true,force:true});});
 const s=store.createSession();store.searchMode(s.id,'off');store.selectManual(s.id,'model_04');
 await coordinator.command('sendMessage',{sessionId:s.id,text:'I like museums.',revision:0});await prepared.promise;
 // The setting write waits behind prepareChat's acknowledged write, but still
 // precedes the separate handoff admission. Do not wait for it before release.
 const off=coordinator.command('setMemoryPreference',{enabled:false,revision:0});await Promise.resolve();release.resolve();await off;
 await vi.waitFor(()=>expect(packets).toHaveLength(1));expect(store.view(s.id).memoryPolicy?.firstEnabled).toBe(false);
 await coordinator.command('setMemoryPreference',{enabled:true,revision:1});reply.resolve();
 await vi.waitFor(()=>expect(store.messages(s.id).at(-1)?.delivery).toBe('complete'));
 await coordinator.command('endSession',{sessionId:s.id});expect(store.memoryJob(s.id)).toBeNull();expect(store.endBlocker()).toBeNull();
});
