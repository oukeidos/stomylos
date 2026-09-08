import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import prompt from './time-prompt.txt?raw';
import type { Message } from '../shared/types';
import type { RecordedTime, TemporalSource, TimeContext } from '../shared/time';
import { AppFailure } from './errors';
import type Database from 'better-sqlite3';

export const timeVersion = 'stomylos_time_context_v1';
export const timePrompt = prompt;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const temporalHash = (value: unknown) => hash(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item));
const fail = (): never => { throw new AppFailure('invalid_time_context'); };
const exact = (v: any, keys: string[]) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function recordedTime(utc: string, timezone: string | null, offset: number): RecordedTime {
  const millis = Date.parse(utc);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== utc || !Number.isInteger(offset) || offset < -840 || offset > 840) fail();
  if (timezone !== null) {
    if (typeof timezone !== 'string' || timezone.length > 128) fail();
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(millis));
      const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
      const zoned = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
      if ((zoned - Math.floor(millis / 1000) * 1000) / 60000 !== offset) fail();
    } catch { fail(); }
  }
  return { utc, timezone, utc_offset_minutes: offset, local_date: new Date(millis + offset * 60000).toISOString().slice(0, 10) };
}
export function captureTime(): RecordedTime {
  const date = new Date();
  let timezone: string | null = null;
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { /* The numeric host offset remains available. */ }
  return recordedTime(date.toISOString(), timezone, -date.getTimezoneOffset());
}
export function readMessageTime(db: Database.Database, id: string): RecordedTime | null {
  const row = db.prepare('SELECT sent_at_utc,timezone,utc_offset_minutes FROM message_times WHERE message_id=?').get(id) as
    { sent_at_utc: string; timezone: string | null; utc_offset_minutes: number } | undefined;
  return row ? recordedTime(row.sent_at_utc, row.timezone, row.utc_offset_minutes) : null;
}
export function validateTime(value: unknown): asserts value is RecordedTime {
  const v = value as RecordedTime;
  if (!exact(v, ['utc', 'timezone', 'utc_offset_minutes', 'local_date']) || typeof v.utc !== 'string') fail();
  if (!isDeepStrictEqual(v, recordedTime(v.utc, v.timezone, v.utc_offset_minutes))) fail();
}
export function timeSources(messages: Message[], read: (id: string) => RecordedTime | null, required = true): TemporalSource[] {
  return messages.filter(m => m.role === 'user' && m.origin === 'learner' && m.delivery === 'complete').map((m, i) => {
    const sent_time = read(m.id);
    if (sent_time !== null) validateTime(sent_time); else if (required) throw new AppFailure('message_time_missing');
    return { message_id: m.id, sequence: m.sequence, user_turn: i + 1, sent_time };
  });
}
export function renderTime(context: TimeContext, messages: Message[]): string {
  if (!exact(context, ['reply_reference', 'sources']) || !Array.isArray(context.sources)) fail();
  validateTime(context.reply_reference);
  const users = messages.filter(m => m.role === 'user' && m.origin === 'learner' && m.delivery === 'complete');
  if (users.length !== context.sources.length) fail();
  context.sources.forEach((s, i) => {
    if (!exact(s, ['message_id', 'sequence', 'user_turn', 'sent_time']) || s.message_id !== users[i].id || s.sequence !== users[i].sequence || s.user_turn !== i + 1) fail();
    if (s.sent_time !== null) validateTime(s.sent_time);
  });
  const data = { reply_reference: context.reply_reference, user_turn_times: context.sources.map(({ user_turn, sent_time }) => ({ user_turn, sent_time })) };
  return '\n\n' + prompt + '\n<application_time_context>\n' + JSON.stringify(data) + '\n</application_time_context>';
}
