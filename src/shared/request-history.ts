import type { Json } from './types';

export interface RequestAttempt {
  id: string; kind: string; status: string; createdAt: string | null;
  dispatchedAt?: string | null; finishedAt?: string | null; parentId?: string | null;
  messageId?: string | null; model?: string; settings: Json; metadata: Json;
  provenance?: Json; failure?: string | null; notes?: string[]; retainedText?: string | null;
}
export interface RequestHistory { attempts: RequestAttempt[]; notices: string[] }
/** A small technical summary; never includes prompts, draft text or audio input. */
export function requestSettings(body: Json): Json {
  return Object.fromEntries(['model', 'reasoning', 'max_tokens', 'max_output_tokens', 'temperature', 'top_p',
    'seed', 'stream', 'provider', 'voice', 'speed', 'response_format', 'contract', 'format', 'sampleRate']
    .filter(key => body[key] !== undefined).map(key => [key, body[key]]));
}
export function orderAttempts(attempts: RequestAttempt[]): RequestAttempt[] {
  return [...attempts].sort((a,b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}
