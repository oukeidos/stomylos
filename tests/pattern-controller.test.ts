import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/database';
import { grammarSnapshot } from '../src/main/contracts';
import { PatternReportController } from '../src/main/pattern-report-controller';
import type { DatabaseClient } from '../src/main/db-client';
import type { Gateway } from '../src/main/transport';
import { AppFailure } from '../src/main/errors';

const html = '<!DOCTYPE html><html><head><title>Practice</title></head><body>No recurring pattern.</body></html>';
let dir: string, store: Store, controller: PatternReportController;
const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((r,j)=>{resolve=r;reject=j;}); return {promise,resolve,reject}; };
beforeEach(() => {
  dir=mkdtempSync(join(tmpdir(),'stomylos-pattern-controller-')); store=new Store(dir,resolve('native/advisory-lock.node'));
  for(let i=0;i<5;i++) { const s=store.createSession(); store.submit(s.id,'I enjoyed walking.'); store.end(s.id);
    const a=store.createRequest(s.id,'grammar',grammarSnapshot()); store.dispatch(a.id);
    store.saveAnalysis(a.id,JSON.stringify({units:[{index: 0,corrected_text:'I enjoyed walking.',explanation:''}]}),{}); }
});
afterEach(async()=>{ await controller?.close(); store.close(); rmSync(dir,{recursive:true,force:true}); });
function rig() {
  const remote=deferred<{content:string;metadata:Record<string,unknown>}>();
  const complete=vi.fn((_body: unknown,_identity: unknown,_signal: AbortSignal)=>remote.promise);
  const call=vi.fn(async(method:string,...args:unknown[])=>(store as any)[method](...args));
  const hooks={write:vi.fn(call),publish:vi.fn(),open:vi.fn(async()=>{}),closeViewer:vi.fn(),retrySave:vi.fn(async()=>{})};
  controller=new PatternReportController({call} as unknown as DatabaseClient,{complete} as unknown as Gateway,hooks as any);
  const create=()=>controller.command('patternCreate',{fingerprint:store.patternPreview().fingerprint,operationId:randomUUID()});
  const done=()=>vi.waitFor(()=>expect(controller.snapshot().phase).toBe('idle'));
  return {remote,complete,hooks,create,done};
}
it('dispatches exactly once after double click and preserves the assembled request',async()=>{
  const r=rig(), args={fingerprint:store.patternPreview().fingerprint,operationId:randomUUID()};
  const [one,two]=await Promise.all([controller.command('patternCreate',args),controller.command('patternCreate',args)]);
  expect(one.id).toBe(two.id); await vi.waitFor(()=>expect(r.complete).toHaveBeenCalledTimes(1));
  const attempt=store.patternAttempt(store.patternDetail(one.id).last_attempt_id);
  expect(r.complete.mock.calls[0][0]).toEqual(JSON.parse((attempt as any).provider_request).body);
  expect(JSON.parse(attempt.request).provider.only).toEqual(['openai']);
  r.remote.resolve({content:html,metadata:{usage:{cost:0.25}}}); await r.done();
  expect(store.patternHtml(one.id).html).toBe(html);
  await controller.command('patternCreate',args); expect(r.complete).toHaveBeenCalledTimes(1);
});
it('keeps unsaved HTML in memory and retries a lost commit acknowledgement without inference',async()=>{
  const r=rig(), saved=deferred<void>(); let waiting=false;
  r.hooks.write.mockImplementation(async(method:string,...args:unknown[])=>{
    if(method==='patternSave') { (store as any)[method](...args); waiting=true; await saved.promise; return (store as any)[method](...args); }
    return (store as any)[method](...args);
  });
  const report=await r.create(); await vi.waitFor(()=>expect(r.complete).toHaveBeenCalledTimes(1));
  r.remote.resolve({content:html,metadata:{usage:{cost:0.25}}}); await vi.waitFor(()=>expect(waiting).toBe(true));
  expect(controller.snapshot().phase).toBe('saving'); expect(store.patternHtml(report.id).html).toBe(html);
  await expect(controller.command('patternCancel',{id:report.id})).rejects.toThrow('save_required');
  await controller.command('patternClose',undefined); expect(r.hooks.closeViewer).toHaveBeenCalled();
  saved.resolve(); await r.done(); expect(r.complete).toHaveBeenCalledTimes(1);
});
it('drains cancellation and rejects a late successful response before it can be saved',async()=>{
  const r=rig(), report=await r.create(); await vi.waitFor(()=>expect(r.complete).toHaveBeenCalledTimes(1));
  const cancel=controller.command('patternCancel',{id:report.id});
  await vi.waitFor(()=>expect(r.complete.mock.calls[0][2].aborted).toBe(true));
  r.remote.resolve({content:html,metadata:{usage:{cost:0.2}}}); await cancel;
  expect(store.patternDetail(report.id).status).toBe('cancelled'); expect(()=>store.patternHtml(report.id)).toThrow('pattern_not_ready');
  expect(JSON.parse(store.patternAttempt(store.patternDetail(report.id).last_attempt_id).metadata).usage.cost).toBe(0.2);
});
it('aborts and drains an affected source before conversation deletion',async()=>{
  const r=rig(), report=await r.create(); await vi.waitFor(()=>expect(r.complete).toHaveBeenCalledTimes(1));
  const source=store.patternDetail(report.id).sources[0].session_id, cancel=controller.sourceDeleting(source);
  await vi.waitFor(()=>expect(r.complete.mock.calls[0][2].aborted).toBe(true));
  r.remote.reject(new AppFailure('request_cancelled')); await cancel; store.deleteSession(source);
  expect(store.patternDetail(report.id).canRetry).toBe(false); expect(r.complete).toHaveBeenCalledTimes(1);
});
it('does not invoke the gateway when durable dispatch fails',async()=>{
  const r=rig(); r.hooks.write.mockImplementation(async(method:string,...args:unknown[])=>{
    if(method==='patternDispatch') throw new AppFailure('database_worker_stopped'); return (store as any)[method](...args);
  });
  const report=await r.create(); await r.done(); expect(r.complete).not.toHaveBeenCalled();
  expect(store.patternDetail(report.id).status).toBe('failed');
});
it('records a timed-out attempt and retries only through a new explicit request with identical bytes',async()=>{
  const r=rig(), report=await r.create(); await vi.waitFor(()=>expect(r.complete).toHaveBeenCalledTimes(1));
  const original=store.patternAttempt(store.patternDetail(report.id).last_attempt_id);
  r.remote.reject(new AppFailure('request_timeout')); await r.done();
  expect(store.patternDetail(report.id).failure).toBe('request_timeout');
  expect(JSON.parse(store.patternAttempt(original.id).metadata).usage).toBeUndefined();
  r.complete.mockImplementation(async()=>({content:html,metadata:{}}));
  await controller.command('patternRetry',{id:report.id,operationId:randomUUID()}); await r.done();
  expect(store.patternAttempt(store.patternDetail(report.id).last_attempt_id).request).toBe(original.request);
  expect(store.patternDetail(report.id).attempts).toHaveLength(2); expect(r.complete).toHaveBeenCalledTimes(2);
});
it('rejects malformed output without another call or partial rendering',async()=>{
  const r=rig(), report=await r.create(); await vi.waitFor(()=>expect(r.complete).toHaveBeenCalledTimes(1));
  r.remote.resolve({content:'<p>Incomplete</p>',metadata:{}}); await r.done();
  expect(store.patternDetail(report.id).status).toBe('failed');
  expect(store.patternAttempt(store.patternDetail(report.id).last_attempt_id).html).toBe('<p>Incomplete</p>');
  await expect(controller.command('patternOpen',{id:report.id})).rejects.toThrow('pattern_not_ready'); expect(r.hooks.open).not.toHaveBeenCalled();
});
it('closes while generation is pending and can resume if overall application close fails',async()=>{
  const r=rig(), report=await r.create(); await vi.waitFor(()=>expect(r.complete).toHaveBeenCalledTimes(1));
  const closing=controller.close(); await vi.waitFor(()=>expect(r.complete.mock.calls[0][2].aborted).toBe(true));
  r.remote.reject(new AppFailure('request_cancelled')); await closing;
  expect(store.patternDetail(report.id).status).toBe('cancelled');
  await expect(controller.command('patternDelete',{id:report.id})).rejects.toThrow('pattern_closed');
  controller.resumeAfterCloseFailure(); await controller.command('patternDelete',{id:report.id});
  expect(store.patternList(0).reports).toHaveLength(0);
  expect(controller.snapshot()).toMatchObject({reportId:null,startedAt:null,error:null,phase:'idle'});
});

it('cancels while durable dispatch is pending without invoking the gateway',async()=>{
  const r=rig(), gate=deferred<void>();let entered=false;
  r.hooks.write.mockImplementation(async(method:string,...args:unknown[])=>{
    if(method==='patternDispatch'){entered=true;await gate.promise;}
    return (store as any)[method](...args);
  });
  const report=await r.create();await vi.waitFor(()=>expect(entered).toBe(true));
  const cancelled=controller.command('patternCancel',{id:report.id});
  await new Promise(resolve=>setTimeout(resolve,0));gate.resolve();await cancelled;
  expect(r.complete).not.toHaveBeenCalled();expect(store.patternDetail(report.id).status).toBe('cancelled');
});

it('aborts on database failure and never commits a late successful response',async()=>{
  const r=rig(),report=await r.create();await vi.waitFor(()=>expect(r.complete).toHaveBeenCalledTimes(1));
  r.hooks.write.mockRejectedValue(new AppFailure('database_worker_stopped'));
  controller.databaseFailed();expect(r.complete.mock.calls[0][2].aborted).toBe(true);
  expect(r.hooks.closeViewer).toHaveBeenCalled();
  r.remote.resolve({content:html,metadata:{}});await r.done();
  expect(r.hooks.write.mock.calls.some(call=>call[0]==='patternSave')).toBe(false);
  expect(()=>store.patternHtml(report.id)).toThrow('pattern_not_ready');
  store.close();store=new Store(dir,resolve('native/advisory-lock.node'));
  expect(store.patternDetail(report.id).status).toBe('interrupted');expect(r.complete).toHaveBeenCalledTimes(1);
});
