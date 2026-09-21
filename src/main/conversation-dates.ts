import { isDeepStrictEqual } from 'node:util';
import type { Json } from '../shared/types';
import { coldContextVersion } from './memory-recall';
import { AppFailure } from './errors';

export const conversationDateVersion = 'stomylos_conversation_dates_v1';
export const dateInstructions = 'Memory dates indicate when information was reported, not when events occurred.\n'
  + 'Do not assume past events are recent, past states still hold, or plans happened.\n'
  + 'Interpret relative dates in memories within their original context; do not guess missing dates.';
export type ReportedOn = string;
export interface DatedItem { id: string; text: string; reported_on: ReportedOn; }
export interface DatedBlock { items: DatedItem[]; block: string; }
export interface ConversationDates { started_on: string; hot: DatedBlock; cold: DatedBlock; associative: DatedBlock; }
type Kind = 'hot' | 'cold' | 'associative';
export const dateCaps = { hot: 3000, cold: 2000, associative: 1500 };
const tags = { hot: 'recent_memory', cold: 'older_recollections', associative: 'associative_recall' };
const escape = (text: string) => text.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
export function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function validReported(value: unknown) {
  if (value === 'unknown') return true;
  if (typeof value !== 'string') return false;
  const dates = value.split('/');
  return dates.length <= 2 && dates.every(validDate) && (dates.length === 1 || dates[0] < dates[1]);
}
export function renderDated(items: DatedItem[], kind: Kind): string {
  if (!items.length) return '';
  return `\n\n<${tags[kind]}>\n` + items.map(item => escape(JSON.stringify({ reported_on: item.reported_on, text: item.text }))).join('\n') + `\n</${tags[kind]}>`;
}
/** Whole records only; HOT keeps the newest records while preserving prompt order. */
export function datedBlock(items: {id: string; text: string}[], dates: Record<string, ReportedOn>, kind: Kind): DatedBlock {
  const selected: DatedItem[] = [];
  for (const item of kind === 'hot' ? [...items].reverse() : items) {
    const next = { id: item.id, text: item.text, reported_on: dates[item.id] ?? 'unknown' };
    const candidate = kind === 'hot' ? [next, ...selected] : [...selected, next];
    if (Array.from(renderDated(candidate, kind)).length <= dateCaps[kind]) selected.splice(0, selected.length, ...candidate);
  }
  return { items: selected, block: renderDated(selected, kind) };
}
export function validateConversationDates(snapshot: Json, required = false) {
  if (snapshot.conversation_date_version === undefined) {
    if (snapshot.conversation_dates !== undefined) throw new AppFailure('unsupported_conversation_dates');
    return;
  }
  if (snapshot.conversation_date_version !== conversationDateVersion || snapshot.memory_version !== coldContextVersion) throw new AppFailure('unsupported_conversation_dates');
  const context = snapshot.conversation_dates as ConversationDates;
  if (!context && !required) return;
  if (!context || !validDate(context.started_on)
    || context.started_on !== snapshot.time_context?.sources?.[0]?.sent_time?.local_date) throw new AppFailure('unsupported_conversation_dates');
  const sources = { hot: snapshot.memory_context?.database_records ?? [], cold: snapshot.cold_recollections?.items ?? [], associative: snapshot.associative_recall?.items ?? [] };
  for (const kind of ['hot', 'cold', 'associative'] as const) {
    const value = context[kind];
    if (!value || !Array.isArray(value.items) || value.items.some(item => !item || !validReported(item.reported_on)
      || !sources[kind].some((source: DatedItem) => source.id === item.id && source.text === item.text))) throw new AppFailure('unsupported_conversation_dates');
    const dates = Object.fromEntries(value.items.map(item => [item.id, item.reported_on]));
    // Check order, uniqueness, exact serialization and the full rendered budget.
    if (!isDeepStrictEqual(value, datedBlock(value.items, dates, kind)) || new Set(value.items.map(i => i.id)).size !== value.items.length
      || !isDeepStrictEqual(value.items.map(i => i.id), sources[kind].filter((i: DatedItem) => value.items.some(v => v.id === i.id)).map((i: DatedItem) => i.id))) throw new AppFailure('unsupported_conversation_dates');
  }
}
