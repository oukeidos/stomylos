import { flat, splitDelta } from './flat-memory-fixtures';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { grammarSnapshot } from '../src/main/contracts';
import { Store, type StoreMethod } from '../src/main/database';
import { Coordinator } from '../src/main/coordinator';
import type { DatabaseClient } from '../src/main/db-client';
import type { Gateway } from '../src/main/transport';
import type { Json } from '../src/shared/types';
import { AppFailure } from '../src/main/errors';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });
function fixture(behavior: (kind: string, body: Json, signal: AbortSignal) => Promise<string>) {
  const dir = mkdtempSync(join(tmpdir(), 'stomylos-end-'));
  let store = new Store(dir, resolve('native/advisory-lock.node'));
  const client = { ready: Promise.resolve(), call: async (method: StoreMethod, ...args: any[]) => (store[method] as Function).apply(store, args), close: async () => store.close() } as unknown as DatabaseClient;
  const calls: string[] = [], bodies: {kind: string; body: Json}[] = [];
  const gateway: Gateway = { async complete(body, _identity, signal) {
    const kind = body.model.startsWith('qwen/') ? 'cleanup' : ['stomylos_memory_delta_v1','experimental_database_records_format'].includes(body.response_format?.json_schema.name) ? 'update' : body.response_format ? 'grammar' : 'starter';
    calls.push(kind); bodies.push({kind,body:structuredClone(body)}); return { content: await behavior(kind, body, signal), metadata: {} };
  }, async stream() { throw new Error('not used'); } };
  const settings = { keyPresent: true, keyPath: '', dataPath: dir, appVersion: 'test', development: true };
  const controller = new Coordinator(client, gateway, settings, () => {}, () => true);
  cleanups.push(async () => { await controller.command('close', undefined); rmSync(dir, { recursive: true, force: true }); });
  const session = store.createSession(); store.searchMode(session.id, 'off'); store.selectManual(session.id, 'model_04');
  store.submit(session.id, 'I like quiet museums.'); store.commitRoute(session.id, null, 'public_fixture', null); store.freezeMemory(session.id);
  return { get store() { return store; }, reopen() { store.close(); store = new Store(dir, resolve('native/advisory-lock.node')); }, controller, id: session.id, calls, settings, bodies };
}
function valid(kind: string, body: Json) {
  if (kind === 'update') return '{"add":[],"update":[],"delete":[]}';
  if (kind === 'starter') return 'What would you like to explore?\nHow would you describe a favorite place?';
  return JSON.stringify({ units: JSON.parse(body.messages[1].content).filter((m: Json) => m.role === 'user').map((m: Json) => ({ ...(m.index === undefined ? { text: m.content } : { index: m.index }), corrected_text: m.content, explanation: '' })) });
}
it('runs memory without automatic grammar and gates only until memory completes', async () => {
  let release!: () => void;
  const f = fixture(async (kind, body) => { if (kind === 'update') await new Promise<void>(r => release = r); return valid(kind, body); });
  await f.controller.command('endSession', { sessionId: f.id });
  await vi.waitFor(() => expect(f.calls).toEqual(['update']));
  expect(f.store.session(f.id).analysis_state).toBe('none');
  expect(f.store.endStatus(f.id)?.stages.grammar).toBeUndefined();
  expect(f.store.view(f.id).renewal).toBeNull();
  expect(f.store.endStatus(f.id)?.stages.starter).toBe('skipped');
  await expect(f.controller.command('newSession', undefined)).rejects.toThrow('end_processing_pending');
  release(); await vi.waitFor(() => expect(f.store.endBlocker()).toBe(null));
  await expect(f.controller.command('newSession', undefined)).resolves.toBeTypeOf('string');
});
it('retries validation once and manual retry is one call without refreshing its budget', async () => {
  let fail = true;
  const f = fixture(async (kind, body) => kind === 'update' && fail ? 'invalid json' : valid(kind, body));
  await f.controller.command('endSession', { sessionId: f.id });
  await vi.waitFor(() => expect(f.store.memoryJob(f.id)?.state).toBe('failed'));
  await vi.waitFor(() => expect(f.calls.filter(k => k === 'update')).toHaveLength(2));
  await f.controller.command('retryMemory', { sessionId: f.id });
  await vi.waitFor(() => expect(f.calls.filter(k => k === 'update')).toHaveLength(3));
  await vi.waitFor(() => expect(f.store.memoryJob(f.id)?.state).toBe('failed'));
  fail = false; await f.controller.command('retryMemory', { sessionId: f.id });
  await vi.waitFor(() => expect(f.store.endBlocker()).toBe(null));
  expect(f.calls.filter(k => k === 'update')).toHaveLength(4);
});
it('does not retry invalid credentials and force cancellation releases the gate permanently', async () => {
  const f = fixture(async (kind, body) => { if (kind === 'update') throw new AppFailure('http_401'); return valid(kind, body); });
  await f.controller.command('endSession', { sessionId: f.id });
  await vi.waitFor(() => expect(f.store.memoryJob(f.id)?.state).toBe('failed'));
  expect(f.calls.filter(k => k === 'update')).toHaveLength(1);
  await f.controller.command('cancelEnd', { sessionId: f.id });
  expect(f.store.endBlocker()).toBe(null);
  await expect(f.controller.command('continueEnd', { sessionId: f.id })).rejects.toThrow('end_processing_cancelled');
});

it('commits a saved cleanup response locally without credentials or repeating the updater', async () => {
  const f = fixture(async (kind, body) => valid(kind, body));
  f.store.end(f.id);
  const grammar = f.store.createRequest(f.id, 'grammar', grammarSnapshot());
  f.store.dispatch(grammar.id);
  const learner = f.store.messages(f.id).find(m => m.origin === 'learner')!;
  f.store.saveAnalysis(grammar.id, JSON.stringify({ units: [{index: 0, corrected_text: learner.content, explanation: ''}] }), {});
  expect(f.store.starterJob(f.id)).toBeNull();
  const update = f.store.prepareMemory(f.id, 'update-op'); f.store.dispatchMemory(update.id);
  const content = splitDelta({ operations: [{ op:'add', id:null, category:'traits', text:'x'.repeat(31000), source_message_ids:['u1'] }] });
  f.store.saveMemory(update.id, content, {});
  expect(flat(f.store.saveMemory(update.id, content, {})).database_records[0].text.length).toBe(31000);
  const cleanup = f.store.prepareCleanup(f.id, 'cleanup-op'); f.store.dispatchCleanup(cleanup.id);
  f.store.receiveCleanup(cleanup.id, 'Likes quiet museums.', {});
  f.reopen(); await f.controller.initialize();
  f.settings.keyPresent = false;
  await f.controller.command('continueEnd', { sessionId: f.id });
  expect(f.calls).toEqual([]);
  expect(f.store.endBlocker()).toBeNull();
  expect(flat(f.store.currentMemory()).database_records[0].text).toBe('Likes quiet museums.');
});

it('gives memory stages independent same-input retries and never reruns a successful updater', async () => {
  let updateCalls = 0, recover = false;
  const f = fixture(async (kind, body) => {
    if (kind === 'update') {
      if (++updateCalls === 1) return 'invalid';
      const packet = JSON.parse(body.messages[1].content);
      return splitDelta({operations:[{op:'add',id:null,category:'traits',text:'x'.repeat(31000),source_message_ids:[packet.messages.find((m: Json)=>m.role==='user' && m.evidence!==false).id]}]});
    }
    if (!recover) return '# invalid format';
    return kind === 'cleanup' ? 'Keeps useful detail.' : valid(kind,body);
  });
  await f.controller.command('endSession',{sessionId:f.id});
  await vi.waitFor(()=> {
    for(const kind of ['update','cleanup']) expect(f.calls.filter(k=>k===kind)).toHaveLength(2);
    expect(f.store.memoryCandidate(f.id)?.state).toBe('failed');
  });
  for(const kind of ['update','cleanup']) {
    const bodies = f.bodies.filter(b=>b.kind===kind).map(b=>b.body); expect(bodies[1]).toEqual(bodies[0]);
  }
  recover = true; await f.controller.command('continueEnd',{sessionId:f.id});
  await vi.waitFor(()=>expect(f.store.endBlocker()).toBeNull());
  expect(updateCalls).toBe(2);
  for(const kind of ['cleanup']) expect(f.calls.filter(k=>k===kind)).toHaveLength(3);
});

it('manual grammar runs only on explicit action after end completion and never regenerates success', async()=>{
  const f=fixture(async(kind,body)=>valid(kind,body));
  await f.controller.command('endSession',{sessionId:f.id});await vi.waitFor(()=>expect(f.store.endBlocker()).toBeNull());
  expect(f.calls).toEqual(['update']);expect(f.store.session(f.id).grammar_config).toBeNull();
  await f.controller.command('retryAnalysis',{sessionId:f.id});await vi.waitFor(()=>expect(f.store.session(f.id).analysis_state).toBe('completed'));
  expect(f.calls).toEqual(['update','grammar']);expect(f.store.endBlocker()).toBeNull();
  await f.controller.command('retryAnalysis',{sessionId:f.id});expect(f.calls).toHaveLength(2);
  f.reopen();await f.controller.initialize();expect(f.calls).toHaveLength(2);expect(f.store.view(f.id).units).toHaveLength(1);
});
it('manual grammar failure does not retry automatically or block memory; explicit retry uses frozen settings',async()=>{
  let fail=true;const f=fixture(async(kind,body)=>kind==='grammar'&&fail?'bad json':valid(kind,body));
  await f.controller.command('endSession',{sessionId:f.id});await vi.waitFor(()=>expect(f.store.endBlocker()).toBeNull());
  await f.controller.command('retryAnalysis',{sessionId:f.id});await vi.waitFor(()=>expect(f.store.session(f.id).analysis_state).toBe('failed'));
  expect(f.calls.filter(k=>k==='grammar')).toHaveLength(1);expect(f.store.endBlocker()).toBeNull();
  const config=f.store.session(f.id).grammar_config;
  fail=false;await f.controller.command('retryAnalysis',{sessionId:f.id});await vi.waitFor(()=>expect(f.store.session(f.id).analysis_state).toBe('completed'));
  expect(f.calls.filter(k=>k==='grammar')).toHaveLength(2);expect(f.store.session(f.id).grammar_config).toBe(config);
});
it('manual grammar can be cancelled and retried even when end processing was cancelled',async()=>{
  let hold=true;const f=fixture(async(kind,body,signal)=>{
    if(kind==='grammar'&&hold)await new Promise<void>((_r,j)=>signal.addEventListener('abort',()=>j(new AppFailure('request_cancelled'))));
    return valid(kind,body);
  });
  f.store.end(f.id);f.store.cancelEnd(f.id);
  await f.controller.command('retryAnalysis',{sessionId:f.id});await vi.waitFor(()=>expect(f.calls).toEqual(['grammar']));
  await f.controller.command('cancelAnalysis',{sessionId:f.id});expect(f.store.session(f.id).analysis_state).toBe('failed');expect(f.store.endBlocker()).toBeNull();
  hold=false;await f.controller.command('retryAnalysis',{sessionId:f.id});await vi.waitFor(()=>expect(f.store.session(f.id).analysis_state).toBe('completed'));
});

it('recovers a durable grammar response locally without credentials or new inference',async()=>{
  const f=fixture(async(kind,body)=>valid(kind,body));f.store.end(f.id);f.store.cancelEnd(f.id);
  const a=f.store.createRequest(f.id,'grammar',grammarSnapshot());f.store.dispatch(a.id);
  const content=JSON.stringify({units:[{index:0,corrected_text:'I like quiet museums.',explanation:''}]});
  f.store.receiveEndResponse(f.id,'grammar',a.id,content,{usage:{cost:0.01}});
  f.reopen();f.settings.keyPresent=false;
  await f.controller.command('retryAnalysis',{sessionId:f.id});
  expect(f.store.session(f.id).analysis_state).toBe('completed');expect(f.calls).toEqual([]);
  await f.controller.command('retryAnalysis',{sessionId:f.id});expect(f.calls).toEqual([]);
});
