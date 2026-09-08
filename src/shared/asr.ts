/** Product limits, distinct from the empirically observed provider boundary. */
export const ASR = Object.freeze({ model: 'microsoft/mai-transcribe-2', contract: 'stomylos_asr_v1',
  rate: 16_000, seconds: 600, audioBytes: 14 * 1024 * 1024, bodyBytes: 19 * 1024 * 1024,
  responseBytes: 256 * 1024, textBytes: 100_000, chunkSamples: 8_000,
  // Two seconds of queued PCM plus frame/header overhead, reserved before stopping.
  finalizeReserve: 128 * 1024 });
export type DictationPhase = 'permission' | 'recording' | 'finalizing' | 'ready' | 'transcribing' | 'complete' | 'failed' | 'cancelled' | 'interrupted' | 'save_pending';
export interface DictationRecord {
  version: 1; id: string; sessionId: string; draftRevision: number; baseDraftHash: string;
  config: { model: string; contract: string; format: 'flac'; sampleRate: number };
  phase: DictationPhase; createdAt: string; duration: number; audioBytes: number;
  audioHash?: string; text?: string; error?: string; stopReason?: 'manual' | 'time' | 'size' | 'interrupted';
  attempts: { id: string; dispatchedAt: string; finishedAt?: string; error?: string; generationId?: string; usage?: Record<string, unknown> }[];
  inserted?: { revision: number; textHash: string }; discarded?: boolean;
  draftBinding?: { revision: number; textHash: string };
  submitted?: { messageId: string; contentHash: string; at: string; edited: boolean };
}
export interface DictationProgress { samples: number; bytes: number; stop: 'time' | 'size' | null }
export function dictationWarning(progress: DictationProgress | null) {
  if (!progress) return false;
  return progress.samples >= ASR.rate * 540 || progress.bytes >= ASR.audioBytes * .8 ||
    4 * Math.ceil(progress.bytes / 3) + 80 >= ASR.bodyBytes * .8;
}
export interface DictationSnapshot {
  revision: number; activeId: string | null; records: DictationRecord[];
  progress: DictationProgress | null; warning: string | null; audioId: string | null;
  unsavedIds: string[];
}
