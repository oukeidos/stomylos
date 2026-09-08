import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpeechStore, makeSpeechConfig, hashConfig, speechKey, type SpeechConfig, type SpeechSource } from '../src/main/speech-store';
import { SpeechController, speechBody, type SpeechResult } from '../src/main/tts';
import { previewSource, voices } from '../src/shared/voice';
import { validateCommand } from '../src/main/ipc';
import type { Message, AppEvent } from '../src/shared/types';
const message: Message = { id: 'message-1', session_id: 'session-1', sequence: 1, role: 'assistant', origin: 'model', delivery: 'complete', content: 'Hello.', request_id: null };
const result = { bytes: new Uint8Array([73, 68, 51, 7]), elapsedMs: 1 };
async function fixture(generate = vi.fn(async (_s: SpeechSource, _signal: AbortSignal, _config?: SpeechConfig): Promise<SpeechResult> => result)) {
  const dir = await mkdtemp(join(tmpdir(), 'stomylos-voices-'));
  const store = new SpeechStore(dir), events: AppEvent[] = [];
  const lookup = vi.fn(async () => message);
  const c = new SpeechController(store, { generate }, lookup, e => events.push(e));
  await c.initialize(); c.context(message.session_id, 1);
  return { dir, store, events, lookup, generate, c, close: async () => { await c.close(); await rm(dir, { recursive: true }); } };
}
const listen = async (c: SpeechController) => { await c.listen(message.session_id, message.id, 1); await c.settled(); };

describe('voice selection', () => {
  it('preserves the frozen legacy Ara body/hash and validates IPC voice and operation identities', () => {
    const legacy = { model: 'x-ai/grok-voice-tts-1.0', voice: 'ara', speed: 1, response_format: 'mp3', provider: { only: ['xai'], order: ['xai'], allow_fallbacks: false, data_collection: 'deny' }, input: '[long-pause]Hello.' };
    expect(speechBody(message, makeSpeechConfig('ara'))).toEqual(legacy);
    expect(hashConfig(makeSpeechConfig('ara'))).toBe('023dc3ca85a225ad146d974ca907d664d695ff1345781a48a7cdd93c8cb5824c');
    expect(speechKey(message)).toBe('6bfd090557e8b8ce4d0027b0b481b25147a04cdfd30a1d983b0be36fb7b555c4');
    for (const voice of voices) {
      expect(speechBody(message, makeSpeechConfig(voice))).toEqual({ ...legacy, voice });
      validateCommand('speechVoice', { voice });
    }
    expect(() => validateCommand('speechVoice', { voice: 'unknown' })).toThrow();
    expect(() => validateCommand('speechPreview', { token: 1, retry: false, text: 'injected' })).toThrow();
    expect(() => validateCommand('speechRecover', { assetKey: '../path', attemptId: 'bad' })).toThrow();
    expect(() => validateCommand('speechListen', { sessionId: 's', messageId: 'm', token: 1, retry: true, assetKey: 'a'.repeat(64) })).toThrow();
  });
  it('reads legacy preferences without rewriting and serializes voice/mode writes', async () => {
    const f = await fixture();
    try {
      const legacy = '{"version":1,"ttsMode":"automatic"}';
      await writeFile(join(f.dir, 'preferences.json'), legacy);
      const store = new SpeechStore(f.dir); await store.initialize();
      expect(store.voice).toBe('ara'); expect(store.mode).toBe('automatic');
      expect(await readFile(join(f.dir, 'preferences.json'), 'utf8')).toBe(legacy);
      await Promise.all([store.setVoice('eve'), store.setMode('manual'), store.setVoice('sal')]);
      const restored = new SpeechStore(f.dir); await restored.initialize();
      expect(restored.voice).toBe('sal'); expect(restored.mode).toBe('manual');
      expect(JSON.parse(await readFile(join(f.dir, 'preferences.json'), 'utf8'))).toEqual({ version: 2, ttsVoice: 'sal', ttsMode: 'manual' });
    } finally { await f.close(); }
  });
  it('preserves effective selection on save failure and rejects corrupt v2 preferences', async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.dir, 'preferences.json'));
      await expect(f.c.setVoice('eve')).rejects.toThrow();
      expect((await f.c.snapshot()).voice).toBe('ara');
      await rm(join(f.dir, 'preferences.json'), { recursive: true });
      const bad = '{"version":2,"ttsMode":"automatic","ttsVoice":"unavailable"}';
      await writeFile(join(f.dir, 'preferences.json'), bad);
      const restored = new SpeechStore(f.dir); await restored.initialize();
      expect(restored.voice).toBe('ara'); expect(restored.mode).toBe('manual');
      await expect(restored.setVoice('eve')).rejects.toThrow('speech_preferences_invalid');
      expect(await readFile(join(f.dir, 'preferences.json'), 'utf8')).toBe(bad);
    } finally { await f.close(); }
  });
  it('reuses A/B caches across switches and restart without implicit generation', async () => {
    const f = await fixture();
    try {
      await listen(f.c); const araKey = speechKey(message);
      await f.c.setVoice('eve'); expect(f.generate).toHaveBeenCalledTimes(1);
      await listen(f.c); await f.c.setVoice('ara'); await listen(f.c);
      expect(f.generate).toHaveBeenCalledTimes(2);
      expect(f.generate.mock.calls.map(c => c[2]?.voice)).toEqual(['ara', 'eve']);
      expect((await f.c.snapshot()).items[0].assetKey).toBe(araKey);
      await f.c.setVoice('eve');
      const c = new SpeechController(new SpeechStore(f.dir), { generate: f.generate }, f.lookup, e => f.events.push(e));
      await c.initialize(); c.context(message.session_id, 2); await c.load([message]);
      expect((await c.snapshot()).voice).toBe('eve'); expect(f.generate).toHaveBeenCalledTimes(2);
      await c.listen(message.session_id, message.id, 2); expect(f.generate).toHaveBeenCalledTimes(2); await c.close();
      const m = f.store.get(message)!; m.config.voice = 'unknown';
      await f.store.save(m); const invalid = new SpeechStore(f.dir); await invalid.initialize();
      expect(invalid.records.has(araKey)).toBe(false); expect(invalid.warning).toBe('speech_cache_unavailable');
    } finally { await f.close(); }
  });
  it('rejects selection changes during source lookup and blocks admission during preference writes', async () => {
    const f = await fixture();
    try {
      let finish!: (m: Message) => void;
      f.lookup.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const intent = f.c.listen(message.session_id, message.id, 1);
      const selection = f.c.setVoice('eve');
      await f.c.preview(1); await selection; finish(message); await intent; await f.c.settled();
      expect(f.generate).not.toHaveBeenCalled();
      await listen(f.c); expect(f.generate.mock.calls[0][2]?.voice).toBe('eve');
    } finally { await f.close(); }
  });
  it('freezes dispatched configuration and prevents A-B-A late state/playback', async () => {
    let finish!: (r: SpeechResult) => void;
    const generate = vi.fn((_s: SpeechSource, _signal: AbortSignal, _config?: SpeechConfig) => new Promise<SpeechResult>(resolve => { finish = resolve; }));
    const f = await fixture(generate);
    try {
      await f.c.listen(message.session_id, message.id, 1); await vi.waitFor(() => expect(finish).toBeDefined());
      await f.c.setVoice('eve'); await f.c.setVoice('ara');
      expect(generate.mock.calls[0][1].aborted).toBe(true); expect(generate.mock.calls[0][2]?.voice).toBe('ara');
      finish(result); await f.c.settled();
      expect(f.events.filter(e => e.type === 'speech-play')).toHaveLength(0);
      expect((await f.c.snapshot()).items).toHaveLength(0);
      await listen(f.c); expect(generate).toHaveBeenCalledTimes(1);
      expect((await f.c.snapshot()).items[0].state).toBe('ready');
    } finally { await f.close(); }
  });
  it('addresses multiple pending saves exactly and never regenerates during recovery', async () => {
    const f = await fixture();
    try {
      const complete = vi.spyOn(f.store, 'complete').mockRejectedValue(new Error('disk full'));
      await listen(f.c); await f.c.setVoice('eve'); await listen(f.c);
      const recoveries = (await f.c.snapshot()).recoveries; expect(recoveries.map(r => r.voice)).toEqual(['ara', 'eve']);
      await expect(f.c.retrySave(message.session_id, message.id)).rejects.toThrow('speech_no_pending_save');
      await expect(f.c.recover(recoveries[0].assetKey, recoveries[1].attemptId)).rejects.toThrow('speech_no_pending_save');
      complete.mockRestore();
      await f.c.recover(recoveries[0].assetKey, recoveries[0].attemptId);
      expect((await f.c.snapshot()).items[0].voice).toBe('eve'); expect((await f.c.snapshot()).items[0].state).toBe('save_pending');
      await f.c.recover(recoveries[1].assetKey, recoveries[1].attemptId);
      expect((await f.c.snapshot()).recoveries).toHaveLength(0); expect(f.generate).toHaveBeenCalledTimes(2);
      expect(f.events.filter(e => e.type === 'speech-play')).toHaveLength(0);
    } finally { await f.close(); }
  });
  it('refuses stale retry identity after switching and retries the selected exact attempt', async () => {
    const f = await fixture(vi.fn(async () => { throw new Error('network'); }));
    try {
      await listen(f.c); const old = (await f.c.snapshot()).items[0]; await f.c.setVoice('eve');
      await expect(f.c.listen(message.session_id, message.id, 1, true, false, old.assetKey, old.attemptId)).rejects.toThrow('speech_stale_attempt');
      await f.c.setVoice('ara'); await f.c.listen(message.session_id, message.id, 1, true, false, old.assetKey, old.attemptId); await f.c.settled();
      expect(f.generate).toHaveBeenCalledTimes(2); expect(f.store.get(message)!.attempts[1].parentId).toBe(old.attemptId);
    } finally { await f.close(); }
  });
  it('keeps preview outside transcript storage, replays after restart, and clears all audio', async () => {
    const f = await fixture();
    try {
      await f.c.preview(1); await f.c.settled(); await f.c.preview(1);
      expect(f.generate).toHaveBeenCalledTimes(1); expect(f.lookup).not.toHaveBeenCalled();
      expect(f.generate.mock.calls[0][0]).toEqual(previewSource);
      const m = f.store.get(previewSource)!; expect(m.sessionId).toBeUndefined(); expect(m.messageId).toBeUndefined(); expect(m.version).toBe(2);
      const audioId = (await f.c.snapshot()).preview!.audioId!;
      expect(await f.c.audio(audioId)).toEqual(Buffer.from(result.bytes));
      const restored = new SpeechController(new SpeechStore(f.dir), { generate: f.generate }, f.lookup, () => undefined);
      await restored.initialize(); restored.context(message.session_id, 2); await restored.preview(2); await restored.settled();
      expect(f.generate).toHaveBeenCalledTimes(1); await restored.close();
      await listen(f.c); await f.c.setVoice('sal'); await listen(f.c);
      await f.c.deleteSession(message.session_id); expect(f.store.sessionKeys(message.session_id)).toEqual([]);
      expect(await f.c.audio(audioId)).toEqual(Buffer.from(result.bytes));
      await f.c.clear(); expect(await f.store.bytes()).toBe(0); expect((await f.c.snapshot()).preview).toBeNull();
    } finally { await f.close(); }
  });
  it('cancels preview on close/capture and refuses late preview playback', async () => {
    let finish!: (r: SpeechResult) => void;
    const f = await fixture(vi.fn((_s, _signal, _config) => new Promise<SpeechResult>(resolve => { finish = resolve; })));
    try {
      await f.c.preview(1); await vi.waitFor(() => expect(finish).toBeDefined());
      f.c.stopPreview(); finish(result); await f.c.settled();
      expect(f.events.filter(e => e.type === 'speech-preview-play')).toHaveLength(0);
      f.c.captureLock(true); await f.c.preview(1); expect(f.generate).toHaveBeenCalledTimes(1);
      f.c.captureLock(false); await f.c.preview(1); expect(f.generate).toHaveBeenCalledTimes(1);
      expect(f.events.filter(e => e.type === 'speech-preview-play')).toHaveLength(1);
    } finally { await f.close(); }
  });
});
