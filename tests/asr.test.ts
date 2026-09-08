import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DictationController } from '../src/main/asr';
import { DictationEncoder } from '../src/main/asr-encoder';
import { DictationStore } from '../src/main/asr-store';
import { AsrTransport, type AsrGateway, type AsrResult } from '../src/main/asr-transport';
import { ASR } from '../src/shared/asr';
import { validateCommand } from '../src/main/ipc';
import type { CaptureEncoder } from '../src/main/asr-worker-client';

const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(folders.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture(gateway?: AsrGateway, wrap?: (encoder: CaptureEncoder) => Promise<CaptureEncoder>) {
  const folder = await mkdtemp(join(tmpdir(), 'stomylos-asr-')); folders.push(folder);
  const store = new DictationStore(folder), locks: boolean[] = [];
  const call = vi.fn(async (): Promise<AsrResult> => ({ text: '  um, I goes there.\n한국어도요.  ', generationId: 'gen-test', usage: { cost: .001 } }));
  const controller = new DictationController(store, gateway ?? { transcribe: call }, async () => {
    const encoder = await DictationEncoder.create();
    const capture: CaptureEncoder = { push: async (sequence, pcm) => encoder.push(sequence, pcm, true), finish: async () => encoder.finish(), discard: async () => encoder.discard() };
    return wrap ? wrap(capture) : capture;
  }, () => undefined, value => locks.push(value));
  await controller.initialize();
  const id = randomUUID();
  const begin = () => controller.begin(id, 'session-one', 3, 'Original\n');
  const record = () => controller.snapshot().records.find(r => r.id === id)!;
  const finish = async (reason: 'manual' | 'time' = 'manual') => {
    await begin(); await controller.push(id, 0, new Int16Array([32767, -32768, 100, 0, -100])); await controller.finish(id, reason);
  };
  return { folder, store, controller, call, locks, id, begin, finish, record };
}
describe('dictation cancellation, durability and provenance', () => {
  it('discards an encoder that finishes opening after recording cancellation', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const discarded = vi.fn();
    let opening = false;
    const f = await fixture(undefined, async encoder => {
      opening = true; await gate;
      return { ...encoder, discard: async () => { discarded(); await encoder.discard(); } };
    });
    const begin = f.begin(); await vi.waitFor(() => expect(opening).toBe(true));
    await f.controller.cancel(f.id, true); release(); await begin;
    expect(discarded).toHaveBeenCalledTimes(1); expect(f.controller.permissionAllowed).toBe(false);
    expect(f.controller.locked).toBe(false); expect(f.call).not.toHaveBeenCalled();
    expect(f.record().discarded).toBe(true); expect(f.record().phase).toBe('cancelled');
  });
  it('cancel wins against duplicate delayed finalization without reviving audio in another session', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const finishing = vi.fn();
    const f = await fixture(undefined, async encoder => ({ ...encoder, finish: async () => {
      finishing(); await gate; return encoder.finish();
    } }));
    await f.begin(); await f.controller.push(f.id, 0, new Int16Array(300));
    const first = f.controller.finish(f.id, 'manual');
    const duplicate = f.controller.finish(f.id, 'manual');
    await f.controller.cancel(f.id, true);
    await f.controller.context('another-session');
    release(); await Promise.all([first, duplicate]);
    expect(finishing).toHaveBeenCalledTimes(1); expect(f.call).not.toHaveBeenCalled();
    expect(f.controller.snapshot().audioId).toBeNull(); expect(f.controller.locked).toBe(false);
    await f.controller.context('session-one');
    const saved = f.controller.snapshot().records.find(r => r.id === f.id)!;
    expect(saved.phase).toBe('cancelled'); expect(saved.discarded).toBe(true);
    expect(saved.attempts).toEqual([]); expect(f.locks.at(-1)).toBe(false);
  });
  it('cancels a recording without a request or durable audio', async () => {
    const f = await fixture(); await f.begin();
    expect(f.controller.permissionAllowed).toBe(true);
    await f.controller.push(f.id, 0, new Int16Array(300));
    await f.controller.cancel(f.id, true);
    expect(f.record().phase).toBe('cancelled'); expect(f.record().attempts).toEqual([]);
    expect(f.call).not.toHaveBeenCalled(); expect(f.controller.permissionAllowed).toBe(false);
    expect(f.locks.at(-1)).toBe(false); expect(() => f.controller.audio(f.id)).toThrow();
    expect(await readdir(join(f.folder, 'asr'))).toEqual([f.id + '.json']);
    expect((await stat(join(f.folder, 'asr', f.id + '.json'))).mode & 0o777).toBe(0o600);
  });
  it('preserves a limit-stopped clip and requires an explicit transcription call', async () => {
    const f = await fixture(); await f.finish('time');
    expect(f.record().phase).toBe('ready'); expect(f.record().stopReason).toBe('time');
    expect(f.controller.audio(f.id).length).toBeGreaterThan(42); expect(f.call).not.toHaveBeenCalled();
    await f.controller.transcribe(f.id);
    await vi.waitFor(() => expect(f.record().phase).toBe('complete'));
    expect(f.record().text).toBe('  um, I goes there.\n한국어도요.  ');
    expect(f.record().inserted).toBeUndefined(); expect(f.record().submitted).toBeUndefined();
    const saved = JSON.parse(await readFile(join(f.folder, 'asr', f.id + '.json'), 'utf8'));
    expect(saved.text).toBe(f.record().text); expect(saved.attempts[0].generationId).toBe('gen-test');
  });
  it('persists the dispatch ledger before network and rejects duplicate dispatch', async () => {
    let release!: (v: AsrResult) => void;
    const network = new Promise<AsrResult>(resolve => { release = resolve; });
    const call = vi.fn(async () => {
      const saved = JSON.parse(await readFile(join(f.folder, 'asr', f.id + '.json'), 'utf8'));
      expect(saved.phase).toBe('transcribing'); expect(saved.attempts).toHaveLength(1);
      return network;
    });
    const f = await fixture({ transcribe: call }); await f.finish();
    await f.controller.transcribe(f.id);
    await expect(f.controller.transcribe(f.id)).rejects.toThrow('asr_not_ready');
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    release({ text: 'one' }); await vi.waitFor(() => expect(f.record().phase).toBe('complete'));
  });
  it('ignores a late successful response after cancellation', async () => {
    let release!: (v: AsrResult) => void, signal!: AbortSignal;
    const call = vi.fn((_bytes: Uint8Array, s: AbortSignal) => { signal = s; return new Promise<AsrResult>(done => { release = done; }); });
    const f = await fixture({ transcribe: call }); await f.finish(); await f.controller.transcribe(f.id);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    const cancelling = f.controller.cancel(f.id, false); expect(signal.aborted).toBe(true);
    release({ text: 'must not appear', usage: { cost: .002 } }); await cancelling;
    expect(f.record().phase).toBe('cancelled'); expect(f.record().text).toBeUndefined();
    expect(f.record().attempts[0].usage).toEqual({ cost: .002 });
    expect(f.controller.audio(f.id).length).toBeGreaterThan(42);
  });
  it('does not upload when the dispatch record cannot be saved', async () => {
    const f = await fixture(); await f.finish();
    vi.spyOn(f.store, 'save').mockRejectedValueOnce(new Error('disk full'));
    await f.controller.transcribe(f.id); await vi.waitFor(() => expect(f.record().phase).toBe('failed'));
    expect(f.call).not.toHaveBeenCalled(); expect(f.record().error).toBe('asr_save_required');
  });
  it('retries saving a result without another model call and recovers exact text', async () => {
    const f = await fixture(); await f.finish(); const save = f.store.save.bind(f.store); let fail = true;
    vi.spyOn(f.store, 'save').mockImplementation(record => {
      if (record.phase === 'complete' && fail) { fail = false; return Promise.reject(new Error('disk full')); }
      return save(record);
    });
    await f.controller.transcribe(f.id); await vi.waitFor(() => expect(f.record().phase).toBe('save_pending'));
    expect(f.record().text).toContain('I goes');
    await f.controller.retrySave(f.id); expect(f.record().phase).toBe('complete'); expect(f.call).toHaveBeenCalledTimes(1);
    const reopened = new DictationStore(f.folder); await reopened.initialize(); expect(reopened.records.size).toBe(0); await reopened.loadSession('session-one');
    expect(reopened.records.get(f.id)?.text).toBe(f.record().text);
    expect(reopened.records.get(f.id)?.submitted).toBeUndefined();
  });
  it('links only explicitly named dictation to the committed message ID', async () => {
    const f = await fixture(); await f.finish(); await f.controller.transcribe(f.id);
    await vi.waitFor(() => expect(f.record().phase).toBe('complete'));
    await f.controller.inserted(f.id, 'session-one', 4, 'Original\n' + f.record().text);
    await f.controller.submitted('another-session', [f.id], 'wrong-message', 'same text');
    expect(f.record().submitted).toBeUndefined();
    await f.controller.submitted('session-one', [randomUUID()], 'unrelated-message', 'same text');
    expect(f.record().submitted).toBeUndefined();
    await f.controller.submitted('session-one', [f.id], 'actual-committed-message', 'Edited by learner');
    expect(f.record().submitted?.messageId).toBe('actual-committed-message');
    expect(f.record().submitted?.edited).toBe(true); expect(f.record().text).toContain('I goes');
  });
  it('quarantines corrupt metadata and labels unfinished work without replay', async () => {
    const f = await fixture(); await f.finish();
    await writeFile(join(f.folder, 'asr', randomUUID() + '.json'), '{broken');
    const reopened = new DictationStore(f.folder); await reopened.initialize(); expect(reopened.records.size).toBe(0); await reopened.loadSession('session-one');
    expect(reopened.warning).toBe('asr_record_unavailable');
    expect(reopened.records.get(f.id)?.phase).toBe('interrupted');
    expect(reopened.records.get(f.id)?.error).toBe('asr_audio_not_retained'); expect(f.call).not.toHaveBeenCalled();
  });
});

describe('ASR request boundary', () => {
  it.each([
    [401, 'application/json', '{"error":"unauthorized"}', 'asr_http_401'],
    [429, 'application/json', '{"error":"rate limited"}', 'asr_http_429'],
    [200, 'text/html', '<html>gateway error</html>', 'asr_invalid_response'],
    [200, 'application/json', '{broken', 'asr_invalid_response'],
    [200, 'application/json', '{"text":null}', 'asr_invalid_response']
  ])('rejects status %i / %s invalid response without retry', async (status, contentType, body, code) => {
    const f = await fixture(); await f.finish();
    const fetch = vi.fn(async () => new Response(body, { status, headers: { 'content-type': contentType, 'x-generation-id': 'failed-generation' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(new AsrTransport(() => 'test-key').transcribe(f.controller.audio(f.id), new AbortController().signal))
      .rejects.toMatchObject({ code, generationId: 'failed-generation' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('sends the selected model and FLAC without invented options, retaining raw text', async () => {
    const f = await fixture(); await f.finish();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: ' um, I goes. ', usage: { cost: .01 } }), { headers: { 'content-type': 'application/json', 'x-generation-id': 'gen-a' } }));
    vi.stubGlobal('fetch', fetch);
    const result = await new AsrTransport(() => 'test-key').transcribe(f.controller.audio(f.id), new AbortController().signal);
    const args = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(args[0]).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(JSON.parse(args[1].body as string)).toEqual({ model: ASR.model, input_audio: { format: 'flac', data: Buffer.from(f.controller.audio(f.id)).toString('base64') } });
    expect(args[1].redirect).toBe('error'); expect(result.text).toBe(' um, I goes. '); expect(result.generationId).toBe('gen-a');
  });
  it('rejects cancelled, oversized and invalid-rate inputs before fetch', async () => {
    const f = await fixture(); await f.finish(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const transport = new AsrTransport(() => 'test-key'), abort = new AbortController(); abort.abort();
    await expect(transport.transcribe(f.controller.audio(f.id), abort.signal)).rejects.toThrow('asr_cancelled');
    await expect(transport.transcribe(new Uint8Array(ASR.audioBytes + 1), new AbortController().signal)).rejects.toThrow('asr_audio_size');
    const wrong = Buffer.from(f.controller.audio(f.id)); wrong[18] = 0xff;
    await expect(transport.transcribe(wrong, new AbortController().signal)).rejects.toThrow('asr_invalid_audio'); expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds responses and times out a stalled request without retry', async () => {
    const f = await fixture(); await f.finish();
    const fetch = vi.fn(async () => new Response('too big', { headers: { 'content-type': 'application/json', 'content-length': String(ASR.responseBytes + 1) } }));
    vi.stubGlobal('fetch', fetch);
    await expect(new AsrTransport(() => 'test').transcribe(f.controller.audio(f.id), new AbortController().signal)).rejects.toThrow('asr_response_size');
    vi.stubGlobal('fetch', vi.fn((_url: string, args: RequestInit) => new Promise((_resolve, reject) => args.signal?.addEventListener('abort', () => reject(new Error('aborted'))))));
    await expect(new AsrTransport(() => 'test', 'http://127.0.0.1/unused', 5).transcribe(f.controller.audio(f.id), new AbortController().signal)).rejects.toThrow('asr_timeout');
  });
  it('allows only bounded typed IPC chunks and explicit IDs', () => {
    const id = randomUUID();
    expect(() => validateCommand('asrChunk', { id, sequence: 0, pcm: new Int16Array(8000) })).not.toThrow();
    for (const args of [{ id, sequence: 0, pcm: new Float32Array(3) }, { id, sequence: 0, pcm: new Int16Array(8001) }, { id: '../secret', sequence: 0, pcm: new Int16Array(2) }, { id, sequence: 0, pcm: new Int16Array(2), path: '/secret' }]) expect(() => validateCommand('asrChunk', args)).toThrow();
    expect(() => validateCommand('sendMessage', { sessionId: 'one', revision: 1, text: 'Hi', dictationIds: [id, id] })).toThrow();
  });
});

it('deletes only the selected chat transcription and drops in-memory audio and retry state', async () => {
  const f = await fixture(); await f.finish();
  const other = { ...f.record(), id: randomUUID(), sessionId: 'other-session' };
  await f.store.save(other); await f.controller.deleteSession('session-one');
  expect(f.controller.snapshot().activeId).toBeNull(); expect(f.controller.snapshot().audioId).toBeNull();
  await expect(f.controller.retrySave(f.id)).rejects.toThrow('asr_record_missing');
  const reopened = new DictationStore(f.folder); await reopened.initialize(); await reopened.loadSession('session-one');
  expect([...reopened.records.values()]).toEqual([]); await reopened.loadSession('other-session');
  expect(reopened.records.get(other.id)?.sessionId).toBe('other-session');
  expect(await readdir(join(f.folder, 'asr'))).toEqual([other.id + '.json']);
  await f.controller.close();
});
