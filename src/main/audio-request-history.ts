import type { DictationRecord } from '../shared/asr';
import { requestSettings, type RequestAttempt } from '../shared/request-history';
import type { SpeechManifest } from './speech-store';
export function audioRequestHistory(sessionId: string, dictations: DictationRecord[], speech: Iterable<SpeechManifest>): RequestAttempt[] {
  const attempts: RequestAttempt[] = [];
  for (const record of dictations.filter(r => r.sessionId === sessionId)) {
    record.attempts.forEach((a, index) => attempts.push({ id: a.id, kind: 'Speech recognition',
      status: a.error ? 'failed' : a.finishedAt ? 'succeeded' : 'dispatched', createdAt: a.dispatchedAt,
      dispatchedAt: a.dispatchedAt, finishedAt: a.finishedAt, parentId: record.attempts[index - 1]?.id,
      messageId: record.submitted?.messageId, model: record.config.model, settings: requestSettings(record.config),
      metadata: {id: a.generationId, usage: a.usage, ...(a.finishedAt ? {elapsed_seconds:(Date.parse(a.finishedAt)-Date.parse(a.dispatchedAt))/1000} : {})}, failure: a.error,
      notes: [`${record.duration.toFixed(1)} seconds of audio`, ...(record.discarded ? ['Dictation discarded; request history retained.'] : []),
        ...(record.submitted ? [record.submitted.edited ? 'Edited dictation was sent.' : 'Dictation was sent.'] : [])] }));
  }
  for (const record of speech) {
    if (record.sessionId !== sessionId || record.kind === 'preview') continue;
    for (const a of record.attempts) attempts.push({ id: a.id, kind: 'Speech synthesis',
      status: a.state === 'ready' || a.state === 'evicted' ? 'succeeded' : a.state === 'generating' ? a.dispatchedAt ? 'dispatched' : 'queued' : a.state,
      createdAt: a.createdAt, dispatchedAt: a.dispatchedAt, finishedAt: a.finishedAt, parentId: a.parentId,
      messageId: record.messageId, model: record.config.model, settings: requestSettings(a.providerRequest?.body ?? record.config),
      metadata: { id: a.generationId, ...(a.elapsedMs === undefined ? {} : {elapsed_seconds: a.elapsedMs / 1000}) }, failure: a.error,
      notes: [`Voice: ${record.config.voice} · ${a.trigger}`, ...(a.state === 'evicted' ? ['Cached audio removed; request history retained.'] : [])] });
  }
  return attempts;
}
