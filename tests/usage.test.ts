import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { UsageStore, reportedMoney, usageMonth } from '../src/main/usage-store';
import { budgetState, displayMoney, sumMoney } from '../src/shared/usage';
import { validateCommand } from '../src/main/ipc';
import { OpenRouter } from '../src/main/transport';
import { SpeechTransport } from '../src/main/tts';
import { previewSource } from '../src/shared/voice';
import { AsrTransport } from '../src/main/asr-transport';
import { DictationEncoder } from '../src/main/asr-encoder';
import { Store } from '../src/main/database';
import { exportBackup, prepareBackup, installBackup } from '../src/main/backup';

let directory: string, now: Date, store: UsageStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stomylos-usage-'));
  now = new Date('2026-09-10T01:00:00Z');
  store = new UsageStore(directory, () => undefined, () => now, 'Asia/Seoul');
});
afterEach(() => { store.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });
const add = (cost?: number) => { const id = store.begin(); store.report(id, cost); return id; };
const identity = { allowed_models: ['test'], provider: 'Provider' };
const response = (cost: number, reason = 'stop') => ({ id: 'synthetic', model: 'test', provider: 'Provider', choices: [{ finish_reason: reason, message: { content: 'test' } }], usage: { cost } });
const signal = () => new AbortController().signal;

it('sums dispatches exactly, replaces observations, counts retries and unknowns, and never adds bundle components', () => {
  const id = add(.12); store.report(id, .12); store.report(id, .12);
  for (const cost of [.03, .1, .01, .002, .003, .04, .06, .02, .015, .004, .006, .2, .05, 0, .007]) add(cost);
  add(); add();
  expect(store.snapshot()).toMatchObject({ total: '0.667', reported: '0.667', estimated: '0', requests: 18, unreported: 2 });
  store.report(id, .11); expect(store.snapshot().total).toBe('0.657');
  expect(sumMoney(['0.0000004', '0.0000004'])).toBe('0.0000008');
  expect(displayMoney('0.0000008')).toBe('<$0.01');
  expect(displayMoney('1.005')).toBe('$1.01');
  expect(reportedMoney(1e-7)).toBe('0.0000001');
  for (const bad of [null, undefined, '0.1', NaN, Infinity, -1]) expect(reportedMoney(bad)).toBeNull();
});

it('attributes delayed reports to dispatch month and freezes timezone through restart and rollover', () => {
  now = new Date('2026-08-31T14:59:59.999Z'); add(.01);
  now = new Date('2026-08-31T15:00:00Z'); add(.02);
  now = new Date('2026-09-30T14:59:59.999Z'); const late = add();
  store.setBudget('1.00');
  now = new Date('2026-09-30T15:00:00Z'); add(.04); store.report(late, .03);
  expect(store.snapshot()).toMatchObject({ total: '0.04', month: '2026-10', budget: '1.00' });
  store.close(); store = new UsageStore(directory, () => undefined, () => now, 'America/New_York');
  expect(store.snapshot().timeZone).toBe('Asia/Seoul');
  now = new Date('2026-09-29T00:00:00Z'); expect(store.snapshot().total).toBe('0.05');
  expect(usageMonth(new Date('2026-04-01T03:59:59Z'), 'America/New_York')).toBe('2026-03');
  expect(usageMonth(new Date('2026-04-01T04:00:00Z'), 'America/New_York')).toBe('2026-04');
});

it('replaces estimates with reported zero or cost without changing the charge count', () => {
  const id = store.begin({ amount: '0.025', basis: 'synthetic' }); add(.767);
  expect(store.snapshot()).toMatchObject({ total: '0.792', estimated: '0.025', estimatedRequests: 1, unreported: 0 });
  store.report(id, .018); store.report(id, .018);
  expect(store.snapshot()).toMatchObject({ total: '0.785', reported: '0.785', estimated: '0', requests: 2 });
  store.report(id, 0); expect(store.snapshot()).toMatchObject({ total: '0.767', estimated: '0', unreported: 0 });
});

it('uses exact warning boundaries and persists budget edits without changing costs', () => {
  for (const [amount, level] of [['0.799999', 'below'], ['0.8', 'near'], ['0.800001', 'near'], ['0.999999', 'near'], ['1', 'reached'], ['1.000001', 'reached']] as const)
    expect(budgetState(amount, '1').level).toBe(level);
  expect(budgetState('0.799999', '1').percent).toBe('79.9');
  expect(budgetState('0.999999', '1').percent).toBe('99.9');
  add(.8); expect(store.setBudget('1.00').level).toBe('near');
  expect(store.setBudget('0.50').level).toBe('reached');
  expect(store.setBudget('2.00').level).toBe('below');
  expect(store.setBudget(null)).toMatchObject({ total: '0.8', level: 'off' });
  for (const amount of ['0', '-1', 'NaN', '1.001', '', '1e2', 10]) {
    expect(() => validateCommand('usageBudget', { amount })).toThrow();
    expect(() => store.setBudget(amount as string)).toThrow();
  }
  expect(() => validateCommand('usageBudget', { amount: '1', extra: true })).toThrow();
  expect(() => validateCommand('usageSnapshot', {})).toThrow();
  validateCommand('usageSnapshot', undefined);
});

it('captures complete and failed chat-family responses with one charge per actual call, including above budget', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(response(.04, 'length')))
    .mockResolvedValueOnce(Response.json(response(.06)));
  vi.stubGlobal('fetch', fetch);
  const gateway = new OpenRouter(() => 'synthetic-key', 'http://127.0.0.1/not-called', store);
  store.setBudget('0.01');
  await expect(gateway.complete({ model: 'test' }, identity, signal(), 1000)).rejects.toThrow('response_incomplete');
  await gateway.complete({ model: 'test' }, identity, signal(), 1000);
  expect(store.snapshot()).toMatchObject({ total: '0.1', requests: 2, unreported: 0, level: 'reached' });
  expect(fetch).toHaveBeenCalledTimes(2);
  await expect(new OpenRouter(() => null, undefined, store).complete({}, identity, signal(), 1000)).rejects.toThrow('api_key_missing');
  await expect(gateway.complete({}, identity, AbortSignal.abort(), 1000)).rejects.toThrow('request_cancelled');
  expect(store.snapshot().requests).toBe(2);
});

it('records streaming usage once even on interruption and bundled search, and missing usage stays unknown', async () => {
  const event = (raw: object) => `data: ${JSON.stringify(raw)}\n\n`;
  const stream = event({ model: 'test', choices: [{ delta: { content: 'Hi' }, finish_reason: null }],
    usage: { cost: .12, cost_details: { upstream_inference_cost: .08, upstream_inference_prompt_cost: .06, upstream_inference_completions_cost: .02 } } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(stream + stream)).mockRejectedValueOnce(new Error('network')));
  const gateway = new OpenRouter(() => 'synthetic', undefined, store);
  await expect(gateway.stream({ model: 'test' }, signal(), () => undefined)).rejects.toThrow('stream_incomplete');
  await expect(gateway.stream({ model: 'test' }, signal(), () => undefined)).rejects.toThrow();
  expect(store.snapshot()).toMatchObject({ total: '0.12', requests: 2, unreported: 1 });
});

it('estimates TTS full input with tags and Unicode exactly once per generation, not pre-dispatch cancellation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } })));
  const tts = new SpeechTransport(() => 'synthetic', undefined, undefined, undefined, undefined, store);
  await tts.generate({ ...previewSource, content: 'A😀' }, signal());
  // 12 prefix code points? [long-pause] is 12, plus A and one emoji = 14.
  expect('[long-pause]'.length).toBe(12);
  expect(store.snapshot()).toMatchObject({ reported: '0', estimated: '0.00021', requests: 1, estimatedRequests: 1, unreported: 0 });
  await expect(tts.generate(previewSource, AbortSignal.abort())).rejects.toThrow('speech_cancelled');
  expect(store.snapshot().requests).toBe(1);
});

it('captures ASR returned costs but keeps transport failures unknown', async () => {
  const encoder = await DictationEncoder.create(); encoder.push(0, new Int16Array([1000, -1000, 0]), true);
  const audio = encoder.finish();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ text: 'Hi', usage: { cost: .003 } }))
    .mockRejectedValueOnce(new Error('network')));
  const asr = new AsrTransport(() => 'synthetic', undefined, undefined, undefined, store);
  await asr.transcribe(audio, signal());
  await expect(asr.transcribe(audio, signal())).rejects.toThrow();
  expect(store.snapshot()).toMatchObject({ reported: '0.003', requests: 2, unreported: 1 });
});

it('keeps device cost and budget through actual chat deletion and history backup restore without exporting them', async () => {
  const native = resolve('native/advisory-lock.node'), source = join(directory, 'backup-source');
  const original = new Store(source, native); original.createSession(); original.close();
  const file = join(directory, 'test.stomylos-backup'); await exportBackup(source, file, '0.1.0');
  const db = new Store(directory, native); const session = db.createSession();
  db.end(session.id); db.deleteSession(session.id); db.close();
  add(.2); store.setBudget('10');
  const prepared = await prepareBackup(directory, file);
  await installBackup(directory, prepared.directory);
  expect(store.snapshot()).toMatchObject({ total: '0.2', budget: '10' });
  const exported = join(directory, '..', `usage-export-${Date.now()}.stomylos-backup`);
  try {
    await exportBackup(directory, exported, '0.1.0');
    const preparedAgain = await prepareBackup(source, exported);
    expect(preparedAgain).toBeTruthy();
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(preparedAgain.directory, 'usage.sqlite3'))).toBe(false);
  } finally { rmSync(exported, { force: true }); }
  expect(statSync(join(directory, 'usage.sqlite3')).mode & 0o777).toBe(0o600);
});

it('does not silently reset an invalid ledger or block generation when accounting storage fails', async () => {
  store.close(); const path = join(directory, 'usage.sqlite3'); writeFileSync(path, 'not-a-database');
  store = new UsageStore(directory); expect(() => store.snapshot()).toThrow('usage_unavailable');
  const before = readFileSync(path);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response(.1))));
  await new OpenRouter(() => 'synthetic', undefined, store).complete({ model: 'test' }, identity, signal(), 1000);
  expect(readFileSync(path)).toEqual(before);
});
