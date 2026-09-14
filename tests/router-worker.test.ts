import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'vite';
import { catalogCompatibility } from '../catalog-compat-plugin';
import { Coordinator } from '../src/main/coordinator';
import { DatabaseClient } from '../src/main/db-client';
import { routerSnapshot, routerBody } from '../src/main/contracts';
import { recoverRouter } from '../src/main/router-recovery';
import { AppFailure } from '../src/main/errors';
import type { Store } from '../src/main/database';
import type { Gateway } from '../src/main/transport';
import type { Json } from '../src/shared/types';

let bundle: string;
beforeAll(async () => {
  mkdirSync('test-results', { recursive: true });
  bundle = mkdtempSync(resolve('test-results/router-worker-'));
  await build({ configFile: false, plugins: [catalogCompatibility()], logLevel: 'silent',
    build: { ssr: resolve('src/main/db-worker.ts'), outDir: bundle, minify: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'worker.cjs' } } } });
}, 30000);
afterAll(() => { if (bundle) rmSync(bundle, { recursive: true, force: true }); });

it.each([false, true])('persists Auto routing through the real worker (fallback: %s)', async fallback => {
  const directory = mkdtempSync(join(tmpdir(), 'stomylos-router-worker-'));
  const db = new DatabaseClient(join(bundle, 'worker.cjs'), directory, resolve('native/advisory-lock.node'), () => {});
  try {
    await db.ready;
    const session = await db.call('createSession');
    await db.call('searchMode', session.id, 'off');
    await db.call('submit', session.id, 'Explain this idea.');
    const saved = JSON.parse((await db.call('session', session.id)).chat_config);
    const first = await db.call('createRequest', session.id, 'router', routerSnapshot(saved));
    const content = JSON.stringify(Object.fromEntries(saved.characters.map((c: Json) => [c.id, c.id === 'model_09' ? 2 : 1])));
    let calls = 0;
    const gateway = { complete: vi.fn(async () => {
      if (++calls === 1 && fallback) throw new AppFailure('request_timeout');
      return { content, metadata: {} };
    }), stream: vi.fn() } as Gateway;
    const result = await recoverRouter(first, saved, routerBody(session.starter_text, 'Explain this idea.', saved), {
      prepare: (id, body, identity) => db.call('prepareProvider', 'model', id, body, identity),
      dispatch: id => db.call('dispatch', id),
      finish: (...args: Parameters<Store['finishRecoveryRoute']>) => db.call('finishRecoveryRoute', ...args),
      secondary: id => db.call('prepareRouterRecovery', id, randomUUID())
    }, gateway, new AbortController().signal);
    await db.call('commitRoute', session.id, result.scores, result.failure, result.request.id);
    expect((await db.call('session', session.id)).character).toBe('model_09');
    const attempts = await db.call('requests', session.id);
    expect(attempts).toHaveLength(fallback ? 2 : 1);
    expect(attempts.at(-1)?.status).toBe('succeeded');
    const routed = JSON.parse((attempts.at(-1) as any).provider_request);
    expect(routed.body.provider).toEqual({ require_parameters: true, allow_fallbacks: true, data_collection: 'deny' });
    expect(routed.identity.provider).toBeNull();
    expect(JSON.parse(first.config).parameters.provider.only).toEqual(['openai']);
    if (fallback) expect(attempts[1].parent_id).toBe(first.id);
    expect(gateway.complete).toHaveBeenCalledTimes(fallback ? 2 : 1);
    expect((await db.call('integrity')).foreignKeys).toEqual([]);
    await expect((db.call as Function)('unsupportedTestOperation')).rejects.toThrow('database_operation_unsupported');
    expect((await db.call('session', session.id)).character).toBe('model_09');
  } finally {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('serves durable content-free Genie history through the shipped worker operations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stomylos-request-history-worker-'));
  let db = new DatabaseClient(join(bundle, 'worker.cjs'), directory, resolve('native/advisory-lock.node'), () => undefined);
  try {
    await db.ready;
    const session = await db.call('createSession');
    await db.call('genieRequestStart', 'genie-record', session.id, null, {model:'test-model',messages:[{content:'unsent private text'}]});
    await db.call('genieRequestFinish', 'genie-record', {usage:{cost:0.125}}, null);
    await db.close();
    db = new DatabaseClient(join(bundle, 'worker.cjs'), directory, resolve('native/advisory-lock.node'), () => undefined);
    await db.ready;
    const rows = await db.call('requestHistory', session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({kind:'Hyphantes',status:'succeeded',model:'test-model',metadata:{usage:{cost:0.125}}});
    expect(JSON.stringify(rows)).not.toContain('unsent private text');
    await expect(db.call('requestHistory', 'missing')).rejects.toThrow('session_not_found');
  } finally {
    await db.close(); rmSync(directory, {recursive:true,force:true});
  }
});


it.each([['send', true], ['send', false], ['retry', true], ['retry', false]] as const)(
  'completes %s through worker recall with Memory enabled=%s', async (kind, enabled) => {
  const directory = mkdtempSync(join(tmpdir(), 'stomylos-recall-worker-'));
  const db = new DatabaseClient(join(bundle, 'worker.cjs'), directory, resolve('native/advisory-lock.node'), () => {});
  let controller: Coordinator | undefined;
  try {
    await db.ready;
    if (!enabled) await db.call('setMemoryPreference', false, 0);
    const session = await db.call('createSession');
    await db.call('searchMode', session.id, 'off');
    await db.call('selectManual', session.id, 'model_01');
    const stream = vi.fn(async () => ({content:'Synthetic answer.', metadata:{}}));
    const complete = vi.fn(async () => { throw new Error('Unexpected provider operation'); });
    const query = vi.fn(async () => Array.from({length:384}, (_, i) => i === 0 ? 1 : 0));
    controller = new Coordinator(db, {stream,complete}, {keyPresent:true,keyPath:'',dataPath:directory,appVersion:'test',development:true}, () => {}, () => true);
    controller.cold = {query, async close(){}, wake(){}} as unknown as NonNullable<Coordinator['cold']>;
    const calls = vi.spyOn(db, 'call');
    if (kind === 'retry') {
      await db.call('submit', session.id, 'Synthetic question.');
      await controller.command('retryReply', {sessionId:session.id});
    } else await controller.command('sendMessage', {sessionId:session.id,text:'Synthetic question.',revision:0});
    await vi.waitFor(async () => expect((await db.call('messages', session.id)).at(-1)).toMatchObject({role:'assistant',delivery:'complete'}));
    expect((await controller.snapshot()).activity.error).toBeNull();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(calls.mock.calls.some(([method]) => method === 'associativeInput')).toBe(true);
    expect(calls.mock.calls.some(([method]) => method === 'associativeFromInput')).toBe(enabled);
    // Even Off must admit the second operation before its eligibility check.
    if (!enabled) expect(await db.call('associativeFromInput', session.id, 'missing', [])).toBeNull();
    if (enabled) {
      const saved = (await db.call('requests', session.id)).find(r => r.role === 'chat')!;
      expect(JSON.parse(saved.config).associative_recall.query_source).toBe('user_input');
      await vi.waitFor(async () => expect((await controller!.snapshot()).activity.phase).toBe('idle'));
      stream.mockRejectedValueOnce(new AppFailure('request_timeout'));
      await controller.command('sendMessage', {sessionId:session.id,text:'Second question.',revision:1});
      await vi.waitFor(async () => expect((await controller!.snapshot()).activity.error).toBe('request_timeout'));
      const failed = (await db.call('requests', session.id)).findLast(r => r.role === 'chat')!;
      const before = query.mock.calls.length;
      await controller.command('retryReply', {sessionId:session.id});
      await vi.waitFor(async () => expect((await db.call('messages', session.id)).at(-1)).toMatchObject({role:'assistant',delivery:'complete'}));
      const retried = (await db.call('requests', session.id)).findLast(r => r.role === 'chat')!;
      expect(retried.parent_id).toBe(failed.id);
      expect(JSON.parse(retried.config).associative_recall).toEqual(JSON.parse(failed.config).associative_recall);
      expect(query).toHaveBeenCalledTimes(before);
    }
  } finally {
    if (controller) await controller.command('close', undefined); else await db.close();
    rmSync(directory, {recursive:true,force:true});
  }
});

it.each([['associativeInput', 'reject'], ['associativeFromInput', 'reject'], ['associativeInput', 'stall'], ['associativeFromInput', 'stall']] as const)(
  'continues reply when %s experiences %s', async (failing, failure) => {
  const directory = mkdtempSync(join(tmpdir(), 'stomylos-recall-failure-'));
  const db = new DatabaseClient(join(bundle, 'worker.cjs'), directory, resolve('native/advisory-lock.node'), () => {});
  let controller: Coordinator | undefined;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await db.ready;
    const session = await db.call('createSession');
    await db.call('searchMode', session.id, 'off');
    await db.call('selectManual', session.id, 'model_01');
    const original = db.call.bind(db);
    vi.spyOn(db, 'call').mockImplementation(((method: any, ...args: any[]) => {
      if (method === failing) return failure === 'stall' ? new Promise(() => {}) : Promise.reject(new AppFailure('database_operation_unsupported'));
      return (original as Function)(method, ...args);
    }) as typeof db.call);
    const stream = vi.fn(async () => ({content:'Synthetic answer.',metadata:{}}));
    controller = new Coordinator(db, {stream,complete:vi.fn()}, {keyPresent:true,keyPath:'',dataPath:directory,appVersion:'test',development:true}, () => {}, () => true);
    controller.cold = {query:async()=>Array.from({length:384}, (_, i)=>i===0?1:0),async close(){},wake(){}} as unknown as NonNullable<Coordinator['cold']>;
    await controller.command('sendMessage', {sessionId:session.id,text:'Private synthetic input.',revision:0});
    await vi.waitFor(async () => expect((await db.call('messages', session.id)).at(-1)).toMatchObject({role:'assistant',delivery:'complete'}), {timeout:2500});
    if (failure === 'reject') expect(warning).toHaveBeenCalledWith('Associative recall unavailable:', 'database_operation_unsupported');
    else expect(warning).not.toHaveBeenCalled();
    expect(JSON.stringify(warning.mock.calls)).not.toContain('Private synthetic input.');
    expect(stream).toHaveBeenCalledTimes(1);
    expect((await controller.snapshot()).activity.error).toBeNull();
  } finally {
    if (controller) await controller.command('close', undefined); else await db.close();
    warning.mockRestore();
    rmSync(directory, {recursive:true,force:true});
  }
});
