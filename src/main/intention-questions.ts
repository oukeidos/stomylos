import { isDeepStrictEqual } from 'node:util';
import type { Json } from '../shared/types';
import type { IntentionRoute } from '../shared/intention';
import type { MemoryItem } from '../shared/memory';
import { hash } from './contracts';
import { AppFailure } from './errors';
import prompt from './intention-prompt.txt?raw';

export const intentionPromptHash = '313e1f48b82b2b69aab058b8e88cba7b5ed215436bbc462ef2f05462162f4f19';
export const intentionPolicy = Object.freeze({ attemptMs: 8000, batchMs: 60000, preparationMs: 240000, concurrency: 2 });
const routes = [
  ['openai/gpt-5.6-luna', 'openai/gpt-5.6-luna-20260709', 'OpenAI', 'openai'],
  ['mistralai/mistral-small-2603', 'mistralai/mistral-small-2603', 'Mistral', 'mistral'],
  ['google/gemma-4-31b-it', 'google/gemma-4-31b-it-20260402', 'DeepInfra', 'deepinfra/turbo']
];
export function intentionConfig(): Json {
  if (hash(prompt) !== intentionPromptHash) throw new AppFailure('intention_prompt_hash');
  return { version: 'stomylos_intention_questions_v1', prompt, prompt_hash: intentionPromptHash, policy: { ...intentionPolicy },
    routes: routes.map(([model, canonical, provider, tag], i): IntentionRoute => ({
      response_identity: { allowed_models: [...new Set([model, canonical])], provider },
      parameters: { model, stream: false, max_tokens: 2048,
        reasoning: i === 2 ? { enabled: false, exclude: true } : { effort: 'none', exclude: true },
        provider: { only: [tag], allow_fallbacks: false, require_parameters: true, data_collection: 'deny' } }
    })) };
}
export function intentionBody(config: Json, input: string, route: number): Json {
  if (!isDeepStrictEqual(config, intentionConfig()) || !Number.isInteger(route) || !config.routes[route]) throw new AppFailure('intention_config_changed');
  const value = JSON.parse(input);
  const keys = value.operation === 'add' ? ['operation', 'intention'] : ['operation', 'previous_intention', 'intention', 'existing_question'];
  if (!['add', 'update'].includes(value.operation) || Object.keys(value).length !== keys.length || keys.some(k => typeof value[k] !== 'string' || !value[k].trim()) || Buffer.byteLength(input) > 16000) throw new AppFailure('intention_input_format');
  return { ...config.routes[route].parameters, messages: [{ role: 'system', content: config.prompt }, { role: 'user', content: input }] };
}
export function intentionDiff(before: MemoryItem[], after: MemoryItem[]) {
  const old = new Map(before.map(item => [item.id, item.text])), current = new Map(after.map(item => [item.id, item.text]));
  return [...new Set([...old.keys(), ...current.keys()])].filter(id => old.get(id) !== current.get(id))
    .map(id => ({ id, previous: old.get(id) ?? null, text: current.get(id) ?? null }));
}
export function parseIntentionQuestion(content: string): string {
  const text = content.trim();
  // Quoted titles may contain a question mark; only unquoted question endings count.
  const outside = text.replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|'[^'\n]*'/gu, 'title');
  if (!text || text.length > 4000 || /[\r\n]/u.test(text) || /^(?:[-*•#`]|\d+[.)]|(?:question|answer):)/iu.test(text) ||
    !text.endsWith('?') || (outside.match(/\?/gu)?.length ?? 0) !== 1) throw new AppFailure('intention_output_format');
  return text;
}
export function intentionFallback(code: string) {
  return /^(?:http_(?:404|408|429|5\d\d)|request_timeout|transport_failed|response_.+|provider_api_error|unexpected_tool_call|invalid_json|intention_output_format)$/u.test(code);
}
