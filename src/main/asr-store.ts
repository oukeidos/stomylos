import { mkdir, readdir, readFile, stat, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { ASR, type DictationRecord } from '../shared/asr';
import { atomicFile } from './speech-store';
import { AppFailure } from './errors';

export const dictationId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
export function validDictation(v: any): v is DictationRecord {
  return v && v.version === 1 && dictationId(v.id) && typeof v.sessionId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v.sessionId) &&
    integer(v.draftRevision) && digest(v.baseDraftHash) && typeof v.createdAt === 'string' && Number.isFinite(Date.parse(v.createdAt)) &&
    ['permission', 'recording', 'finalizing', 'ready', 'transcribing', 'complete', 'failed', 'cancelled', 'interrupted', 'save_pending'].includes(v.phase) &&
    Number.isFinite(v.duration) && v.duration >= 0 && v.duration <= ASR.seconds && integer(v.audioBytes) && v.audioBytes <= ASR.audioBytes + ASR.finalizeReserve &&
    v.config?.model === ASR.model && v.config.contract === ASR.contract && v.config.format === 'flac' && v.config.sampleRate === ASR.rate &&
    (v.audioHash === undefined || digest(v.audioHash)) &&
    (v.text === undefined || typeof v.text === 'string' && Buffer.byteLength(v.text) <= ASR.textBytes) &&
    (v.error === undefined || typeof v.error === 'string' && v.error.length <= 200) &&
    (v.stopReason === undefined || ['manual', 'time', 'size', 'interrupted'].includes(v.stopReason)) &&
    (v.discarded === undefined || typeof v.discarded === 'boolean') &&
    (v.inserted === undefined || integer(v.inserted?.revision) && digest(v.inserted.textHash)) &&
    (v.draftBinding === undefined || integer(v.draftBinding?.revision) && digest(v.draftBinding.textHash)) &&
    (v.submitted === undefined || typeof v.submitted?.messageId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v.submitted.messageId) &&
      digest(v.submitted.contentHash) && typeof v.submitted.edited === 'boolean' && Number.isFinite(Date.parse(v.submitted.at))) &&
    Array.isArray(v.attempts) && v.attempts.length <= 100 && v.attempts.every((a: any) => dictationId(a?.id) &&
      typeof a.dispatchedAt === 'string' && Number.isFinite(Date.parse(a.dispatchedAt)) &&
      (a.finishedAt === undefined || typeof a.finishedAt === 'string' && Number.isFinite(Date.parse(a.finishedAt))) &&
      (a.error === undefined || typeof a.error === 'string' && a.error.length <= 200) &&
      (a.generationId === undefined || typeof a.generationId === 'string' && a.generationId.length <= 1000) &&
      (a.usage === undefined || a.usage && typeof a.usage === 'object' && !Array.isArray(a.usage)));
}

/** Durable text/provenance only. Raw microphone audio never reaches this store. */
export class DictationStore {
  readonly records = new Map<string, DictationRecord>();
  private catalog = new Map<string, string>();
  private knownIds = new Set<string>();
  private deleted = new Set<string>();
  warning: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  has(id: string) { return this.knownIds.has(id); }
  private path(id: string) {
    if (!dictationId(id)) throw new AppFailure('asr_invalid_id');
    return join(this.directory, 'asr', id + '.json');
  }
  async initialize() {
    const folder = join(this.directory, 'asr');
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      for (const file of await readdir(folder, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        try {
          const id = file.name.slice(0, -5), path = this.path(id);
          this.knownIds.add(id);
          if ((await stat(path)).size > 1024 * 1024) throw new Error();
          const record = JSON.parse(await readFile(path, 'utf8'));
          if (!validDictation(record) || record.id !== id) throw new Error();
          if (['permission', 'recording', 'finalizing', 'ready', 'transcribing', 'save_pending'].includes(record.phase)) {
            record.phase = record.text !== undefined ? 'complete' : 'interrupted';
            record.error = record.text !== undefined ? undefined : record.attempts.length ? 'asr_interrupted_unknown' : 'asr_audio_not_retained';
            await this.save(record);
          }
          this.catalog.set(id, record.sessionId);
        } catch { this.warning = 'asr_record_unavailable'; }
      }
      this.records.clear(); // Keep raw text only for the selected session.
    } catch { this.warning = 'asr_store_unavailable'; }
  }
  async loadSession(sessionId: string) {
    const job = this.tail.then(async () => {
      if (this.deleted.has(sessionId)) throw new AppFailure('session_not_found');
      const records = new Map<string, DictationRecord>();
      for (const [id, owner] of this.catalog) if (owner === sessionId) {
        try {
          const path = this.path(id);
          if ((await stat(path)).size > 1024 * 1024) throw new Error();
          const record = JSON.parse(await readFile(path, 'utf8'));
          if (!validDictation(record) || record.id !== id || record.sessionId !== sessionId) throw new Error();
          records.set(id, record);
        } catch { this.warning = 'asr_record_unavailable'; }
      }
      this.records.clear(); for (const [id, record] of records) this.records.set(id, record);
    });
    this.tail = job.catch(() => undefined); return job;
  }
  async save(record: DictationRecord) {
    if (!validDictation(record)) throw new AppFailure('asr_invalid_record');
    const copy = structuredClone(record), body = JSON.stringify(copy);
    if (Buffer.byteLength(body) > 1024 * 1024) throw new AppFailure('asr_record_size');
    const job = this.tail.then(async () => {
      if (this.deleted.has(copy.sessionId)) throw new AppFailure('session_not_found');
      await atomicFile(this.path(copy.id), body); this.records.set(copy.id, copy);
      this.catalog.set(copy.id, copy.sessionId); this.knownIds.add(copy.id);
    });
    this.tail = job.catch(() => undefined); return job;
  }
  sessionIds(sessionId: string) { return [...this.catalog].filter(([, owner]) => owner === sessionId).map(([id]) => id); }
  async deleteSession(sessionId: string, savedIds: string[] = []) {
    this.deleted.add(sessionId);
    const job = this.tail.then(async () => {
      for (const id of new Set([...savedIds, ...this.sessionIds(sessionId)])) {
        if (this.catalog.has(id) && this.catalog.get(id) !== sessionId) throw new AppFailure('deletion_asset_conflict');
        await unlink(this.path(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        this.catalog.delete(id); this.records.delete(id); this.knownIds.delete(id);
      }
      const folder = await open(join(this.directory, 'asr'), 'r');
      try { await folder.sync(); } finally { await folder.close(); }
    });
    this.tail = job.catch(() => undefined); return job;
  }
}
