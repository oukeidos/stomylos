import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type StoreMethod } from '../src/main/database';
import { Coordinator } from '../src/main/coordinator';
import type { DatabaseClient } from '../src/main/db-client';
import type { Gateway } from '../src/main/transport';

export function memoryFixture() {
  const dir=mkdtempSync('/tmp/stomylos-memory-regression-');let store=new Store(dir,'isolated');
  const db=new Database(join(dir,'stomylos.sqlite3'));
  return {dir,db,get store(){return store;},reopen(){store.close();store=new Store(dir,'isolated');},
    close(){store.close();db.close();rmSync(dir,{recursive:true,force:true});}};
}
export function memorySession(store:Store, text='I like quiet museums.', partner='model_03') {
  const s=store.createSession();store.searchMode(s.id,'off');store.selectManual(s.id,partner);
  store.submit(s.id,text);store.commitRoute(s.id,null,'fixture',null);
  const a=store.startChat(store.prepareChat(s.id,randomUUID()).id);store.finishReply(a.request.id,a.bubble.id,'Tell me more.',{});
  return store.session(s.id);
}
export function memoryAttempt(store:Store) {
  const job=store.memoryAddReady();if(!job)throw Error('Expected a ready memory job');
  const a=store.prepareMemoryAdd(job.ordinal,randomUUID()),config=JSON.parse(job.config);
  store.prepareProvider('memory_add',a.id,JSON.parse(a.body),(a.phase==='link'?config.linker:config).identity);
  store.dispatchMemoryAdd(a.id);return a;
}
export function receiveNotes(store:Store,texts:string[]) {
  const a=memoryAttempt(store);store.receiveMemoryAdd(a.id,JSON.stringify({add:texts}),{});store.acceptMemoryAdd(a.id);
  if(!texts.length)return a;
  const link=memoryAttempt(store);store.receiveMemoryAdd(link.id,JSON.stringify({sources:texts.map((_,i)=>({id:i+1,ids:[1]}))}),{});
  return link;
}
export function acceptNotes(store:Store,texts:string[]) {const a=receiveNotes(store,texts);store.acceptMemoryAdd(a.id);return store.currentMemory();}
export function memoryCoordinator(f:ReturnType<typeof memoryFixture>,gateway:Gateway,keyPresent=true) {
  const db={ready:Promise.resolve(),call:async(method:StoreMethod,...args:any[])=>(f.store[method] as Function).apply(f.store,args),close:async()=>f.store.close()} as unknown as DatabaseClient;
  return new Coordinator(db,gateway,{keyPresent,keyPath:'',dataPath:f.dir,appVersion:'test',development:true},()=>{},()=>keyPresent);
}
