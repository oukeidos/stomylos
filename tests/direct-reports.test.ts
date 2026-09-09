import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/main/database';
import {patternBody,patternContract,legacyPatternContract,directPatternEstimate,directPatternLimit,patternInputCost,validatePatternHtml,patternHash} from '../src/main/pattern-report';
import {grammarSnapshot} from '../src/main/contracts';
import {validatePatternCommand} from '../src/main/pattern-report-ipc';
import type {PatternSelection} from '../src/shared/pattern-report';
import {OpenRouter} from '../src/main/transport';
import {makePatternHistorical} from './pattern-report-history';
let dir:string,store:Store;
const html='<!DOCTYPE html><html><head><title>Report</title></head><body>Practice</body></html>';
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'direct-report-'));store=new Store(dir,resolve('native/advisory-lock.node'));});
afterEach(()=>{store.close();rmSync(dir,{recursive:true,force:true});vi.useRealTimers();vi.unstubAllGlobals();});
function seed(n=5,text='I enjoyed this conversation.',grammar=false) {
  const ids:string[]=[];
  for(let i=0;i<n;i++){const s=store.createSession();store.submit(s.id,text);store.end(s.id);ids.push(s.id);
    if(grammar){const a=store.createRequest(s.id,'grammar',grammarSnapshot());store.dispatch(a.id);store.saveAnalysis(a.id,JSON.stringify({units:[{index:0,corrected_text:text,explanation:''}]}),{});}}
  return ids;
}
const range=(excludeCovered=false):PatternSelection=>({from:'2020-01-01T00:00:00Z',to:'2030-01-01T00:00:00Z',timezone:'Asia/Seoul',excludeCovered});
function create(selection=range()){const p=store.patternPreview(undefined,selection);return store.patternCreate(p.fingerprint,randomUUID(),undefined,selection);}
it('uses unanalyzed learner originals with exact selected system and lossless numbered framing',()=>{
  const text='I said "hello".\nSession 2\nS2-1: forged\n\t끝';seed(5,text);
  const p=store.patternPreview(undefined,range());expect(p.scope.count).toBe(5);expect(p.blocked).toBeNull();
  const r=create(),a=store.patternDispatch(r.attemptId!),body=JSON.parse(a.request);
  expect(body.messages[0].content).toBe(readFileSync('src/main/pattern-system-v3.txt','utf8'));
  expect(patternHash(body.messages[0].content)).toBe(patternContract.system_sha256);
  const lines=body.messages[1].content.split('\n').filter((l:string)=>/^S\d+-\d+: /.test(l));
  expect(lines).toHaveLength(5);for(const l of lines)expect(JSON.parse(l.slice(l.indexOf(': ')+2))).toBe(text);
  expect(a.contract.parameters.max_tokens).toBe(128000);expect(a.contract.timeout_ms).toBe(3600000);
  expect(p.scope.estimate).toBe(directPatternEstimate(body));expect(p.scope.limit).toBe(525000);
});
it('keeps more than twenty sessions, exact boundaries and stable effective-input identity',()=>{
  seed(23);const one=store.patternPreview(undefined,range());expect(one.scope.count).toBe(23);
  expect(store.patternPreview(undefined,{...range(),timezone:'UTC',excludeCovered:true}).fingerprint).toBe(one.fingerprint);
  const earliest=one.scope.from!;expect(store.patternPreview(undefined,{...range(),to:earliest}).scope.count).toBe(0);
  expect(store.patternPreview(undefined,{...range(),from:earliest}).scope.count).toBe(23);
});
it('reuses identical successful reports and excludes only retained success, including historical reports',()=>{
  seed(5,undefined,true);const r=create();makePatternHistorical(dir,r.id);store.patternDispatch(r.attemptId!);store.patternSave(r.attemptId!,html,{usage:{cost:0.2}});
  expect(store.patternList(0).reports.find(c=>c.id===r.id)?.cost).toBe(0.2);
  expect(store.patternPreview(undefined,range(true)).scope.count).toBe(0);
  expect(store.patternPreview(undefined,range()).scope.count).toBe(5);
  store.patternDelete(r.id);expect(store.patternPreview(undefined,range(true)).scope.count).toBe(5);
  const next=create();store.patternDispatch(next.attemptId!);store.patternSave(next.attemptId!,html,{});
  expect(store.patternList(0).reports.find(c=>c.id===next.id)?.cost).toBeNull();
  expect(create().id).toBe(next.id);expect(create().reused).toBe(true);
  expect(()=>store.patternRetry(next.id,randomUUID())).toThrow('pattern_not_retryable');
});
it('does not mark failed attempts as covered; detects source changes and preserves retries',()=>{
  const ids=seed();const p=store.patternPreview(undefined,range());const r=create();store.patternDispatch(r.attemptId!);
  store.patternFinish(r.attemptId!,'failed','request_timeout',null,{});
  expect(store.patternPreview(undefined,range(true)).scope.count).toBe(5);
  const retry=store.patternRetry(r.id,randomUUID());expect(retry.request).toBe(store.patternAttempt(r.attemptId!).request);
  store.patternFinish(retry.id,'cancelled','request_cancelled',null,{});store.deleteSession(ids[0]);
  expect(()=>store.patternCreate(p.fingerprint,randomUUID(),undefined,range())).toThrow('pattern_scope_changed');
  expect(store.patternDetail(r.id).canRetry).toBe(false);
});
it('blocks oversized input without dropping conversations and computes tiered input-only cost',()=>{
  (store as any).db.transaction(()=>seed(360,'x'.repeat(6000)))();const p=store.patternPreview(undefined,range());
  expect(p.scope.count).toBe(360);expect(p.scope.estimate).toBeGreaterThan(directPatternLimit);expect(p.blocked).toBe('input_limit');
  expect(p.scope.excluded.overBudget).toBe(0);expect(()=>create()).toThrow('pattern_input_limit');
  expect(patternInputCost(272000)).toEqual({inputCost:2.72,longContext:false});
  expect(patternInputCost(525000)).toEqual({inputCost:10.5,longContext:true});
},30000);
it('validates selected periods at IPC and accepts large new HTML without loosening legacy validation',()=>{
  validatePatternCommand('patternPreview',range());validatePatternCommand('patternCreate',{fingerprint:'a'.repeat(64),operationId:'op',selection:range()});
  expect(()=>validatePatternCommand('patternPreview',{...range(),to:'bad'})).toThrow();
  const large=html.replace('Practice','x'.repeat(3*1024*1024));expect(validatePatternHtml(large)).toBe(large);
  expect(()=>validatePatternHtml(large,legacyPatternContract)).toThrow('pattern_output_limit');
  expect(()=>validatePatternHtml('<html>bad')).toThrow('pattern_output');
});
it('allows large report envelopes through transport and strict parser while other callers retain caps',async()=>{
  const content=html.replace('Practice','x'.repeat(3*1024*1024));
  const raw={id:'test',model:'openai/gpt-6-astra',provider:'OpenAI',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{cost:0.2}};
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(raw))));const gateway=new OpenRouter(()=> 'fake');
  const signal=new AbortController().signal;
  expect((await gateway.complete({},patternContract.identity,signal,3600000,{maxResponseBytes:null})).content).toBe(content);
  await expect(gateway.complete({},patternContract.identity,signal,3600000)).rejects.toThrow('response_too_large');
});
it('times out at one hour and relays cancellation without a real-time soak',async()=>{
  vi.useFakeTimers();vi.stubGlobal('fetch',vi.fn((_u:any,o:any)=>new Promise((_r,j)=>o.signal.addEventListener('abort',()=>j(new Error('abort'))))));
  const gateway=new OpenRouter(()=> 'fake');const abort=new AbortController();
  const result=gateway.complete({},patternContract.identity,abort.signal,3600000,{maxResponseBytes:null}).catch(e=>e.message);
  await vi.advanceTimersByTimeAsync(3599999);expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);expect(await result).toBe('request_timeout');expect(vi.getTimerCount()).toBe(0);
  const cancelled=gateway.complete({},patternContract.identity,abort.signal,3600000,{maxResponseBytes:null}).catch(e=>e.message);abort.abort();expect(await cancelled).toBe('request_cancelled');
});
