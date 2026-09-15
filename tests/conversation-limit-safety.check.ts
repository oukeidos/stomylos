import {it,expect,vi,afterEach} from 'vitest';
import {OpenRouter} from '../src/main/transport';
import {grammarBody,grammarSnapshot,validateGrammar} from '../src/main/contracts';
import {prepareProviderRequest} from '../src/main/provider-policy';
import {Store} from '../src/main/database';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const manifest=JSON.parse(readFileSync('test-results/conversation-limits/manifest.json','utf8'));
const source=manifest.cases.find((c:any)=>c.id==='grammar-dense').source;
const body=prepareProviderRequest(grammarBody(grammarSnapshot(),source)).body;
const identity={allowed_models:[body.model],provider:null};
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('actual gateway parses a large 512-unit response within its existing response ceiling',async()=>{
 const units=source.filter((m:any)=>m.role==='user').map((m:any,index:number)=>({index,corrected_text:m.content,explanation:'x'.repeat(850)}));
 const content=JSON.stringify({units});const raw=JSON.stringify({id:'synthetic-response',provider:'Mock',model:body.model,choices:[{message:{content},finish_reason:'stop'}]});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(raw)));
 const result=await new OpenRouter(()=> 'mock-key').complete(body,identity,new AbortController().signal,600000);
 expect(validateGrammar(result.content,source)).toHaveLength(512);
});
it('actual gateway rejects escaped oversized response without accepting partial grammar',async()=>{
 const raw=JSON.stringify({id:'synthetic-response',provider:'Mock',model:body.model,choices:[{message:{content:'"'.repeat(1100000)},finish_reason:'stop'}]});
 expect(Buffer.byteLength(raw)).toBeGreaterThan(2*1024*1024);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(raw)));
 await expect(new OpenRouter(()=> 'mock-key').complete(body,identity,new AbortController().signal,600000)).rejects.toThrow('response_too_large');
});
it('candidate 600-second deadline and cancellation terminate the gateway without real waiting',async()=>{
 vi.useFakeTimers();vi.stubGlobal('fetch',vi.fn((_url:any,opts:any)=>new Promise((_ok,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('aborted'))))));
 const gateway=new OpenRouter(()=> 'mock-key');
 const pending=gateway.complete(body,identity,new AbortController().signal,600000);const check=expect(pending).rejects.toThrow('request_timeout');
 await vi.advanceTimersByTimeAsync(600000);await check;
 const abort=new AbortController();const cancelled=gateway.complete(body,identity,abort.signal,600000);const checkCancel=expect(cancelled).rejects.toThrow('request_cancelled');abort.abort();await checkCancel;
});
it('synthetically seeded 512-turn database retains drafts and freezes End memory after terminal overflow',()=>{
 const dir=mkdtempSync('/tmp/stomylos-limit-storage-');const store=new Store(dir,resolve('native/advisory-lock.node'));const db=new Database(join(dir,'stomylos.sqlite3'));
 try {
  const s=store.createSession();store.searchMode(s.id,'off');store.selectManual(s.id,'model_01');store.submit(s.id,'I keep a notebook.');store.commitRoute(s.id,null,'fixture',null);
  const first=store.startChat(store.prepareChat(s.id,'fixture-first').id);store.finishReply(first.request.id,first.bubble.id,'What color?',{});
  const insert=db.prepare('INSERT INTO messages(id,session_id,sequence,role,origin,content,delivery,request_id) VALUES(?,?,?,?,?,?,?,NULL)');
  db.transaction(()=>{for(const m of source.slice(2))insert.run('limit-'+m.id,s.id,m.sequence,m.role,m.origin,m.content,'complete');insert.run('limit-terminal',s.id,source.length,'assistant','model','x'.repeat(64000),'complete');})();
  expect(store.view(s.id).messages.filter(m=>m.origin==='learner')).toHaveLength(512);
  store.end(s.id,'Retained unsent draft');const view=store.view(s.id);expect(view.session.draft).toBe('Retained unsent draft');expect(view.session.state).toBe('ended');
  const job=store.memoryAddReady()!;expect(JSON.parse(job.input_json).conversation).toHaveLength(1024);expect(JSON.parse(job.config).body.max_tokens).toBe(128000);
  expect(store.endBlocker()).toBe(s.id);
 }finally{store.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
