import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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
    const kind = body.model.startsWith('qwen/') ? 'cleanup' : body.response_format?.json_schema.name === 'stomylos_memory_delta_v1' ? 'update' : body.response_format ? 'grammar' : 'starter';
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
  if (kind === 'update') return '{"operations":[]}';
  if (kind === 'starter') return 'What would you like to explore?\nHow would you describe a favorite place?';
  return JSON.stringify({ units: JSON.parse(body.messages[1].content).filter((m: Json) => m.role === 'user').map((m: Json) => ({ text: m.content, corrected_text: m.content, explanation: '' })) });
}
it('runs three independent branches with no intention calls and gates until all complete', async () => {
  let release!: () => void;
  const f = fixture(async (kind, body) => { if (kind === 'update') await new Promise<void>(r => release = r); return valid(kind, body); });
  await f.controller.command('endSession', { sessionId: f.id });
  await vi.waitFor(() => expect(f.calls.sort()).toEqual(['grammar','starter','update']));
  await vi.waitFor(() => expect(f.store.session(f.id).analysis_state).toBe('completed'));
  expect(f.store.view(f.id).renewal?.state).toBe('completed');
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
  const grammar = f.store.createRequest(f.id, 'grammar', JSON.parse(f.store.session(f.id).grammar_config!));
  f.store.dispatch(grammar.id);
  const learner = f.store.messages(f.id).find(m => m.origin === 'learner')!;
  f.store.saveAnalysis(grammar.id, JSON.stringify({ units: [{text: learner.content, corrected_text: learner.content, explanation: ''}] }), {});
  const starter = f.store.retryStarter(f.id, 'starter-op'); f.store.dispatchStarter(starter.id);
  f.store.saveStarter(starter.id, valid('starter', {}), {});
  const update = f.store.prepareMemory(f.id, 'update-op'); f.store.dispatchMemory(update.id);
  const content = JSON.stringify({ operations: [{ op:'add', id:null, category:'traits', text:'x'.repeat(31000), source_message_ids:[learner.id] }] });
  f.store.saveMemory(update.id, content, {});
  expect(f.store.saveMemory(update.id, content, {}).traits[0].text.length).toBe(31000);
  const cleanup = f.store.prepareCleanup(f.id, 'cleanup-op'); f.store.dispatchCleanup(cleanup.id);
  f.store.receiveCleanup(cleanup.id, 'Traits\nLikes quiet museums.\nRelationships\nExperiences\nIntentions', {});
  f.reopen(); await f.controller.initialize();
  f.settings.keyPresent = false;
  await f.controller.command('continueEnd', { sessionId: f.id });
  expect(f.calls).toEqual([]);
  expect(f.store.endBlocker()).toBeNull();
  expect(f.store.currentMemory().traits[0].text).toBe('Likes quiet museums.');
});

it('gives all four stages independent same-input retries and never reruns a successful updater', async () => {
  let updateCalls = 0, recover = false;
  const f = fixture(async (kind, body) => {
    if (kind === 'update') {
      if (++updateCalls === 1) return 'invalid';
      const packet = JSON.parse(body.messages[1].content);
      return JSON.stringify({operations:[{op:'add',id:null,category:'traits',text:'x'.repeat(31000),source_message_ids:[packet.session.messages.find((m: Json)=>m.origin==='learner').id]}]});
    }
    if (!recover) return 'invalid';
    return kind === 'cleanup' ? 'Traits\nKeeps useful detail.\nRelationships\nExperiences\nIntentions' : valid(kind,body);
  });
  await f.controller.command('endSession',{sessionId:f.id});
  await vi.waitFor(()=> {
    for(const kind of ['grammar','starter','update','cleanup']) expect(f.calls.filter(k=>k===kind)).toHaveLength(2);
    expect(f.store.memoryCandidate(f.id)?.state).toBe('failed');
  });
  for(const kind of ['grammar','starter','update','cleanup']) {
    const bodies = f.bodies.filter(b=>b.kind===kind).map(b=>b.body); expect(bodies[1]).toEqual(bodies[0]);
  }
  recover = true; await f.controller.command('continueEnd',{sessionId:f.id});
  await vi.waitFor(()=>expect(f.store.endBlocker()).toBeNull());
  expect(updateCalls).toBe(2);
  for(const kind of ['grammar','starter','cleanup']) expect(f.calls.filter(k=>k===kind)).toHaveLength(3);
});
