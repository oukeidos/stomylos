import { createHash } from 'node:crypto';
import seedText from './reply-context-seed-v1.json?raw';
import type { Json } from '../shared/types';
import type { ReplyMode } from '../shared/reply-context';
import { AppFailure } from './errors';

export const replyContextVersion = 'stomylos_reply_context_v1';
export const replySeedHash = 'b2257d146d311cfb99cd7ba7fc284840a58aa8ee373c6ae37bb63f5a8a358a3b';
if (createHash('sha256').update(seedText).digest('hex') !== replySeedHash) throw new Error('reply_seed_changed');
const seed: { role: 'user' | 'assistant'; content: string }[] = JSON.parse(seedText);
export function replyContext(mode: ReplyMode): Json {
  if (mode !== 'standard' && mode !== 'one_point') throw new AppFailure('unsupported_reply_context');
  return { version: replyContextVersion, mode, ...(mode === 'one_point' ? { seed_sha256: replySeedHash } : {}) };
}
export function replyMode(snapshot: Json): ReplyMode {
  const value = snapshot.reply_context;
  if (value === undefined) return 'standard';
  if (!value || Array.isArray(value) || value.version !== replyContextVersion || !['standard', 'one_point'].includes(value.mode)) throw new AppFailure('unsupported_reply_context');
  const expected = replyContext(value.mode);
  if (Object.keys(value).length !== Object.keys(expected).length || Object.keys(expected).some(key => value[key] !== expected[key])) throw new AppFailure('unsupported_reply_context');
  return value.mode;
}
export function replyPrefix(snapshot: Json) {
  return replyMode(snapshot) === 'one_point' ? structuredClone(seed) : [];
}
/** Snapshot upgrades must retain the independently versioned conversation choice. */
export function retainReplyContext(next: Json, saved: Json): Json {
  replyMode(saved);
  return { ...next, ...(saved.reply_context !== undefined ? { reply_context: structuredClone(saved.reply_context) } : {}) };
}
