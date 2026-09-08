import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Json } from '../shared/types';
import { AppFailure } from './errors';
import { strictJson } from './strict-json';
import prompt from './search-router-prompt.txt?raw';

export const searchHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const searchVersion = 'stomylos_search_v2';
export const searchOverlay: Json = {
  tools: [{ type: 'openrouter:web_search', parameters: {
    engine: 'parallel', mode: 'fast', max_results: 5, max_total_results: 10, max_uses: 2, max_characters: 1500
  } }],
  max_tool_calls: 4,
  stop_server_tools_when: [
    { type: 'step_count_is', step_count: 4 },
    { type: 'max_cost', max_cost_in_dollars: 0.25 },
    { type: 'max_tokens_used', max_tokens: 32000 }
  ]
};
export function searchSnapshot(): Json {
  return { version: searchVersion, prompt, prompt_hash: searchHash(prompt),
    models: [
      { model: 'openai/gpt-oss-120b', reasoning: { effort: 'low', exclude: false }, max_tokens: 1024 },
      { model: 'ibm-granite/granite-4.2-8b', reasoning: { enabled: false, exclude: false }, max_tokens: 128 }
    ],
    provider: { sort: 'latency', allow_fallbacks: true, require_parameters: true, data_collection: 'deny' },
    attempt_timeout_ms: 10000, total_timeout_ms: 20000, overlay: structuredClone(searchOverlay),
    transport: { timeout_ms: 120000, idle_ms: 30000, max_bytes: 8000000, metadata: true }
  };
}
export function validateSearchSnapshot(snapshot: Json) {
  const expected = searchSnapshot();
  // Submitted turns retain their original deadlines and exact retry contract.
  if (snapshot.version === 'stomylos_search_v1') {
    expected.version = 'stomylos_search_v1';
    expected.attempt_timeout_ms = 2000; expected.total_timeout_ms = 4000;
  }
  if (!isDeepStrictEqual(snapshot, expected)) throw new AppFailure('search_contract_changed');
}
export function searchInput(previous: string, current: string): string {
  return JSON.stringify({ previous_assistant: previous, current_user: current });
}
export function searchRouterBody(snapshot: Json, input: string, ordinal: number): Json {
  validateSearchSnapshot(snapshot);
  const pair = strictJson(input);
  if (Object.keys(pair ?? {}).sort().join(',') !== 'current_user,previous_assistant' ||
      typeof pair.current_user !== 'string' || typeof pair.previous_assistant !== 'string' ||
      Buffer.byteLength(input) > 200000 || ![0, 1].includes(ordinal)) throw new AppFailure('search_input_invalid');
  return { ...structuredClone(snapshot.models[ordinal]), provider: structuredClone(snapshot.provider),
    stream: true, stream_options: { include_usage: true }, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: snapshot.prompt }, { role: 'user', content: input }] };
}
export function searchBoolean(content: string): boolean {
  const value = strictJson(content);
  if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.search !== 'boolean') {
    throw new AppFailure('search_gate_invalid');
  }
  return value.search;
}
export function withSearch(body: Json, permitted: boolean): Json {
  if (body.tools || body.plugins || body.max_tool_calls || body.stop_server_tools_when || body.model?.endsWith(':online')) {
    throw new AppFailure('search_body_conflict');
  }
  return permitted ? { ...body, ...structuredClone(searchOverlay), stream_options: { include_usage: true } } : body;
}
export function recoverableSearchFailure(code: string): boolean {
  return !['request_cancelled', 'api_key_missing', 'http_401', 'http_402', 'http_403',
    'search_contract_changed', 'search_input_invalid', 'search_source_changed',
    'operation_failed', 'database_worker_failed', 'database_worker_stopped'].includes(code);
}
