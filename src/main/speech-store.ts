import type { ProviderRequest } from './provider-policy';
import { mkdir, readFile, writeFile, rename, open, readdir, stat, unlink, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AppFailure } from './errors';
import { isVoice, previewSource, type VoiceId, type PreviewSource } from '../shared/voice';
import type { Message } from '../shared/types';

export const speechHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// Frozen generation/cache identity. Effective outbound routing is stored per attempt.
export const speechConfig = { contract: 'stomylos_tts_v1', model: 'x-ai/grok-voice-tts-1.0', voice: 'ara', speed: 1.0,
  response_format: 'mp3', provider: { only: ['xai'], order: ['xai'], allow_fallbacks: false, data_collection: 'deny' }, prefix: '[long-pause]' };
export type SpeechConfig = typeof speechConfig;
export const makeSpeechConfig = (voice: VoiceId): SpeechConfig => {
  if (!isVoice(voice)) throw new AppFailure('speech_invalid_voice');
  return { ...structuredClone(speechConfig), voice };
};
export const hashConfig = (config: SpeechConfig) => speechHash(JSON.stringify(config));
export type SpeechSource = Message | PreviewSource;
export const isPreview = (source: SpeechSource): source is PreviewSource => 'kind' in source;
export const configHash = speechHash(JSON.stringify(speechConfig));
export type SpeechMode = 'manual' | 'automatic';
export interface SpeechAttempt {
  id: string; parentId: string | null; state: 'generating' | 'ready' | 'failed' | 'cancelled' | 'interrupted' | 'save_pending' | 'evicted';
  trigger: SpeechMode; createdAt: string; dispatchedAt?: string; finishedAt?: string; error?: string;
  providerRequest?: ProviderRequest;
  generationId?: string; bytes?: number; audioHash?: string; elapsedMs?: number;
}
export interface SpeechManifest {
  version: 1 | 2; key: string; sessionId?: string; messageId?: string; kind?: 'preview'; sampleVersion?: 'voice_preview_v1'; sourceHash: string; inputHash: string;
  config: typeof speechConfig; configHash: string; attempts: SpeechAttempt[];
}
export function speechKey(message: SpeechSource, config = speechConfig) {
  return isPreview(message) ? 'preview-' + speechHash(JSON.stringify(['voice_preview_v1', speechHash(message.content), hashConfig(config)])) :
    speechHash(JSON.stringify([message.session_id, message.id, speechHash(message.content), hashConfig(config)]));
}
export async function atomicFile(path: string, content: string | Uint8Array) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    const handle = await open(temporary, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path); await chmod(path, 0o600);
    const directory = await open(join(path, '..'), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => undefined); }
}
export class SpeechStore {
  mode: SpeechMode = 'manual'; voice: VoiceId = 'ara';
  private preferenceTail: Promise<void> = Promise.resolve();
  warning: string | null = null;
  readonly records = new Map<string, SpeechManifest>();
  constructor(readonly directory: string, readonly limit = 512 * 1024 * 1024) {}
  private folder(key: string) { if (!/^(?:preview-)?[a-f0-9]{64}$/.test(key)) throw new AppFailure('speech_invalid_asset'); return key.startsWith('preview-') ? join(this.directory, 'preview', key.slice(8)) : join(this.directory, 'speech', key); }
  path(key: string, id: string, extension = 'mp3') {
    if (!/^[a-f0-9-]{36}$/.test(id) || !['mp3', 'part'].includes(extension)) throw new AppFailure('speech_invalid_asset');
    return join(this.folder(key), `${id}.${extension}`);
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const p = JSON.parse(await readFile(join(this.directory, 'preferences.json'), 'utf8'));
      if (!['manual', 'automatic'].includes(p.ttsMode) ||
          !(p.version === 1 && Object.keys(p).length === 2 || p.version === 2 && Object.keys(p).length === 3 && isVoice(p.ttsVoice))) throw new Error();
      this.mode = p.ttsMode; this.voice = p.version === 1 ? 'ara' : p.ttsVoice;
    } catch (error: any) { if (error.code !== 'ENOENT') this.warning = 'speech_preferences_invalid'; }
    for (const namespace of ['speech', 'preview']) {
      await mkdir(join(this.directory, namespace), { recursive: true, mode: 0o700 });
      for (const dir of await readdir(join(this.directory, namespace), { withFileTypes: true })) {
        if (!dir.isDirectory() || !/^[a-f0-9]{64}$/.test(dir.name)) continue;
        const key = namespace === 'preview' ? 'preview-' + dir.name : dir.name;
        try {
          const m: SpeechManifest = JSON.parse(await readFile(join(this.folder(key), 'manifest.json'), 'utf8'));
          if (m.key !== key || !isVoice(m.config?.voice) || m.configHash !== hashConfig(makeSpeechConfig(m.config.voice)) || hashConfig(m.config) !== m.configHash ||
            !(namespace === 'speech' ? m.version === 1 && typeof m.sessionId === 'string' && typeof m.messageId === 'string' && !m.kind :
              m.version === 2 && m.kind === 'preview' && m.sampleVersion === 'voice_preview_v1' && !m.sessionId && !m.messageId && m.key === speechKey(previewSource, m.config)) ||
            !Array.isArray(m.attempts) || new Set(m.attempts.map(a => a.id)).size !== m.attempts.length || !m.attempts.every(a => /^[a-f0-9-]{36}$/.test(a.id))) throw new Error();
          const expectedKey = m.kind === 'preview' ? speechKey(previewSource, m.config) :
            speechHash(JSON.stringify([m.sessionId, m.messageId, m.sourceHash, m.configHash]));
          if (m.key !== expectedKey || (m.kind === 'preview' && (m.sourceHash !== speechHash(previewSource.content) || m.inputHash !== speechHash(m.config.prefix + previewSource.content)))) throw new Error();
          this.records.set(m.key, m);
          let changed = false;
          for (const a of m.attempts) {
            if (['generating', 'save_pending'].includes(a.state)) {
              // Recover only a complete file whose hash was durably recorded before promotion.
              const bytes = await readFile(this.path(m.key, a.id)).catch(() => null);
              if (bytes && a.audioHash && speechHash(bytes) === a.audioHash) a.state = 'ready';
              else { a.state = 'interrupted'; a.error = a.dispatchedAt ? 'speech_interrupted_unknown' : 'speech_not_dispatched'; }
              changed = true;
            }
            await unlink(this.path(m.key, a.id, 'part')).catch(() => undefined);
          }
          if (changed) await this.save(m);
        } catch { this.warning ??= 'speech_cache_unavailable'; }
      }
    }
  }
  async setMode(mode: SpeechMode) {
    return this.setPreferences({ mode });
  }
  async setVoice(voice: VoiceId) {
    if (!isVoice(voice)) throw new AppFailure('speech_invalid_voice');
    return this.setPreferences({ voice });
  }
  private setPreferences(change: {mode?: SpeechMode; voice?: VoiceId}) {
    const operation = this.preferenceTail.then(async () => {
      if (this.warning === 'speech_preferences_invalid') throw new AppFailure(this.warning);
      await atomicFile(join(this.directory, 'preferences.json'), JSON.stringify({ version: 2, ttsMode: change.mode ?? this.mode, ttsVoice: change.voice ?? this.voice }));
      this.mode = change.mode ?? this.mode; this.voice = change.voice ?? this.voice;
    });
    this.preferenceTail = operation.catch(() => undefined); return operation;
  }
  get(message: SpeechSource, config = speechConfig) { return this.records.get(speechKey(message, config)); }
  async save(m: SpeechManifest) {
    await mkdir(this.folder(m.key), { recursive: true, mode: 0o700 });
    await atomicFile(join(this.folder(m.key), 'manifest.json'), JSON.stringify(m));
    this.records.set(m.key, m);
  }
  async bytes() {
    let total = 0;
    for (const m of this.records.values()) for (const a of m.attempts) {
      total += (await stat(this.path(m.key, a.id)).catch(() => null))?.size ?? 0;
    }
    return total;
  }
  async begin(message: SpeechSource, trigger: SpeechMode, config = speechConfig) {
    if (await this.bytes() + 16 * 1024 * 1024 > this.limit) throw new AppFailure('speech_cache_full');
    const m: SpeechManifest = this.get(message, config) ?? { ...(isPreview(message) ? { version: 2 as const, kind: 'preview' as const, sampleVersion: 'voice_preview_v1' as const } : { version: 1 as const, sessionId: message.session_id, messageId: message.id }), key: speechKey(message, config), sourceHash: speechHash(message.content), inputHash: speechHash(config.prefix + message.content),
      config: structuredClone(config), configHash: hashConfig(config), attempts: [] };
    const a: SpeechAttempt = { id: randomUUID(), parentId: m.attempts.at(-1)?.id ?? null, state: 'generating', trigger, createdAt: new Date().toISOString() };
    m.attempts.push(a); await this.save(m); return { m, a };
  }
  async complete(m: SpeechManifest, a: SpeechAttempt, bytes: Uint8Array) {
    a.audioHash = speechHash(bytes); a.bytes = bytes.length; a.state = 'save_pending';
    await this.save(m);
    await atomicFile(this.path(m.key, a.id, 'part'), bytes);
    await rename(this.path(m.key, a.id, 'part'), this.path(m.key, a.id));
    const folder = await open(this.folder(m.key), 'r'); try { await folder.sync(); } finally { await folder.close(); }
    delete a.error; a.state = 'ready'; a.finishedAt = new Date().toISOString(); await this.save(m);
  }
  async audio(m: SpeechManifest, a: SpeechAttempt) {
    if (a.state !== 'ready') throw new AppFailure('speech_not_ready');
    const bytes = await readFile(this.path(m.key, a.id));
    if (!bytes.length || speechHash(bytes) !== a.audioHash) throw new AppFailure('speech_cache_invalid');
    return bytes;
  }
  sessionKeys(sessionId: string) { return [...this.records].filter(([, record]) => record.sessionId === sessionId).map(([key]) => key); }
  async deleteSession(sessionId: string, savedKeys: string[] = []) {
    for (const key of new Set([...savedKeys, ...this.sessionKeys(sessionId)])) {
      if (this.records.has(key) && this.records.get(key)!.sessionId !== sessionId) throw new AppFailure('deletion_asset_conflict');
      await rm(this.folder(key), { recursive: true, force: true });
      this.records.delete(key);
    }
    const folder = await open(join(this.directory, 'speech'), 'r');
    try { await folder.sync(); } finally { await folder.close(); }
  }
  async clear() {
    for (const m of this.records.values()) {
      for (const a of m.attempts) {
        await unlink(this.path(m.key, a.id)).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
        await unlink(this.path(m.key, a.id, 'part')).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
        if (['ready', 'save_pending'].includes(a.state)) a.state = 'evicted';
      }
      await this.save(m);
    }
  }
}
