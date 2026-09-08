import { decimal } from '../shared/usage';
import type { UsageRecorder } from './usage-store';
import { previewSource, type VoiceId } from '../shared/voice';
import type { Message, SpeechSnapshot, SpeechItem, AppEvent } from '../shared/types';
import { AppFailure, failureCode } from './errors';
import { SpeechStore, speechConfig, speechKey, makeSpeechConfig, hashConfig, isPreview, speechHash, type SpeechSource, type SpeechConfig, type SpeechMode, type SpeechManifest, type SpeechAttempt } from './speech-store';

export function speechBody(message: SpeechSource, config = speechConfig) {
  if (!isPreview(message) && (message.role !== 'assistant' || !['model', 'starter'].includes(message.origin) || message.delivery !== 'complete' || !message.content.trim())) throw new AppFailure('speech_not_eligible');
  const input = config.prefix + message.content;
  if ([...input].length > 15_000) throw new AppFailure('speech_text_too_long');
  const { contract: _contract, prefix: _prefix, ...settings } = config;
  return { ...settings, input };
}
export class SpeechFailure extends AppFailure {
  constructor(code: string, public readonly generationId: string | undefined, public readonly elapsedMs: number) { super(code); }
}
export interface SpeechResult { bytes: Uint8Array; generationId?: string; elapsedMs: number }
export interface SpeechGateway { generate(message: SpeechSource, signal: AbortSignal, config?: SpeechConfig): Promise<SpeechResult> }
export class SpeechTransport implements SpeechGateway {
  constructor(private key: () => string | null, private endpoint = 'https://openrouter.ai/api/v1/audio/speech',
    private totalMs = 180_000, private idleMs = 90_000, private maxBytes = 16 * 1024 * 1024, private accounting?: UsageRecorder) {}
  async generate(message: SpeechSource, signal: AbortSignal, config?: SpeechConfig): Promise<SpeechResult> {
    const body = speechBody(message, config); const key = this.key(); if (!key) throw new AppFailure('api_key_missing');
    if (signal.aborted) throw new AppFailure('speech_cancelled');
    const abort = new AbortController(); let reason = 'speech_cancelled';
    const cancel = () => abort.abort(); if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    const total = setTimeout(() => { reason = 'speech_timeout'; abort.abort(); }, this.totalMs);
    let idle: ReturnType<typeof setTimeout>;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => { reason = 'speech_idle_timeout'; abort.abort(); }, this.idleMs); };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined; const started = Date.now(); let generationId: string | undefined;
    try {
      touch();
      // OpenRouter lists USD 15 / 1M characters, verified 2026-09-08.
      // Full submitted Unicode code points (including tags) are an estimate, not a bill.
      // https://openrouter.ai/x-ai/grok-voice-tts-1.0/pricing
      this.accounting?.begin({ amount: decimal(BigInt([...body.input].length) * 15n, 6),
        basis: 'grok-tts-2026-09-08:USD15/1M-codepoints-full-input-including-tags' });
      const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      generationId = response.headers.get('x-generation-id') ?? undefined;
      if (!response.ok) throw new AppFailure(`speech_http_${response.status}`);
      if (response.headers.get('content-type')?.split(';')[0].trim() !== 'audio/mpeg') throw new AppFailure('speech_invalid_audio');
      if (!response.body) throw new AppFailure('speech_empty');
      const advertised = Number(response.headers.get('content-length'));
      if (advertised > this.maxBytes) throw new AppFailure('speech_too_large');
      const parts: Uint8Array[] = []; let size = 0; reader = response.body.getReader();
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        touch(); size += part.value.byteLength; if (size > this.maxBytes) throw new AppFailure('speech_too_large'); parts.push(part.value);
      }
      if (abort.signal.aborted) throw new AppFailure(reason);
      if (!size) throw new AppFailure('speech_empty');
      if (advertised && advertised !== size) throw new AppFailure('speech_incomplete');
      return { bytes: Buffer.concat(parts), generationId: response.headers.get('x-generation-id') ?? undefined, elapsedMs: Date.now() - started };
    } catch (error) {
      throw new SpeechFailure(abort.signal.aborted ? reason : error instanceof AppFailure ? error.code : 'speech_transport_failed', generationId, Date.now() - started);
    } finally { clearTimeout(total); clearTimeout(idle!); signal.removeEventListener('abort', cancel); await reader?.cancel().catch(() => undefined); }
  }
}
type Job = { source: SpeechSource; config: SpeechConfig; trigger: SpeechMode; token: number; serial: number; selection: number; abort: AbortController };
export class SpeechController {
  get backupBusy() { return this.jobs.size > 0 || this.pending.size > 0 || this.transitions > 0 || this.clearing; }
  async settleBackup() { await this.preferenceTail; await this.tail; }
  private deleted = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private preferenceTail: Promise<void> = Promise.resolve();
  private transitions = 0;
  private captureLocked = false;
  private openingLocked = false;
  private jobs = new Map<string, Job>();
  private items = new Map<string, SpeechItem>();
  private messages = new Map<string, Message>();
  private previewItem: SpeechSnapshot['preview'] = null;
  private selected: string | null = null;
  private token = 0; private serial = 0; private revision = 0; private selection = 0;
  private closing = false; private clearing = false;
  private pending = new Map<string, { m: SpeechManifest; a: SpeechAttempt; result: SpeechResult }>();
  constructor(readonly store: SpeechStore, private gateway: SpeechGateway,
    private message: (sessionId: string, messageId: string) => Promise<Message>, private emit: (event: AppEvent) => void) {}
  async initialize() { try { await this.store.initialize(); } catch { this.store.warning = 'speech_cache_unavailable'; } }
  private config() { return makeSpeechConfig(this.store.voice); }
  async snapshot(): Promise<SpeechSnapshot> {
    const cacheBytes = await this.store.bytes();
    return { revision: this.revision, selectionRevision: this.selection, voice: this.store.voice,
      mode: this.store.mode, warning: this.store.warning, cacheBytes, items: [...this.items.values()],
      preview: this.previewItem, recoveries: [...this.pending.values()].map(({ m, a }) => ({ assetKey: m.key, attemptId: a.id,
        voice: m.config.voice as VoiceId, sessionId: m.sessionId, messageId: m.messageId })) };
  }
  private async publish() { this.revision++; this.emit({ type: 'speech', snapshot: await this.snapshot() }); }
  private item(key: string, source: SpeechSource, state: SpeechItem['state'], attempt?: SpeechAttempt) {
    const data = { assetKey: key, state, attemptId: attempt?.id, error: attempt?.error,
      audioId: state === 'ready' && attempt ? `${key}_${attempt.id}` : undefined };
    if (isPreview(source)) this.previewItem = data;
    else this.items.set(source.id, { ...data, voice: this.store.voice, messageId: source.id, sessionId: source.session_id });
  }
  async load(messages: Message[]) {
    const config = this.config();
    for (const message of messages) {
      if (this.deleted.has(message.session_id) || message.role !== 'assistant' || message.delivery !== 'complete' || !message.content) continue;
      this.messages.set(message.id, message);
      const key = speechKey(message, config), a = this.store.get(message, config)?.attempts.at(-1);
      if (this.jobs.has(key)) continue;
      if (a) this.item(key, message, a.state, a); else this.items.delete(message.id);
    }
    await this.publish();
  }
  async pauseOpening() { this.openingLocked = true; this.stop(); await this.tail; }
  resumeOpening() { this.openingLocked = false; }
  captureLock(locked: boolean) { this.captureLocked = locked; if (locked) this.stop(); }
  context(sessionId: string, token: number) {
    if (token < this.token) return;
    this.stop(); this.selected = sessionId; this.token = token;
  }
  stop(automaticOnly = false) {
    if (!automaticOnly) this.serial++;
    for (const job of this.jobs.values()) if (!automaticOnly || job.trigger === 'automatic') job.abort.abort();
    this.emit({ type: 'speech-stop', automaticOnly });
  }
  stopPreview() {
    // Do not stop ordinary reply playback when Settings closes without a preview.
    for (const job of this.jobs.values()) if (isPreview(job.source)) job.abort.abort();
    this.emit({ type: 'speech-preview-stop' });
    this.previewEpoch++;
  }
  private previewEpoch = 0;
  async setMode(mode: SpeechMode) { await this.store.setMode(mode); if (mode === 'manual') this.stop(true); await this.publish(); }
  async setVoice(voice: VoiceId) {
    this.transitions++;
    const operation = this.preferenceTail.then(async () => {
      if (voice === this.store.voice) return;
      await this.store.setVoice(voice);
      this.selection++; this.stop(); this.items.clear(); this.previewItem = null;
      const a = this.store.get(previewSource, this.config())?.attempts.at(-1);
      if (a) this.item(speechKey(previewSource, this.config()), previewSource, a.state, a);
      await this.load([...this.messages.values()]);
    }).finally(() => { this.transitions--; });
    this.preferenceTail = operation.catch(() => undefined); return operation;
  }
  private blocked(token: number) { return this.captureLocked || this.openingLocked || this.closing || this.clearing || this.transitions > 0 || token !== this.token; }
  async listen(sessionId: string, messageId: string, token: number, retry = false, automatic = false, assetKey?: string, attemptId?: string) {
    if (this.deleted.has(sessionId)) throw new AppFailure('session_not_found');
    if (this.blocked(token) || (!automatic && sessionId !== this.selected)) return;
    const serial = this.serial, selection = this.selection, config = this.config();
    const message = await this.message(sessionId, messageId); speechBody(message, config);
    if (this.deleted.has(sessionId) || this.blocked(token) || serial !== this.serial || selection !== this.selection) return;
    if (automatic && (this.store.mode !== 'automatic' || message.origin !== 'model')) return;
    const key = speechKey(message, config);
    if (assetKey && (assetKey !== key || this.store.records.get(key)?.attempts.at(-1)?.id !== attemptId)) throw new AppFailure('speech_stale_attempt');
    this.messages.set(messageId, message);
    await this.admit(message, config, token, retry, automatic);
  }
  async preview(token: number, retry = false) {
    if (this.blocked(token)) return;
    await this.admit(previewSource, this.config(), token, retry, false);
  }
  private async admit(source: SpeechSource, config: SpeechConfig, token: number, retry: boolean, automatic: boolean) {
    const key = speechKey(source, config), existing = this.jobs.get(key);
    if (existing) { if (!automatic && !existing.abort.signal.aborted) existing.trigger = 'manual'; return; }
    if (!automatic) this.stop();
    const serial = this.serial, selection = this.selection, previewEpoch = this.previewEpoch;
    const old = this.store.get(source, config), attempt = old?.attempts.at(-1);
    if (attempt?.state === 'ready') {
      try { await this.store.audio(old!, attempt); }
      catch { if (selection === this.selection) { this.item(key, source, 'failed', { ...attempt, error: 'speech_cache_invalid' }); await this.publish(); } return; }
      if (selection !== this.selection) return;
      this.item(key, source, 'ready', attempt); await this.publish();
      if (!this.blocked(token) && serial === this.serial && previewEpoch === this.previewEpoch && (isPreview(source) || this.selected === source.session_id)) this.play(source, key, attempt.id, token, automatic);
      return;
    }
    if (attempt && attempt.state !== 'evicted' && !retry) { this.item(key, source, attempt.state, attempt); await this.publish(); return; }
    const job: Job = { source, config, trigger: automatic ? 'automatic' : 'manual', token, serial, selection, abort: new AbortController() };
    this.jobs.set(key, job); this.item(key, source, 'queued');
    this.tail = this.tail.then(() => this.run(key, job, previewEpoch)).catch(() => undefined);
    await this.publish();
  }
  private play(source: SpeechSource, key: string, id: string, token: number, automatic: boolean) {
    if (isPreview(source)) this.emit({ type: 'speech-preview-play', audioId: `${key}_${id}`, token, selectionRevision: this.selection });
    else this.emit({ type: 'speech-play', audioId: `${key}_${id}`, messageId: source.id, sessionId: source.session_id,
      token, automatic, selectionRevision: this.selection });
  }
  async completed(message: Message) {
    if (this.store.mode === 'automatic') {
      const selection = this.selection;
      await this.listen(message.session_id, message.id, this.token, false, true).catch(async error => {
        if (selection !== this.selection) return;
        this.items.set(message.id, { messageId: message.id, sessionId: message.session_id, state: 'failed', error: failureCode(error) }); await this.publish();
      });
    }
  }
  private async run(key: string, job: Job, previewEpoch: number) {
    let m: SpeechManifest | undefined, a: SpeechAttempt | undefined;
    let state: SpeechItem['state'] = 'generating', error: string | undefined;
    try {
      if (job.abort.signal.aborted) throw new AppFailure('speech_cancelled');
      const source = isPreview(job.source) ? previewSource : await this.message(job.source.session_id, job.source.id);
      if (speechKey(source, job.config) !== key) throw new AppFailure('speech_source_changed');
      if (job.abort.signal.aborted) throw new AppFailure('speech_cancelled');
      ({ m, a } = await this.store.begin(source, job.trigger, job.config));
      if (job.selection === this.selection) { this.item(key, source, state, a); await this.publish(); }
      if (job.abort.signal.aborted) throw new AppFailure('speech_cancelled');
      a.dispatchedAt = new Date().toISOString(); await this.store.save(m);
      const result = await this.gateway.generate(source, job.abort.signal, job.config);
      a.generationId = result.generationId; a.elapsedMs = result.elapsedMs;
      this.pending.set(key, { m, a, result });
      await this.store.complete(m, a, result.bytes); this.pending.delete(key); state = 'ready';
      if (!job.abort.signal.aborted && job.selection === this.selection && job.serial === this.serial && job.token === this.token &&
        (!isPreview(source) || previewEpoch === this.previewEpoch) && (isPreview(source) || this.selected === source.session_id) &&
        (job.trigger === 'manual' || this.store.mode === 'automatic')) this.play(source, key, a.id, job.token, job.trigger === 'automatic');
    } catch (cause) {
      state = this.pending.has(key) ? 'save_pending' : job.abort.signal.aborted ? 'cancelled' : 'failed'; error = failureCode(cause);
      if (a && cause instanceof SpeechFailure) { a.generationId = cause.generationId; a.elapsedMs = cause.elapsedMs; }
      if (a && m) { a.state = state; a.error = error; a.finishedAt = new Date().toISOString(); await this.store.save(m).catch(() => undefined); }
    } finally {
      this.jobs.delete(key);
      if (job.selection === this.selection) {
        this.item(key, job.source, state, a);
        if (error && !a) { if (isPreview(job.source)) this.previewItem!.error = error; else this.items.get(job.source.id)!.error = error; }
      }
      await this.publish().catch(() => undefined);
    }
  }
  async retrySave(sessionId: string, messageId: string) {
    if (this.deleted.has(sessionId)) throw new AppFailure('session_not_found');
    const entries = [...this.pending.values()].filter(p => p.m.sessionId === sessionId && p.m.messageId === messageId);
    if (entries.length !== 1) throw new AppFailure('speech_no_pending_save');
    return this.recover(entries[0].m.key, entries[0].a.id);
  }
  async recover(key: string, attemptId: string) {
    const operation = this.tail.then(async () => {
      const pending = this.pending.get(key);
      if (!pending || pending.a.id !== attemptId) throw new AppFailure('speech_no_pending_save');
      const { m, a, result } = pending;
      if (m.sessionId && this.deleted.has(m.sessionId)) throw new AppFailure('session_not_found');
      await this.store.complete(m, a, result.bytes); this.pending.delete(key);
      if (m.configHash === hashConfig(this.config())) {
        // Received bytes remain saveable while a starter is parked.
        if (m.kind === 'preview') this.item(key, previewSource, 'ready', a);
        else if (m.messageId && m.sessionId) this.items.set(m.messageId, { messageId: m.messageId, sessionId: m.sessionId,
          assetKey: key, attemptId: a.id, voice: this.store.voice, state: 'ready', audioId: `${key}_${a.id}` });
      }
      await this.publish();
    });
    this.tail = operation.catch(() => undefined); return operation;
  }
  async audio(id: string) {
    const match = /^((?:preview-)?[a-f0-9]{64})_([a-f0-9-]{36})$/.exec(id); if (!match) throw new AppFailure('speech_invalid_asset');
    const m = this.store.records.get(match[1]), a = m?.attempts.find(a => a.id === match[2]);
    if (!m || !a) throw new AppFailure('speech_invalid_asset');
    if (m.sessionId && this.deleted.has(m.sessionId)) throw new AppFailure('session_not_found');
    const source = m.kind === 'preview' ? previewSource : await this.message(m.sessionId!, m.messageId!);
    if (speechKey(source, m.config) !== m.key || speechHash(source.content) !== m.sourceHash || speechHash(m.config.prefix + source.content) !== m.inputHash) throw new AppFailure('speech_source_changed');
    return this.store.audio(m, a);
  }
  async clear() {
    if (this.clearing) return;
    this.clearing = true;
    try { this.stop(); await this.tail; this.pending.clear(); await this.store.clear(); this.items.clear(); this.previewItem = null; await this.publish(); }
    finally { this.clearing = false; }
  }
  async close() { this.closing = true; this.stop(); await this.preferenceTail; await this.tail; }
  cancelDeletion(sessionId: string) { this.deleted.delete(sessionId); }
  async prepareDeletion(sessionId: string) {
    this.deleted.add(sessionId);
    if (this.selected === sessionId) { this.stop(); this.selected = null; }
    for (const job of this.jobs.values()) if (!isPreview(job.source) && job.source.session_id === sessionId) job.abort.abort();
    await this.tail; return this.store.sessionKeys(sessionId);
  }
  async deleteSession(sessionId: string, savedKeys: string[] = []) {
    await this.prepareDeletion(sessionId);
    for (const [key, pending] of this.pending) if (pending.m.sessionId === sessionId) this.pending.delete(key);
    for (const [id, item] of this.items) if (item.sessionId === sessionId) this.items.delete(id);
    for (const [id, message] of this.messages) if (message.session_id === sessionId) this.messages.delete(id);
    try { await this.store.deleteSession(sessionId, savedKeys); } finally { await this.publish(); }
  }
  async settled() { await this.tail; }
}
