import { randomUUID } from 'node:crypto';
import { ASR, type DictationRecord, type DictationProgress, type DictationSnapshot } from '../shared/asr';
import { DictationStore } from './asr-store';
import type { CaptureEncoder } from './asr-worker-client';
import { AsrFailure, asrBody, type AsrGateway, validateFlac } from './asr-transport';
import { speechHash } from './speech-store';
import { AppFailure, failureCode } from './errors';

export class DictationController {
  private active: DictationRecord | null = null;
  private encoder: CaptureEncoder | null = null;
  private clip: Uint8Array | null = null;
  private progress: DictationProgress | null = null;
  private revision = 0;
  private finalizing: Promise<void> | null = null;
  private network: { abort: AbortController; promise: Promise<void> } | null = null;
  private savePending = new Map<string, DictationRecord>();
  private beginning = false;
  private deleted = new Set<string>();
  constructor(readonly store: DictationStore, private gateway: AsrGateway,
    private makeEncoder: () => Promise<CaptureEncoder>, private emit: (snapshot: DictationSnapshot) => void,
    private captureLock: (locked: boolean) => void) {}
  async initialize() { await this.store.initialize(); }
  async context(sessionId: string) {
    if (this.locked && this.active?.sessionId !== sessionId) throw new AppFailure('asr_busy');
    if (this.active?.sessionId !== sessionId && !this.locked) { this.clip = null; this.active = null; this.progress = null; }
    await this.store.loadSession(sessionId); this.publish();
  }
  get capturing() { return !!this.active && ['permission', 'recording', 'finalizing'].includes(this.active.phase); }
  get locked() { return this.capturing || this.active?.phase === 'transcribing' || this.beginning; }
  get needsSave() { return this.savePending.size > 0; }
  get permissionAllowed() { return !!this.encoder && this.active?.phase === 'permission'; }
  snapshot(): DictationSnapshot {
    const records = new Map(this.store.records);
    for (const [id, record] of this.savePending) records.set(id, record);
    if (this.active) records.set(this.active.id, this.active);
    return structuredClone({ revision: this.revision, activeId: this.active?.id ?? null,
      records: [...records.values()].filter(record => !this.deleted.has(record.sessionId)), progress: this.progress, warning: this.store.warning,
      audioId: this.clip ? this.active!.id : null, unsavedIds: [...this.savePending.keys()] });
  }
  private publish() { this.revision++; this.emit(this.snapshot()); }
  private record(id: string) {
    const record = this.active?.id === id ? this.active : this.savePending.get(id) ?? this.store.records.get(id);
    if (!record || this.deleted.has(record.sessionId)) throw new AppFailure('asr_record_missing'); return record;
  }
  private async save(record: DictationRecord) {
    try { await this.store.save(record); this.savePending.delete(record.id); }
    catch { this.savePending.set(record.id, record); throw new AppFailure('asr_save_required'); }
  }
  async begin(id: string, sessionId: string, revision: number, draft: string) {
    if (this.locked || this.network || this.finalizing || this.savePending.size) throw new AppFailure('asr_busy');
    if (this.store.has(id)) throw new AppFailure('asr_duplicate_operation');
    this.beginning = true; this.clip = null; this.progress = null; this.captureLock(true);
    const record: DictationRecord = { version: 1, id, sessionId, draftRevision: revision,
      baseDraftHash: speechHash(draft), config: { model: ASR.model, contract: ASR.contract, format: 'flac', sampleRate: ASR.rate },
      phase: 'permission', createdAt: new Date().toISOString(), duration: 0, audioBytes: 0, attempts: [] };
    this.active = record; this.publish();
    try {
      await this.save(record);
      if (record.phase === 'cancelled') return;
      const encoder = await this.makeEncoder();
      if (this.active !== record || record.discarded) { await encoder.discard(); return; }
      this.encoder = encoder;
    } catch (error) {
      if (!record.discarded) { record.phase = 'failed'; record.error = failureCode(error); await this.save(record).catch(() => undefined); }
      this.captureLock(false); throw error;
    } finally { this.beginning = false; this.publish(); }
  }
  async push(id: string, sequence: number, pcm: Int16Array) {
    const record = this.record(id), encoder = this.encoder;
    if (record !== this.active || !encoder || !['permission', 'recording'].includes(record.phase)) throw new AppFailure('asr_capture_stopped');
    record.phase = 'recording';
    const progress = await encoder.push(sequence, pcm);
    if (this.active !== record || record.discarded) throw new AppFailure('asr_capture_stopped');
    this.progress = progress; record.duration = progress.samples / ASR.rate; record.audioBytes = progress.bytes;
    this.publish(); return progress;
  }
  async finish(id: string, reason: NonNullable<DictationRecord['stopReason']>) {
    const record = this.record(id);
    if (this.finalizing) { if (record !== this.active) throw new AppFailure('asr_busy'); return this.finalizing; }
    if (record !== this.active || !this.encoder || !['permission', 'recording'].includes(record.phase)) throw new AppFailure('asr_capture_stopped');
    const encoder = this.encoder; this.encoder = null;
    record.phase = 'finalizing'; record.stopReason = this.progress?.stop ?? reason; this.publish();
    this.finalizing = (async () => {
      try {
        const clip = await encoder.finish();
        if (record.discarded || this.active !== record) return;
        this.clip = clip; record.audioBytes = clip.length; record.audioHash = speechHash(clip);
        try { record.duration = validateFlac(clip).duration; asrBody(clip); record.phase = 'ready'; delete record.error; }
        catch (error) { record.phase = 'failed'; record.error = failureCode(error); }
        await this.save(record);
      } catch (error) {
        if (!record.discarded) { record.phase = 'failed'; record.error = failureCode(error); await this.save(record).catch(() => undefined); }
      } finally { this.finalizing = null; this.captureLock(false); this.publish(); }
    })();
    return this.finalizing;
  }
  audio(id: string) {
    if (this.active?.id !== id || !this.clip) throw new AppFailure('asr_audio_missing');
    return this.clip;
  }
  async transcribe(id: string) {
    const record = this.record(id);
    if (this.network || this.locked || record !== this.active || !this.clip ||
      !['ready', 'failed', 'cancelled'].includes(record.phase) || record.discarded || this.savePending.has(id)) throw new AppFailure('asr_not_ready');
    if (record.attempts.length >= 100) throw new AppFailure('asr_attempt_limit');
    const clip = this.clip; asrBody(clip);
    if (speechHash(clip) !== record.audioHash) throw new AppFailure('asr_invalid_audio');
    const abort = new AbortController(); record.phase = 'transcribing'; delete record.error;
    const attempt: DictationRecord['attempts'][number] = { id: randomUUID(), dispatchedAt: new Date().toISOString() };
    record.attempts.push(attempt); this.publish();
    // Set the active job before any async continuation so repeated Stop cannot dispatch twice.
    const promise = Promise.resolve().then(async () => {
      try {
        await this.save(record);
        if (abort.signal.aborted) throw new AppFailure('asr_cancelled_before_dispatch');
        const result = await this.gateway.transcribe(clip, abort.signal);
        attempt.generationId = result.generationId; attempt.usage = result.usage;
        if (abort.signal.aborted || record.discarded) throw new AppFailure('asr_cancelled');
        record.text = result.text; record.phase = 'complete';
      } catch (error) {
        if (error instanceof AsrFailure) { attempt.generationId = error.generationId; attempt.usage = error.usage; }
        attempt.error = failureCode(error); record.error = attempt.error;
        if (!record.discarded) record.phase = abort.signal.aborted ? 'cancelled' : 'failed';
      } finally {
        attempt.finishedAt = new Date().toISOString();
        try { await this.save(record); }
        catch { if (!record.discarded) record.phase = 'save_pending'; }
        this.network = null; this.publish();
      }
    });
    this.network = { abort, promise };
    return; // The UI remains responsive to cancellation; completion is an event.
  }
  async cancel(id: string, discard: boolean) {
    const record = this.record(id);
    if (record === this.active) {
      if (this.capturing || this.beginning) discard = true;
      this.network?.abort.abort(); const encoder = this.encoder; this.encoder = null;
      record.phase = 'cancelled'; record.discarded = discard;
      if (discard) this.clip = null;
      this.captureLock(false); this.publish();
      await encoder?.discard();
      await this.network?.promise;
    } else record.discarded = true;
    await this.save(record); this.publish();
  }
  async retrySave(id: string) {
    const record = this.record(id);
    if (this.network) throw new AppFailure('asr_busy');
    if (record.phase === 'save_pending') record.phase = record.text === undefined ? 'failed' : 'complete';
    await this.save(record);
    if (!this.savePending.size && this.store.warning === 'asr_link_save_required') this.store.warning = null;
    this.publish();
  }
  async inserted(id: string, sessionId: string, revision: number, text: string) {
    const record = this.record(id);
    if (record.sessionId !== sessionId || record.text === undefined || record.discarded || record.submitted || this.savePending.has(id)) throw new AppFailure('asr_result_unavailable');
    record.inserted = { revision, textHash: speechHash(text) }; record.draftBinding = { ...record.inserted };
    await this.save(record); this.publish();
  }
  async bindDraft(sessionId: string, ids: string[], revision: number, text: string) {
    for (const id of ids) {
      const record = this.active?.id === id ? this.active : this.savePending.get(id) ?? this.store.records.get(id);
      if (!record || record.sessionId !== sessionId || !record.inserted || record.submitted || record.discarded) continue;
      record.draftBinding = { revision, textHash: speechHash(text) };
      try { await this.save(record); } finally { this.publish(); }
    }
  }
  async submitted(sessionId: string, ids: string[], messageId: string, text: string) {
    // Called only after Store.submit returns the actual committed message ID.
    for (const id of ids) {
      const record = this.active?.id === id ? this.active : this.store.records.get(id);
      if (!record) continue;
      if (record.sessionId !== sessionId || !record.inserted || record.submitted || record.discarded) continue;
      record.submitted = { messageId, contentHash: speechHash(text), at: new Date().toISOString(), edited: record.inserted.textHash !== speechHash(text) };
      await this.save(record).catch(() => { this.store.warning = 'asr_link_save_required'; });
    }
    this.clip = null; this.publish();
  }
  async close() {
    if (this.active && this.locked) await this.cancel(this.active.id, true);
    await this.network?.promise; await this.finalizing;
    this.clip = null; this.captureLock(false);
  }
  cancelDeletion(sessionId: string) { this.deleted.delete(sessionId); this.publish(); }
  async prepareDeletion(sessionId: string) {
    this.deleted.add(sessionId);
    if (this.active?.sessionId === sessionId) {
      this.network?.abort.abort();
      await this.network?.promise; await this.finalizing;
      await this.encoder?.discard(); this.encoder = null;
      this.active = null; this.clip = null; this.progress = null; this.captureLock(false);
    }
    return this.store.sessionIds(sessionId);
  }
  async deleteSession(sessionId: string, savedIds: string[] = []) {
    await this.prepareDeletion(sessionId);
    try { await this.store.deleteSession(sessionId, savedIds); }
    finally {
      for (const [id, record] of this.savePending) if (record.sessionId === sessionId) this.savePending.delete(id);
      this.publish();
    }
  }
}
