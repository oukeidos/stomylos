import prompt from './genie-prompt.txt?raw';
import scope from './genie-scope.txt?raw';
import format from './genie-output.txt?raw';
import schema from './genie-schema.json';
import contract from './genie-contract.json';
import { AppFailure } from './errors';
import { strictJson } from './strict-json';
import type { GenieRange, GenieReply, GenieSource } from '../shared/genie';
import type { Json } from '../shared/types';

export const genieLimits = { draft: 100_000, followup: 8_000, body: 256_000 } as const;
export const genieIdentity = { allowed_models: contract.accepted_models, provider: contract.expected_provider };
export const genieTimeout = contract.timeout_seconds * 1000;
export function genieRange(text: string, range: GenieRange): GenieRange {
  const { start, end, direction } = range;
  const split = (i: number) => i > 0 && i < text.length && /[\uD800-\uDBFF]/u.test(text[i - 1]) && /[\uDC00-\uDFFF]/u.test(text[i]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length ||
      !['forward', 'backward', 'none'].includes(direction) || !['draft', 'selection'].includes(range.scope) ||
      (range.scope === 'selection' && start === end) || split(start) || split(end)) throw new AppFailure('genie_range');
  return range.scope === 'draft' ? { start: 0, end: text.length, direction: 'none', scope: 'draft' } : { ...range };
}
// Match the experiment's Python JSON message serialization, not the HTTP envelope.
export function genieJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(genieJson).join(', ') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ': ' + genieJson(v)).join(', ') + '}';
  return JSON.stringify(value);
}
export function genieBody(source: GenieSource, range: GenieRange, history: { role: string; content: string }[] = [], helpRequest = 'Help!'): Json {
  genieRange(source.text, range);
  if (Buffer.byteLength(source.text) > genieLimits.draft) throw new AppFailure('genie_limit');
  const selected = range.scope === 'selection';
  const input: Json = { main_chat: source.messages, draft: source.text, help_request: helpRequest };
  if (selected) input.target_selection = { text: source.text.slice(range.start, range.end),
    start: Array.from(source.text.slice(0, range.start)).length, end: Array.from(source.text.slice(0, range.end)).length, offset_unit: 'unicode_codepoints' };
  const body = { model: contract.model, provider: contract.provider, reasoning: contract.reasoning,
    max_tokens: contract.max_tokens, stream: contract.stream,
    messages: [{ role: 'system', content: prompt + (selected ? '\n' + scope : '') + '\n' + format },
      { role: 'user', content: genieJson(input) }, ...history],
    response_format: { type: 'json_schema', json_schema: { name: 'genie_expression_v1', strict: true, schema } } };
  if (Buffer.byteLength(JSON.stringify(body)) > genieLimits.body) throw new AppFailure('genie_limit');
  return body;
}
export function parseGenie(content: string): GenieReply {
  const value = strictJson(content);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'reply') || !Object.hasOwn(value, 'suggested_text') || typeof value.reply !== 'string' ||
      !(value.suggested_text === null || typeof value.suggested_text === 'string') ||
      (typeof value.suggested_text === 'string' && !value.suggested_text.trim()) ||
      (!value.reply.trim() && value.suggested_text === null)) throw new AppFailure('genie_output');
  return { reply: value.reply, suggested_text: value.suggested_text };
}
export function genieReplacement(source: GenieSource, range: GenieRange, reply: GenieReply): string | null {
  genieRange(source.text, range);
  if (reply.suggested_text === null || reply.suggested_text === source.text.slice(range.start, range.end)) return null;
  const result = source.text.slice(0, range.start) + reply.suggested_text + source.text.slice(range.end);
  if (Buffer.byteLength(result) > genieLimits.draft) throw new AppFailure('genie_limit');
  return result;
}
