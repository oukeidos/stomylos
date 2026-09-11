import { coldContextVersion, coldRecallPolicy, renderCold, validateRecall } from './memory-recall';
import { memoryControlVersion } from '../shared/memory-control';
import { flattenMemory } from './memory-flat';
import { createHash, randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { version } from '../../package.json';
import runtime from './runtime-config.json';
import grammarV1 from './grammar-v1-config.json';
import conversationV5 from './conversation-v5-config.json';
import conversationV7 from './conversation-v7-config.json';
import conversationV6 from './conversation-v6-config.json';
import universalV1 from './universal-v1-config.json';
import legacy from './legacy-conversation-config.json';
import cRuntime from './c-conversation-config.json';
import type { Character, GrammarUnit, Json, Message, Starter, OpeningKind } from '../shared/types';
import { AppFailure } from './errors';
import { parseStrict, strictJson } from './strict-json';
import { emptyMemory, memoryContext, memoryVersion, sharedMemoryVersion, capacityMemoryVersion, flatMemoryVersion, sharedMemoryId, legacyMemoryVersion, memorySupported } from './memory-updater';
import { renderTime, temporalHash, timeVersion, timePrompt } from './time-context';
import { openingKind, openingVersion } from './opening';
import directRouterPrompt from './direct-router-prompt.txt?raw';
import directSixPrompt from './direct-router-six-prompt.txt?raw';
import starterSixPrompt from './starter-router-six-prompt.txt?raw';
import directSevenPrompt from './direct-router-seven-prompt.txt?raw';
import starterSevenPrompt from './starter-router-seven-prompt.txt?raw';
import reciprocalPrompt from './reciprocal-replacement-prompt.txt?raw';
import { compactRouterPrompts, compactRouterVersion, eightRouterPrompts, eightRouterVersion } from './compact-router';

export const appId = 'io.github.oukeidos.stomylos';
export const appVersion = version;
export const config = runtime;
export const characters: Character[] = runtime.conversation.characters;
export const starters: Starter[] = runtime.starters;
export const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const openingAddendum = 'The application-provided opening question does not count as your previous question.';
const conversationCacheVersion = 'stomylos_conversation_cache_v1';
export const conversationComponents = (version = runtime.conversation.version, memory = version === runtime.conversation.version ? coldContextVersion : memoryVersion) => ({
  ...(version === conversationV5.conversation.version ? { opening_v1: hash(openingAddendum) } : {}),
  [memory === coldContextVersion ? 'memory_v6' : memory === flatMemoryVersion ? 'memory_v5' : memory === capacityMemoryVersion ? 'memory_v4' : memory === sharedMemoryVersion ? 'memory_v3' : 'memory_v2']: hash(memoryContext([coldContextVersion,flatMemoryVersion].includes(memory) ? flattenMemory(emptyMemory('template')) : emptyMemory('template'), memory)), time_v1: hash(timePrompt),
  ...(memory === coldContextVersion ? {cold_recall_v1: hash(coldRecallPolicy + renderCold([{id:'template',text:'template',text_hash:hash('template'),observed_at:null,edited_at:null,time_basis:'unknown'}]))} : {})
});
export const transcriptJson = (messages: Message[]) => JSON.stringify(messages.map(m => ({ role: m.role, content: m.content })), null, 2);
export const isLearner = (m: Message) => m.role === 'user' && m.origin === 'learner';
export function character(id: string, snapshot?: Json): Character {
  const found = (snapshot ? snapshot.characters as Character[] : characters).find(c => c.id === id);
  if (!found) throw new AppFailure('invalid_character');
  return found;
}
export function verifyRuntime() {
  for (const [text, expected] of [
    [eightRouterPrompts.direct, 'f6ae98bcef9549f8551f57fbacd2e58e6d42be48cbaf1df832124ec3c1fdfde4'],
    [eightRouterPrompts.starter, '2f759a0fe8d9ca399f07eb9dc9b57f4dc77aeb40915514a48d9fb1532dd301bd'],
    [eightRouterPrompts.reselection, '628b4faa7fe937937f4ec250125a12469e4b279d23deb610d600d281b8e9a727'],
    [compactRouterPrompts.direct, 'b88d9200645c266bf37296a2bbb0748530e85c10b8ad4a6d715f19ef3ade76ac'],
    [compactRouterPrompts.starter, 'cfc7887b9b7bcfb9b94723c333e9461262468adeb3dbaf75d6e801edaef6bf59'],
    [compactRouterPrompts.reselection, '0340c6714b96d5b4835c4c05a010a95eaff7cbd8f4e3cd045a4d0fc63c417327'],
    [directRouterPrompt, 'c712eb789b47213909621634f5cd6498110489b13c4ae64d394c8855bfa4a2aa'],
    [conversationV5.routerPrompt, '2395d53d1c67029edb64fabdf521577e49d2fc40da8b4f00bc8466a3cdbea841'],
    [starterSixPrompt, 'fd30312a638df8b411b9a75e7b60b681fd4cdbbc25f64dc08ad04bb6da5d1eb3'],
    [directSixPrompt, 'f52f51a8f1ee7fcb32c84641f10d53229df70c08e8c770ae9aa6cf9097d26633'],
    [starterSevenPrompt, 'ffe7fbf60ebefe127fd355c4433e5b4329ec2164e4c88eb7cebc7d953d6a4919'],
    [directSevenPrompt, '9aea4092950d333da528772588014540472af3b99599a440d57252d6dfc90711'],
    [runtime.grammarPrompt, '99495c8a3353c9b92e92d49a4603180df6528f87e8ce29a4950863ea7bce6a8a'],
    [grammarV1.grammarPrompt, 'a01d2b746a186f76f2952013e5d35845b39e13f0c2081c74a74978c359da483e'],
    [universalV1.conversationPrompt, '07ec33490e15286c149c3af029c57f29883e93be47fe2595d50e06faf1d6d06c'],
    [conversationV5.conversationPrompt, '4771a29f98f413a30ebb1514a338cd4d031a66393ea01faed66cfc6d5b4bedd9'],
    [reciprocalPrompt, 'c70cffeace85121e193f76373a69ccb77785bce8688ab82df88da3f9b95bca00'],
    [timePrompt, 'd23e7c5b12a9c528bdcbf5e109319148dd599c86d8bbd7448cf1e1eaa39de322'],
    [runtime.conversation.seed_template, 'bebbc423485b5e9f37c5ec843f98e4146c46192e61c5aee82dadca923a2df46b']
  ]) if (hash(text) !== expected) throw new AppFailure('prompt_hash_mismatch');
  if (runtime.conversationPrompt !== reciprocalPrompt || runtime.routerPrompt !== eightRouterPrompts.starter || runtime.router.prompt.sha256 !== hash(eightRouterPrompts.starter)) throw new AppFailure('prompt_hash_mismatch');
  if (characters.some(c => (runtime.router.character_to_conversation_model as Json)[c.id] !== c.model)) throw new AppFailure('portfolio_mismatch');
}
export function sessionRuntime(snapshot?: Json) {
  if (!snapshot) return runtime;
  validateConversationSnapshot(snapshot);
  return runtimeForVersion(snapshot.version);
}
function directPrompt(selected: ReturnType<typeof sessionRuntime>) {
  if (selected.conversation.version === conversationV7.conversation.version) return directSevenPrompt;
  return selected.conversation.version === conversationV6.conversation.version ? directSixPrompt : directRouterPrompt;
}
function routingPrompt(snapshot: Json | undefined, direct: boolean, selected: ReturnType<typeof sessionRuntime>) {
  if (!snapshot || snapshot.router_prompt_version === eightRouterVersion) return direct ? eightRouterPrompts.direct : eightRouterPrompts.starter;
  if (snapshot.router_prompt_version === compactRouterVersion) return direct ? compactRouterPrompts.direct : compactRouterPrompts.starter;
  return direct ? directPrompt(selected) : selected.routerPrompt;
}
export function routerBody(question: string | null, answer: string, snapshot?: Json): Json {
  const selected = sessionRuntime(snapshot); const r = selected.router;
  const direct = snapshot && openingKind(snapshot) === 'user';
  if (direct ? question !== null : typeof question !== 'string') throw new AppFailure('opening_source_changed');
  return { model: r.model.requested_model, messages: [
    { role: 'system', content: routingPrompt(snapshot, !!direct, selected) },
    { role: 'user', content: JSON.stringify(direct ? { opening_kind: 'user', first_message: answer } : { starter_question: question, learner_answer: answer }) }
  ], stream: false, max_tokens: r.generation.max_tokens, reasoning: r.model.reasoning,
  provider: { only: r.provider.only, require_parameters: r.provider.require_parameters,
    data_collection: r.provider.data_collection, allow_fallbacks: r.provider.allow_fallbacks },
  response_format: r.response_format };
}
export function routerSnapshot(snapshot?: Json): Json {
  const selected = sessionRuntime(snapshot);
  const direct = snapshot && openingKind(snapshot) === 'user';
  const prompt = routingPrompt(snapshot, !!direct, selected);
  const compact = !snapshot || [compactRouterVersion, eightRouterVersion].includes(snapshot.router_prompt_version);
  const promptVersion = !snapshot ? eightRouterVersion : snapshot.router_prompt_version;
  const directVersion = selected.conversation.version === conversationV7.conversation.version ? 'v7' : selected.conversation.version === conversationV6.conversation.version ? 'v5' : 'v3';
  const { messages: _, ...parameters } = routerBody(direct ? null : '', '', snapshot);
  return { version: compact ? `${promptVersion}_${direct ? 'direct' : 'starter'}` : direct ? `stomylos_character_router_${directVersion}` : selected.router.version, app_version: appVersion, parameters,
    prompt, prompt_id: compact ? `${promptVersion}_${direct ? 'direct' : 'starter'}` : direct ? `stomylos_character_router_prompt_${directVersion}` : selected.router.prompt.id, prompt_sha256: hash(prompt),
    response_identity: { allowed_models: selected.router.model.accepted_response_models, provider: selected.router.provider.expected_response_provider }, timeout_seconds: selected === runtime ? 3 : 10,
    ...(selected === runtime ? { recovery_version: 'stomylos_router_recovery_v1', recovery_attempt: 0 } : {}) };
}
export function conversationSnapshot(kind?: OpeningKind): Json {
  return { ...structuredClone(runtime.conversation), system_prompt: runtime.conversationPrompt,
    prompt_id: 'stomylos_conversation_prompt_v5', prompt_sha256: hash(runtime.conversationPrompt), app_version: appVersion, memory_version: coldContextVersion,
    time_version: timeVersion, component_hashes: conversationComponents(), router_prompt_version: eightRouterVersion,
    ...(kind ? { opening: { version: openingVersion, kind } } : {}) };
}
export function grammarSnapshot(): Json {
  const g = runtime.grammar;
  return { version: g.contract_version, app_version: appVersion, validation_version: 'stomylos_validation_v1',
    parameters: structuredClone(g.request_parameters), prompt: runtime.grammarPrompt, prompt_id: g.prompt.id,
    prompt_sha256: hash(runtime.grammarPrompt), schema_sha256: hash(JSON.stringify(g.request_parameters.response_format)),
    response_identity: structuredClone(g.response_identity), timeout_seconds: g.transport.timeout_seconds,
    recovery_version: 'stomylos_grammar_retry_v1' };
}
function grammarContract(snapshot: Json) {
  const selected = snapshot.version === runtime.grammar.contract_version ? runtime
    : snapshot.version === grammarV1.grammar.contract_version ? grammarV1 : null;
  if (!selected || snapshot.prompt !== selected.grammarPrompt || snapshot.prompt_sha256 !== hash(selected.grammarPrompt) ||
    snapshot.schema_sha256 !== hash(JSON.stringify(selected.grammar.request_parameters.response_format)) ||
    snapshot.prompt_id !== selected.grammar.prompt.id || snapshot.validation_version !== 'stomylos_validation_v1' ||
    snapshot.recovery_version !== 'stomylos_grammar_retry_v1' ||
    !isDeepStrictEqual(snapshot.parameters, selected.grammar.request_parameters) ||
    !isDeepStrictEqual(snapshot.response_identity, selected.grammar.response_identity) || snapshot.timeout_seconds !== 120) {
    throw new AppFailure('unsupported_grammar_settings');
  }
  return selected;
}
export function grammarBody(snapshot: Json, messages: Message[]): Json {
  const selected = grammarContract(snapshot);
  const input = selected === grammarV1 ? transcriptJson(messages) : JSON.stringify(
    messages.filter(isLearner).map((m, index) => ({ index, role: m.role, content: m.content })), null, 2);
  return { ...snapshot.parameters, messages: [{ role: 'system', content: snapshot.prompt }, { role: 'user', content: input }] };
}

function runtimeForVersion(version: string) {
  if (version === runtime.conversation.version) return runtime;
  if (version === conversationV7.conversation.version) return conversationV7;
  if (version === conversationV6.conversation.version) return conversationV6;
  if (version === conversationV5.conversation.version) return conversationV5;
  if (version === universalV1.conversation.version) return universalV1;
  if (version === cRuntime.conversation.version) return cRuntime;
  if (version === 'stomylos_conversation_v1' || version === legacy.conversation.version) return legacy;
  throw new AppFailure('unsupported_conversation_settings');
}
function validateConversationSnapshot(snapshot: Json) {
  openingKind(snapshot);
  if (snapshot.memory_control !== undefined && snapshot.memory_control !== memoryControlVersion) throw new AppFailure('unsupported_memory_settings');
  if (snapshot.memory_control === memoryControlVersion && (snapshot.memory_context !== undefined || snapshot.cold_recollections !== undefined)) throw new AppFailure('unsupported_memory_settings');
  if (snapshot.version === runtime.conversation.version && snapshot.router_prompt_version !== eightRouterVersion) throw new AppFailure('unsupported_router_settings');
  if (snapshot.router_prompt_version !== undefined && !((snapshot.router_prompt_version === compactRouterVersion && snapshot.version === conversationV7.conversation.version) || (snapshot.router_prompt_version === eightRouterVersion && snapshot.version === runtime.conversation.version))) throw new AppFailure('unsupported_router_settings');
  if (snapshot.cache_version !== undefined && snapshot.cache_version !== conversationCacheVersion) throw new AppFailure('unsupported_conversation_settings');
  const modern = [runtime.conversation.version, conversationV7.conversation.version, conversationV6.conversation.version, conversationV5.conversation.version].includes(snapshot.version);
  if (modern) {
    if (!(snapshot.memory_version === memoryVersion || ([runtime.conversation.version, conversationV7.conversation.version, conversationV6.conversation.version].includes(snapshot.version) && [sharedMemoryVersion, capacityMemoryVersion, flatMemoryVersion, coldContextVersion].includes(snapshot.memory_version))) || snapshot.time_version !== timeVersion ||
        !isDeepStrictEqual(snapshot.component_hashes, conversationComponents(snapshot.version, snapshot.memory_version))) throw new AppFailure('unsupported_temporal_settings');
    const promptId = snapshot.version === conversationV5.conversation.version ? 'stomylos_conversation_prompt_v4' : 'stomylos_conversation_prompt_v5';
    if (snapshot.prompt_id !== promptId) throw new AppFailure('unsupported_conversation_prompt');
  } else {
    if (snapshot.memory_version !== undefined && (snapshot.memory_version !== legacyMemoryVersion || snapshot.version !== universalV1.conversation.version)) throw new AppFailure('unsupported_memory_settings');
    if (snapshot.time_version !== undefined || snapshot.time_context !== undefined || snapshot.component_hashes !== undefined) throw new AppFailure('unsupported_temporal_settings');
  }
  if (snapshot.memory_context !== undefined && !memorySupported(snapshot.memory_version)) throw new AppFailure('unsupported_memory_settings');
  const selected = runtimeForVersion(snapshot.version);
  if (snapshot.system_prompt !== selected.conversationPrompt || snapshot.prompt_sha256 !== hash(selected.conversationPrompt) || snapshot.seed_template !== selected.conversation.seed_template) throw new AppFailure('unsupported_conversation_prompt');
  const supportedBudget = (snapshot.version === 'stomylos_conversation_v1' && snapshot.max_tokens === 1200) ||
    (snapshot.version === selected.conversation.version && snapshot.max_tokens === selected.conversation.max_tokens);
  if (!supportedBudget) throw new AppFailure('unsupported_conversation_settings');
  for (const key of ['total_timeout_seconds', 'idle_timeout_seconds', 'provider', 'characters'] as const) {
    if (!isDeepStrictEqual(snapshot[key], selected.conversation[key])) throw new AppFailure('unsupported_conversation_settings');
  }
}
export function conversationRequestSnapshot(saved: Json): Json {
  const selected = sessionRuntime(saved);
  // New reply preparations adopt caching; retries replace this with their exact saved snapshot.
  return { ...structuredClone(saved), version: selected.conversation.version,
    max_tokens: selected.conversation.max_tokens, app_version: appVersion, cache_version: conversationCacheVersion };
}
export function requestPartner(snapshot: Json, original: string): string {
  const binding = snapshot.request_partner;
  if (!binding) return original;
  if (binding.version !== 'stomylos_request_partner_v1' || binding.memory_owner_character !== original ||
    !isDeepStrictEqual(binding.target, character(binding.target?.id, snapshot))) throw new AppFailure('request_partner_changed');
  return binding.target.id;
}
export function conversationBody(snapshot: Json, partnerId: string, question: string | null, messages: Message[]): Json {
  validateConversationSnapshot(snapshot);
  const direct = openingKind(snapshot) === 'user';
  if (direct && (question !== null || messages[0]?.role !== 'user' || messages.some(m => m.origin === 'starter'))) throw new AppFailure('opening_source_changed');
  if (!direct && (typeof question !== 'string' || (snapshot.opening && (messages[0]?.origin !== 'starter' || messages[0].content !== question)))) throw new AppFailure('opening_source_changed');
  const partner = (snapshot.characters as Character[]).find(c => c.id === partnerId);
  if (!partner) throw new AppFailure('invalid_character');
  const memoryOwner = snapshot.request_partner?.memory_owner_character ?? partnerId;
  if (snapshot.request_partner && requestPartner(snapshot, memoryOwner) !== partnerId) throw new AppFailure('request_partner_changed');
  if (snapshot.memory_control !== memoryControlVersion && memorySupported(snapshot.memory_version) && snapshot.memory_context?.character_id !== ([sharedMemoryVersion, capacityMemoryVersion, flatMemoryVersion, coldContextVersion].includes(snapshot.memory_version) ? sharedMemoryId : memoryOwner)) throw new AppFailure('memory_snapshot_missing');
  const system = conversationSystem(snapshot, messages);
  if (snapshot.time_version && snapshot.system_sha256 !== hash(system)) throw new AppFailure('system_snapshot_changed');
  return { model: partner.model, stream: true, max_tokens: snapshot.max_tokens, provider: snapshot.provider,
    ...(snapshot.cache_version === conversationCacheVersion && ['anthropic/claude-fable-5.1', 'anthropic/claude-sonnet-5'].includes(partner.model)
      ? { cache_control: { type: 'ephemeral' } } : {}),
    ...(partner.reasoning ? { reasoning: partner.reasoning } : {}), messages: [
      { role: 'system', content: system },
      ...(!direct ? [{ role: 'user', content: snapshot.seed_template.replaceAll('{{QUESTION}}', question) }] : []),
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ] };
}
export function conversationSystem(snapshot: Json, messages: Message[]): string {
  let system = snapshot.system_prompt;
  if (snapshot.version === conversationV5.conversation.version && snapshot.time_version && openingKind(snapshot) !== 'user') system += '\n\n' + openingAddendum;
  if (snapshot.memory_control !== memoryControlVersion && memorySupported(snapshot.memory_version)) {
    if (!snapshot.memory_context) throw new AppFailure('memory_snapshot_missing');
    system += memoryContext(snapshot.memory_context, snapshot.memory_version);
    if (snapshot.memory_version === coldContextVersion) {
      if (!snapshot.cold_recollections) throw new AppFailure('cold_snapshot_missing');
      validateRecall(snapshot.cold_recollections);
      system += snapshot.cold_recollections.block;
    } else if (snapshot.cold_recollections !== undefined) throw new AppFailure('unsupported_memory_settings');
  }
  if (snapshot.time_version) {
    if (!snapshot.time_context || snapshot.temporal_source_hash !== temporalHash(snapshot.time_context.sources)) throw new AppFailure('temporal_source_changed');
    const time = renderTime(snapshot.time_context, messages);
    if (snapshot.cache_version !== conversationCacheVersion) system += time;
  }
  return system;
}
const exactKeys = (value: any, keys: string[]) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
export function routerScores(content: string, snapshot?: Json): Record<string, number> {
  const { value, integerPaths } = parseStrict(content); const ids = sessionRuntime(snapshot).conversation.characters.map(c => c.id);
  if (!exactKeys(value, ids)) throw new AppFailure('router_schema');
  for (const id of ids) {
    const n = (value as Json)[id];
    if (!integerPaths.has(`/${id}`) || typeof n !== 'number' || n < 0 || n > 2) throw new AppFailure('router_score_type');
  }
  return value as Record<string, number>;
}
export function eligible(scores: Record<string, number> | null, snapshot?: Json): string[] {
  const selected = sessionRuntime(snapshot);
  return !scores || Object.values(scores).every(s => s <= 1) ? [...selected.router.route_policy.insufficient_signal_pool] : selected.conversation.characters.filter(c => scores[c.id] === 2).map(c => c.id);
}
export function leastUsed(pool: string[], counts: Record<string, number>, pick = randomInt): string {
  if (!pool.length) throw new AppFailure('empty_route_pool');
  const minimum = Math.min(...pool.map(id => counts[id] ?? 0));
  const tied = pool.filter(id => (counts[id] ?? 0) === minimum);
  return tied[pick(tied.length)];
}
export function chooseStarter(recent: string[], current?: string, pick = randomInt): Starter {
  let candidates = starters.filter(s => s.id !== current);
  if (!candidates.length) candidates = starters;
  const excluded = recent.slice(0, 5);
  for (;;) {
    const allowed = candidates.filter(s => !excluded.includes(s.id));
    if (allowed.length) return allowed[pick(allowed.length)];
    excluded.pop();
  }
}
export function validateGrammar(content: string, messages: Message[], snapshot: Json = grammarSnapshot()): GrammarUnit[] {
  const indexed = grammarContract(snapshot) !== grammarV1;
  const parsed = strictJson(content); const users = messages.filter(isLearner);
  if (!exactKeys(parsed, ['units']) || !Array.isArray(parsed.units)) throw new AppFailure('grammar_schema');
  if (parsed.units.length !== users.length) throw new AppFailure('grammar_source_count');
  return parsed.units.map((unit: Json, i: number) => {
    if (!exactKeys(unit, [indexed ? 'index' : 'text', 'corrected_text', 'explanation']) ||
      typeof unit.corrected_text !== 'string' || typeof unit.explanation !== 'string') throw new AppFailure('grammar_schema');
    if (indexed) {
      if (!Number.isSafeInteger(unit.index) || unit.index !== i) throw new AppFailure('grammar_source_index');
    } else if (typeof unit.text !== 'string' || unit.text !== users[i].content) throw new AppFailure('grammar_source_text');
    const text = users[i].content;
    const changed = text !== unit.corrected_text;
    if (!unit.corrected_text.trim() || (changed && !unit.explanation.trim())) throw new AppFailure('grammar_empty_correction_or_note');
    return { source_message_id: users[i].id, ordinal: i, text, corrected_text: unit.corrected_text,
      explanation: unit.explanation, changed: changed ? 1 : 0,
      warnings: JSON.stringify(!changed && unit.explanation.trim() ? ['unchanged_with_note'] : []), evidence_status: 'unreviewed' };
  });
}
export function safeMetadata(raw: Json): Json {
  const result: Json = {};
  for (const name of ['id', 'model', 'provider']) if (typeof raw[name] === 'string' && raw[name].length <= 256) result[name] = raw[name];
  if (raw.usage && typeof raw.usage === 'object') {
    const usage: Json = {};
    for (const name of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cost']) if (typeof raw.usage[name] === 'number' && Number.isFinite(raw.usage[name])) usage[name] = raw.usage[name];
    for (const name of ['prompt_tokens_details', 'completion_tokens_details', 'cost_details']) {
      if (raw.usage[name] && typeof raw.usage[name] === 'object') {
        usage[name] = {};
        for (const field of ['cached_tokens', 'reasoning_tokens', 'upstream_inference_cost', 'upstream_inference_prompt_cost', 'upstream_inference_completions_cost']) {
          const n = raw.usage[name][field]; if (typeof n === 'number' && Number.isFinite(n)) usage[name][field] = n;
        }
      }
    }
    result.usage = usage;
  }
  return result;
}
export function validateEnvelope(raw: Json, identity: Json): { content: string; metadata: Json } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppFailure('response_envelope');
  if (raw.error != null) throw new AppFailure('provider_api_error');
  if (!identity.allowed_models.includes(raw.model) || typeof raw.provider !== 'string' || !raw.provider || (identity.provider !== null && raw.provider !== identity.provider)) throw new AppFailure('response_identity');
  if (!Array.isArray(raw.choices) || raw.choices.length !== 1) throw new AppFailure('response_choices');
  const choice = raw.choices[0]; const message = choice?.message;
  if (!choice || typeof choice !== 'object' || Array.isArray(choice) || choice.error != null) throw new AppFailure('response_choices');
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new AppFailure('response_message');
  if (message.refusal != null && message.refusal !== '' && message.refusal !== false) throw new AppFailure('response_refusal');
  if (choice.finish_reason !== 'stop') throw new AppFailure('response_incomplete');
  if (typeof message.content !== 'string' || !message.content.trim()) throw new AppFailure('response_empty');
  return { content: message.content, metadata: { ...safeMetadata(raw), finish_reason: 'stop' } };
}
export function budget(messages: Message[], next = '') {
  const users = messages.filter(isLearner);
  const userBytes = users.reduce((n, m) => n + Buffer.byteLength(m.content), Buffer.byteLength(next));
  const totalBytes = messages.reduce((n, m) => n + Buffer.byteLength(m.content), Buffer.byteLength(next));
  return { allowed: users.length < 24 && userBytes <= 6000 && totalBytes <= 24000,
    near: users.length >= 19 || userBytes >= 4800 || totalBytes >= 19200 };
}
