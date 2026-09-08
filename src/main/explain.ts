import prompt from './explain-prompt.txt?raw';
import { AppFailure } from './errors';
import type { ExplainSource } from '../shared/explain';
export const explainIdentity = { allowed_models: ['openai/gpt-5.6-luna', 'openai/gpt-5.6-luna-20260709'], provider: 'OpenAI' };
export function explainRange(text: string, start: number, end: number) {
  const split = (i: number) => i > 0 && i < text.length && /[\uD800-\uDBFF]/u.test(text[i - 1]) && /[\uDC00-\uDFFF]/u.test(text[i]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length || split(start) || split(end) || !text.slice(start, end).trim()) throw new AppFailure('explain_selection');
}
export function explainBody(source: ExplainSource) {
  explainRange(source.full_passage, source.selection.start, source.selection.end);
  if (source.selected_text !== source.full_passage.slice(source.selection.start, source.selection.end)) throw new AppFailure('explain_selection');
  const body = { model: 'openai/gpt-5.6-luna', provider: { only: ['openai/flex'], order: ['openai/flex'], allow_fallbacks: false, require_parameters: true },
    stream: false, max_tokens: 4096, reasoning: { effort: 'xhigh' },
    messages: [{ role: 'system', content: prompt.trim() }, { role: 'user', content: JSON.stringify(source) }] };
  if (Buffer.byteLength(JSON.stringify(body)) > 256_000) throw new AppFailure('explain_limit');
  return body;
}
