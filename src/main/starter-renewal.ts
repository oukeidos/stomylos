import { randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Json, Message, Starter, OpeningKind } from '../shared/types';
import { AppFailure } from './errors';
import { appVersion, hash } from './contracts';
import revisedPrompt from './starter-prompt-v2.txt?raw';
import nonRepeatingPrompt from './starter-prompt-v3.txt?raw';
import prompt from './starter-prompt.txt?raw';

export const starterPrompt = prompt;
export const starterPromptHash = '0eed5675428600412efdf864a5bd46da53b61d6dab318735208ac3b4c2491656';
export const starterPolicy = Object.freeze({ version: 'stomylos_starter_renewal_v1', normalization: 'nfkc_lower_space_v1',
  slots: 20, queueLimit: 40, queueDays: 30, usedLimit: 10, skipSessions: 10, skipLimit: 20, recentPresentations: 5 });
export const starterGenerators = [
  { model: 'google/gemini-3.7-flash', canonical: 'google/gemini-3.7-flash-20260813', provider: 'Google AI Studio',
    tag: 'google-ai-studio', max_tokens: 8192, reasoning: { exclude: true, effort: 'low' }, context: 1048576 },
  { model: 'z-ai/glm-5.2', canonical: 'z-ai/glm-5.2-20260616', provider: 'Novita',
    tag: 'novita/fp8', max_tokens: 2048, reasoning: { enabled: false, exclude: true }, context: 1048576 },
  { model: 'anthropic/claude-sonnet-4.6', canonical: 'anthropic/claude-4.6-sonnet-20260217', provider: 'Anthropic',
    tag: 'anthropic', max_tokens: 2048, reasoning: { enabled: false, exclude: true }, context: 1000000 }
] as const;

export function verifyStarterRuntime() {
  if (hash(prompt) !== starterPromptHash || hash(revisedPrompt) !== 'e237d85f445066d62d9dc0f5741b436b25621df1b1da5a2a95ae82805b112f7f' ||
      hash(nonRepeatingPrompt) !== '9c74bbd56a93ec2ee1a609708ff34a1fb4630ef8e9dfed85fc64827765b3702a') throw new AppFailure('starter_prompt_hash_mismatch');
}
export const questionKey = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

export const renewalV4 = 'stomylos_starter_renewal_v4';
export const renewalV3 = 'stomylos_starter_renewal_v3';
export const renewalV2 = 'stomylos_starter_renewal_v2';
export function starterSnapshot(pick: (length: number) => number = randomInt, version: string = starterPolicy.version): Json {
  if (version !== starterPolicy.version && version !== renewalV2 && version !== renewalV3 && version !== renewalV4) throw new AppFailure('unsupported_starter_settings');
  const index = pick(starterGenerators.length);
  if (!Number.isInteger(index) || index < 0 || index >= starterGenerators.length) throw new AppFailure('invalid_generator_choice');
  const g = starterGenerators[index];
  const selectedPrompt = version === renewalV4 ? nonRepeatingPrompt : version === renewalV3 ? revisedPrompt : prompt;
  return { version, app_version: appVersion, prompt: selectedPrompt, prompt_id: version === renewalV4 ? 'stomylos_starter_generation_prompt_v3' : version === renewalV3 ? 'stomylos_starter_generation_prompt_v2' : 'stomylos_starter_generation_prompt_v1',
    prompt_sha256: hash(selectedPrompt), policy: { ...starterPolicy, version }, timeout_seconds: 180, context_limit: g.context,
    response_identity: { allowed_models: [g.model, g.canonical], provider: g.provider },
    parameters: { model: g.model, stream: false, provider: { only: [g.tag], allow_fallbacks: false,
      require_parameters: true, data_collection: 'deny' }, max_tokens: g.max_tokens, reasoning: { ...g.reasoning } } };
}

export function starterBody(snapshot: Json, input: string): Json {
  const index = starterGenerators.findIndex(g => g.model === snapshot.parameters?.model);
  if (index < 0) throw new AppFailure('unsupported_starter_settings');
  const expected = starterSnapshot(() => index, snapshot.version);
  for (const key of Object.keys(expected).filter(k => k !== 'app_version')) {
    if (!isDeepStrictEqual(snapshot[key], expected[key])) throw new AppFailure('unsupported_starter_settings');
  }
  if (snapshot.version === renewalV2 || snapshot.version === renewalV3 || snapshot.version === renewalV4) {
    let packet: Json;
    try { packet = JSON.parse(input); } catch { throw new AppFailure('starter_input_format'); }
    const context = packet?.session_context;
    if (!context || context.recipe !== 'C-full' || !['starter', 'user'].includes(context.opening_kind) ||
      (context.opening_kind === 'user' ? context.starter_question !== null || packet.just_used_question_id !== null
        : typeof context.starter_question !== 'string' || !context.starter_question) || !Array.isArray(context.turns) ||
      context.turns.some((turn: Json) => !turn || !['learner', 'partner'].includes(turn.speaker) || typeof turn.text !== 'string')) throw new AppFailure('starter_input_format');
  }
  const messages = [{ role: 'system', content: snapshot.prompt }, { role: 'user', content: input }];
  const bound = messages.reduce((n, m) => n + Buffer.byteLength(m.content) + 64, 256) + snapshot.parameters.max_tokens;
  if (bound > snapshot.context_limit) throw new AppFailure('starter_input_too_large');
  return { ...snapshot.parameters, messages };
}

export function starterContext(question: string | null, messages: Message[], kind?: OpeningKind): Json {
  return { recipe: 'C-full', ...(kind ? { opening_kind: kind } : {}), starter_question: question,
    turns: messages.filter(m => m.origin === 'learner' || (m.origin === 'model' && m.content.length > 0))
      .map(m => ({ speaker: m.origin === 'learner' ? 'learner' : 'partner', text: m.content })) };
}

export function parseStarterQuestions(content: string): [string, string] {
  const lines = content.split(/\r\n|\n|\r/u).filter(line => line.trim())
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, '').trim());
  if (lines.length !== 2 || lines.some(line => !line.endsWith('?') || /^(?:```|#)/u.test(line)) ||
      lines[0].toLowerCase() === lines[1].toLowerCase()) throw new AppFailure('starter_output_format');
  return lines as [string, string];
}

export interface SlotQuestion extends Starter { slot: number; pending_since: string | null }
export function selectStarter(slots: SlotQuestion[], recent: string[], current?: string, pick: (length: number) => number = randomInt) {
  const others = slots.filter(q => q.id !== current);
  if (!others.length) throw new AppFailure('starter_pool_unavailable');
  const fresh = others.filter(q => q.pending_since === null);
  const pool = fresh.length ? fresh : others;
  const excluded = recent.slice(0, starterPolicy.recentPresentations);
  let relaxed = false;
  for (;;) {
    const allowed = pool.filter(q => !excluded.includes(q.id));
    if (allowed.length) return { question: allowed[pick(allowed.length)], fallback: !fresh.length, relaxed };
    excluded.pop(); relaxed = true;
  }
}
