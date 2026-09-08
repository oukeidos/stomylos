import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpeechStore, speechKey } from '../src/main/speech-store';
import { SpeechController, SpeechTransport, speechBody } from '../src/main/tts';
import type { Message, AppEvent } from '../src/shared/types';
import { validateCommand } from '../src/main/ipc';
const message: Message = { id: 'message-1', session_id: 'session-1', sequence: 1, role: 'assistant', origin: 'model', delivery: 'complete', content: '  Hello 🌍.\nHow are you?  ', request_id: 'request-1' };
const audio = new Uint8Array([73, 68, 51, 1, 2, 3]);
async function fixture(generate = vi.fn(async () => ({ bytes: audio, elapsedMs: 10, generationId: 'public-test' }))) {
  const dir = await mkdtemp(join(tmpdir(), 'stomylos-tts-'));
  const store = new SpeechStore(dir); const events: AppEvent[] = [];
  const controller = new SpeechController(store, { generate }, async (_s, id) => ({ ...message, id }), e => events.push(e));
  await controller.initialize(); controller.context(message.session_id, 1);
  return { dir, store, controller, events, generate };
}
describe('selected speech contract', () => {
  it('preserves source characters and prefixes exactly once without changing settings', () => {
    expect(speechBody(message)).toEqual({ model: 'x-ai/grok-voice-tts-1.0', voice: 'ara', speed: 1, response_format: 'mp3',
      provider: { only: ['xai'], order: ['xai'], allow_fallbacks: false, data_collection: 'deny' }, input: '[long-pause]' + message.content });
    expect(speechBody({ ...message, content: '[long-pause]Original' }).input).toBe('[long-pause][long-pause]Original');
    expect(speechBody({ ...message, content: '🌍'.repeat(14988) }).input).toHaveLength(29988);
    expect(() => speechBody({ ...message, content: '🌍'.repeat(14989) })).toThrow('speech_text_too_long');
    for (const change of [{ role: 'user' }, { delivery: 'streaming' }, { delivery: 'interrupted' }, { content: '' }])
      expect(() => speechBody({ ...message, ...change } as Message)).toThrow('speech_not_eligible');
  });
  it('validates command shape and rejects extra text/path fields', () => {
    validateCommand('speechListen', { sessionId: 's', messageId: 'm', token: 1, retry: false });
    for (const extra of [{ text: 'untrusted' }, { path: '/tmp/audio' }, { token: -1 }])
      expect(() => validateCommand('speechListen', { sessionId: 's', messageId: 'm', token: 1, retry: false, ...extra })).toThrow();
    expect(() => validateCommand('speechMode', { mode: 'anything' })).toThrow();
  });
});
describe('speech lifecycle and local state', () => {
  it('does not let a delayed streaming snapshot erase completed speech state', async () => {
    const f = await fixture();
    try {
      await f.controller.listen(message.session_id, message.id, 1); await f.controller.settled();
      const ready = (await f.controller.snapshot()).items;
      await f.controller.load([{ ...message, delivery: 'streaming', content: 'Partial' }]);
      expect((await f.controller.snapshot()).items).toEqual(ready);
      expect(f.generate).toHaveBeenCalledTimes(1);
    } finally { await f.controller.close(); await rm(f.dir, { recursive: true }); }
  });
  it('defaults manual, caches a manual request and replays after restart without a new call', async () => {
    const f = await fixture(); expect(f.store.mode).toBe('manual');
    await f.controller.completed(message); expect(f.generate).not.toHaveBeenCalled();
    await f.controller.listen(message.session_id, message.id, 1); await f.controller.settled();
    expect(f.generate).toHaveBeenCalledTimes(1);
    const item = (await f.controller.snapshot()).items[0]; expect(item.state).toBe('ready');
    expect(await f.controller.audio(item.audioId!)).toEqual(Buffer.from(audio));
    await f.controller.listen(message.session_id, message.id, 1); expect(f.generate).toHaveBeenCalledTimes(1);
    await f.controller.setMode('automatic'); await f.controller.close();
    const restored = new SpeechController(new SpeechStore(f.dir), { generate: f.generate }, async () => message, e => f.events.push(e));
    await restored.initialize(); expect((await restored.snapshot()).mode).toBe('automatic'); expect(f.generate).toHaveBeenCalledTimes(1);
    restored.context(message.session_id, 2); await restored.listen(message.session_id, message.id, 2); expect(f.generate).toHaveBeenCalledTimes(1);
    await restored.close(); await rm(f.dir, { recursive: true });
  });
  it('deduplicates simultaneous manual and automatic intents', async () => {
    const f = await fixture(); await f.controller.setMode('automatic');
    await Promise.all([f.controller.listen(message.session_id, message.id, 1), f.controller.completed(message), f.controller.listen(message.session_id, message.id, 1)]);
    await f.controller.settled(); expect(f.generate).toHaveBeenCalledTimes(1);
    await f.controller.close(); await rm(f.dir, { recursive: true });
  });
  it('stops late playback after navigation while retaining a complete result', async () => {
    let finish!: (result: any) => void;
    const f = await fixture(vi.fn(() => new Promise(resolve => { finish = resolve; })));
    await f.controller.listen(message.session_id, message.id, 1);
    await vi.waitFor(() => expect(finish).toBeDefined());
    f.controller.context('other-session', 2); finish({ bytes: audio, elapsedMs: 2 }); await f.controller.settled();
    expect(f.events.filter(e => e.type === 'speech-play')).toHaveLength(0);
    expect((await f.controller.snapshot()).items[0].state).toBe('ready');
    await f.controller.close(); await rm(f.dir, { recursive: true });
  });
  it('only automatic new model replies trigger and disabling does not cancel a manual request', async () => {
    const f = await fixture(); await f.controller.setMode('automatic');
    await f.controller.completed({ ...message, origin: 'starter' }); expect(f.generate).not.toHaveBeenCalled();
    await f.controller.completed(message); await f.controller.settled(); expect(f.generate).toHaveBeenCalledTimes(1);
    await f.controller.load([message]); expect(f.generate).toHaveBeenCalledTimes(1);
    await f.controller.setMode('manual'); expect(f.events.some(e => e.type === 'speech-stop' && e.automaticOnly)).toBe(true);
    await f.controller.close(); await rm(f.dir, { recursive: true });
  });
  it('fails independently and retries only on explicit request', async () => {
    const f = await fixture(vi.fn(async () => { throw new Error('simulated_network_failure'); }));
    await f.controller.listen(message.session_id, message.id, 1); await f.controller.settled();
    expect((await f.controller.snapshot()).items[0].state).toBe('failed');
    await f.controller.listen(message.session_id, message.id, 1); await f.controller.settled(); expect(f.generate).toHaveBeenCalledTimes(1);
    await f.controller.listen(message.session_id, message.id, 1, true); await f.controller.settled(); expect(f.generate).toHaveBeenCalledTimes(2);
    const attempts = f.store.get(message)!.attempts; expect(attempts[1].parentId).toBe(attempts[0].id);
    await f.controller.close(); await rm(f.dir, { recursive: true });
  });
  it('retains completed network bytes for save-only retry', async () => {
    const f = await fixture(); const complete = f.store.complete.bind(f.store);
    vi.spyOn(f.store, 'complete').mockRejectedValueOnce(new Error('disk full'));
    await f.controller.listen(message.session_id, message.id, 1); await f.controller.settled();
    expect((await f.controller.snapshot()).items[0].state).toBe('save_pending');
    f.store.complete = complete; await f.controller.retrySave(message.session_id, message.id);
    expect(f.generate).toHaveBeenCalledTimes(1); expect((await f.controller.snapshot()).items[0].state).toBe('ready');
    await f.controller.close(); await rm(f.dir, { recursive: true });
  });
  it('clears only audio, retains attempts and permits explicit regeneration', async () => {
    const f = await fixture(); await f.controller.listen(message.session_id, message.id, 1); await f.controller.settled();
    await f.controller.clear(); expect(await f.store.bytes()).toBe(0); expect(f.store.get(message)!.attempts[0].state).toBe('evicted');
    await f.controller.listen(message.session_id, message.id, 1); await f.controller.settled(); expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.store.get(message)!.attempts).toHaveLength(2); await f.controller.close(); await rm(f.dir, { recursive: true });
  });
  it('preserves invalid preference bytes and defaults off', async () => {
    const f = await fixture(); await writeFile(join(f.dir, 'preferences.json'), '{broken');
    const store = new SpeechStore(f.dir); await store.initialize(); expect(store.mode).toBe('manual');
    await expect(store.setMode('automatic')).rejects.toThrow('speech_preferences_invalid');
    expect(await readFile(join(f.dir, 'preferences.json'), 'utf8')).toBe('{broken'); await f.controller.close(); await rm(f.dir, { recursive: true });
  });
  it('keeps a manual request alive when automatic mode is disabled', async () => {
    let finish!: (value: any) => void; let signal!: AbortSignal;
    const generate = vi.fn(async (_message: Message, input: AbortSignal) => { signal = input; return new Promise<any>(resolve => { finish = resolve; }); });
    const f = await fixture(generate as any); await f.controller.setMode('automatic');
    await f.controller.listen(message.session_id, message.id, 1); await vi.waitFor(() => expect(finish).toBeDefined());
    await f.controller.setMode('manual'); expect(signal.aborted).toBe(false);
    finish({ bytes: audio, elapsedMs: 1 }); await f.controller.settled();
    expect(f.events.filter(e => e.type === 'speech-play')).toHaveLength(1);
    await f.controller.close(); await rm(f.dir, { recursive: true });
  });
  it('rejects a stale intent while the source lookup is pending', async () => {
    const f = await fixture(); let resolve!: (value: Message) => void;
    const c = new SpeechController(f.store, { generate: f.generate }, async () => new Promise<Message>(done => { resolve = done; }), e => f.events.push(e));
    c.context(message.session_id, 1); const pending = c.listen(message.session_id, message.id, 1);
    c.context('other-session', 2); resolve(message); await pending; await c.settled(); expect(f.generate).not.toHaveBeenCalled();
    await c.close(); await f.controller.close(); await rm(f.dir, { recursive: true });
  });
  it('preserves manual settings on write failure', async () => {
    const f = await fixture(); await writeFile(join(f.dir, 'preferences.json'), 'existing');
    // A directory at the target blocks atomic rename, independently of root permissions.
    await rm(join(f.dir, 'preferences.json')); const { mkdir } = await import('node:fs/promises'); await mkdir(join(f.dir, 'preferences.json'));
    await expect(f.store.setMode('automatic')).rejects.toThrow(); expect(f.store.mode).toBe('manual');
    await f.controller.close(); await rm(f.dir, { recursive: true });
  });
  it('recovers dispatched attempts without requests and refuses oversized cache reservations', async () => {
    const f = await fixture(); const { m, a } = await f.store.begin(message, 'manual'); a.dispatchedAt = new Date().toISOString(); await f.store.save(m);
    const restored = new SpeechStore(f.dir); await restored.initialize(); expect(restored.get(message)!.attempts[0].state).toBe('interrupted');
    const small = new SpeechStore(f.dir, 1); await small.initialize(); await expect(small.begin(message, 'manual')).rejects.toThrow('speech_cache_full');
    expect(speechKey({ ...message, content: message.content + 'changed' })).not.toBe(m.key);
    await f.controller.close(); await rm(f.dir, { recursive: true });
  });
});
describe('binary speech transport', () => {
  it('handles MP3 bytes and generation metadata without UTF-8 parsing', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(audio, { headers: { 'Content-Type': 'audio/mpeg', 'X-Generation-Id': 'sample' } }));
    try { const result = await new SpeechTransport(() => 'dummy').generate(message, new AbortController().signal); expect(result.bytes).toEqual(Buffer.from(audio)); expect(result.generationId).toBe('sample'); }
    finally { fetcher.mockRestore(); }
  });
  it('aborts on total timeout, idle timeout and cancellation without retry', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
      const signal = options!.signal!;
      if (signal.aborted) reject(new Error('aborted'));
      else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    try {
      await expect(new SpeechTransport(() => 'dummy', undefined, 10, 100).generate(message, new AbortController().signal)).rejects.toThrow('speech_timeout');
      await expect(new SpeechTransport(() => 'dummy', undefined, 100, 10).generate(message, new AbortController().signal)).rejects.toThrow('speech_idle_timeout');
      const abort = new AbortController(); const pending = new SpeechTransport(() => 'dummy').generate(message, abort.signal); abort.abort(); await expect(pending).rejects.toThrow('speech_cancelled');
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally { fetcher.mockRestore(); }
  });
  it('preserves generation identity on partial stream failure', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(audio); }, pull(controller) { controller.error(new Error('broken connection')); } });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { headers: { 'Content-Type': 'audio/mpeg', 'X-Generation-Id': 'partial-public' } }));
    try { await expect(new SpeechTransport(() => 'dummy').generate(message, new AbortController().signal)).rejects.toMatchObject({ generationId: 'partial-public', code: 'speech_transport_failed' }); }
    finally { fetcher.mockRestore(); }
  });
  it('rejects missing key, JSON errors, empty and oversized bodies', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(new SpeechTransport(() => null).generate(message, new AbortController().signal)).rejects.toThrow('api_key_missing'); expect(fetcher).not.toHaveBeenCalled();
      for (const [response, code] of [[new Response('{}'), 'speech_invalid_audio'], [new Response(null, { status: 429 }), 'speech_http_429'], [new Response(new Uint8Array(), { headers: { 'Content-Type': 'audio/mpeg' } }), 'speech_empty'], [new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } }), 'speech_too_large']] as const) {
        fetcher.mockResolvedValueOnce(response); await expect(new SpeechTransport(() => 'dummy', undefined, 1000, 1000, 2).generate(message, new AbortController().signal)).rejects.toThrow(code);
      }
    } finally { fetcher.mockRestore(); }
  });
});

it('removes a chat audio cache and prevents late replay or save retries from recreating it', async () => {
  const f = await fixture();
  await f.controller.listen(message.session_id, message.id, 1); await f.controller.settled();
  const audioId = (await f.controller.snapshot()).items[0].audioId!;
  const other = { ...message, session_id: 'other-session', id: 'other-message' };
  const { m, a } = await f.store.begin(other, 'manual'); await f.store.complete(m, a, audio);
  await f.controller.deleteSession(message.session_id);
  expect(f.store.get(message)).toBeUndefined(); expect(f.store.get(other)).toBeDefined();
  await expect(f.controller.audio(audioId)).rejects.toThrow('speech_invalid_asset');
  await expect(f.controller.listen(message.session_id, message.id, 1)).rejects.toThrow('session_not_found');
  await expect(f.controller.retrySave(message.session_id, message.id)).rejects.toThrow('session_not_found');
  const reopened = new SpeechStore(f.dir); await reopened.initialize();
  expect(reopened.get(message)).toBeUndefined(); expect(await reopened.audio(m, a)).toEqual(Buffer.from(audio));
  await f.controller.close(); await rm(f.dir, { recursive: true });
});

it('finishes interrupted folder cleanup after its manifest was already removed', async () => {
  const f = await fixture(); await f.controller.listen(message.session_id, message.id, 1); await f.controller.settled();
  const keys = await f.controller.prepareDeletion(message.session_id);
  await rm(join(f.dir, 'speech', keys[0], 'manifest.json'));
  const reopened = new SpeechStore(f.dir); await reopened.initialize();
  expect(reopened.records.size).toBe(0);
  await reopened.deleteSession(message.session_id, keys);
  await expect(readFile(join(f.dir, 'speech', keys[0], 'manifest.json'))).rejects.toThrow();
  const { readdir } = await import('node:fs/promises'); expect(await readdir(join(f.dir, 'speech'))).toEqual([]);
  await f.controller.close(); await rm(f.dir, { recursive: true });
});

it('drains a late starter result before parking, rejects hidden Listen, and restores the same cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stomylos-opening-speech-'));
  const starter = { ...message, origin: 'starter' as const, sequence: 0, request_id: null };
  let visible = true, finish!: (result: any) => void;
  const events: AppEvent[] = [], generate = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const speech = new SpeechController(new SpeechStore(dir), { generate }, async () => {
    if (!visible) throw new Error('message_not_found'); return starter;
  }, event => events.push(event));
  await speech.initialize(); speech.context(starter.session_id, 1);
  await speech.listen(starter.session_id, starter.id, 1);
  await vi.waitFor(() => expect(finish).toBeDefined());
  let drained = false; const transition = speech.pauseOpening().then(() => { drained = true; visible = false; speech.resumeOpening(); });
  expect(drained).toBe(false);
  finish({ bytes: audio, elapsedMs: 1 }); await transition;
  expect(events.filter(e => e.type === 'speech-play')).toHaveLength(0);
  await expect(speech.listen(starter.session_id, starter.id, 1)).rejects.toThrow('message_not_found');
  visible = true; await speech.listen(starter.session_id, starter.id, 1);
  expect(generate).toHaveBeenCalledTimes(1); expect(events.filter(e => e.type === 'speech-play')).toHaveLength(1);
  await speech.close(); await rm(dir, { recursive: true });
});

it('saves received audio while its starter is parked without resolving hidden transcript data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stomylos-opening-save-'));
  const store = new SpeechStore(dir); let visible = true;
  const generate = vi.fn(async () => ({ bytes: audio, elapsedMs: 1 }));
  const speech = new SpeechController(store, { generate }, async () => {
    if (!visible) throw new Error('message_not_found'); return { ...message, origin: 'starter' };
  }, () => undefined);
  await speech.initialize(); speech.context(message.session_id, 1);
  const complete = vi.spyOn(store, 'complete').mockRejectedValueOnce(new Error('disk full'));
  await speech.listen(message.session_id, message.id, 1); await speech.settled();
  expect((await speech.snapshot()).items[0].state).toBe('save_pending');
  await speech.pauseOpening(); visible = false; speech.resumeOpening(); complete.mockRestore();
  await speech.retrySave(message.session_id, message.id);
  expect((await speech.snapshot()).items[0].state).toBe('ready'); expect(generate).toHaveBeenCalledTimes(1);
  visible = true; await speech.listen(message.session_id, message.id, 1); expect(generate).toHaveBeenCalledTimes(1);
  await speech.close(); await rm(dir, { recursive: true });
});
