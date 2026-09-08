import type { Json, Message } from '../shared/types';
import { AppFailure } from './errors';
import { character, hash, isLearner, leastUsed, routerSnapshot, sessionRuntime } from './contracts';
import cards from './partner-router-cards.json';
import prompt from './partner-router-prompt.txt?raw';
import { compactRouterPrompts } from './compact-router';

export const partnerRouterVersion = 'stomylos_partner_reselection_v1';
export const compactPartnerRouterVersion = 'stomylos_partner_reselection_v2';
export const partnerWindow = { turns: 3, bytes: 24_000 } as const;
export function recentDialogue(messages: Message[]) {
  const users = messages.filter(isLearner), latest = users.at(-1);
  if (!latest) throw new AppFailure('no_learner_source');
  const selected = users.slice(-partnerWindow.turns);
  const groups = selected.map((user, i) => messages.filter(m => m.sequence >= user.sequence &&
    m.sequence < (selected[i + 1]?.sequence ?? latest.sequence + 1) &&
    (isLearner(m) || (m.origin === 'model' && m.delivery === 'complete'))));
  const packet = () => groups.flat().map(({ role, content }) => ({ role, content }));
  while (groups.length > 1 && Buffer.byteLength(JSON.stringify(packet())) > partnerWindow.bytes) groups.shift();
  const input = JSON.stringify(packet());
  if (Buffer.byteLength(input) > partnerWindow.bytes) throw new AppFailure('partner_input_limit');
  return { input, message_ids: groups.flat().map(m => m.id), omitted_groups: users.length - groups.length };
}
export function partnerRouterSnapshot(saved: Json, messages: Message[], excludedModel: string): Json {
  const selected = sessionRuntime(saved), reference = (cards as Record<string, { text: string; source_sha256: string }>)[saved.version];
  if (!reference || reference.source_sha256 !== hash(selected.routerPrompt)) throw new AppFailure('unsupported_partner_router');
  const original = routerSnapshot(saved), window = recentDialogue(messages);
  const compact = saved.version === 'stomylos_conversation_v7';
  const system = compact ? compactRouterPrompts.reselection : prompt + '\n' + reference.text;
  const version = compact ? compactPartnerRouterVersion : partnerRouterVersion;
  return { ...original, version, purpose: 'partner_reselection',
    prompt: system, prompt_id: version, prompt_sha256: hash(system),
    input: window.input, input_hash: hash(window.input), source_message_ids: window.message_ids,
    omitted_groups: window.omitted_groups, excluded_model: excludedModel,
    roster_version: saved.version, policy_version: partnerRouterVersion };
}
export function partnerRouterBody(snapshot: Json): Json {
  if (![partnerRouterVersion, compactPartnerRouterVersion].includes(snapshot.version) ||
    (snapshot.version === compactPartnerRouterVersion && snapshot.prompt !== compactRouterPrompts.reselection) || snapshot.prompt_sha256 !== hash(snapshot.prompt) ||
    snapshot.input_hash !== hash(snapshot.input)) throw new AppFailure('partner_source_changed');
  return { ...snapshot.parameters, messages: [{ role: 'system', content: snapshot.prompt }, { role: 'user', content: snapshot.input }] };
}
export function chooseOtherPartner(saved: Json, excludedModel: string, scores: Record<string, number>, counts: Record<string, number>) {
  const runtime = sessionRuntime(saved), remaining = runtime.conversation.characters.filter(c => c.model !== excludedModel).map(c => c.id);
  let pool = remaining.filter(id => scores[id] === 2); let reason = 'strong_fit';
  if (!pool.length) { pool = runtime.router.route_policy.insufficient_signal_pool.filter(id => remaining.includes(id)); reason = 'insufficient_signal'; }
  if (!pool.length) pool = remaining;
  if (!pool.length) throw new AppFailure('partner_no_alternative');
  const target = leastUsed(pool, counts);
  if (character(target, saved).model === excludedModel) throw new AppFailure('partner_exclusion_failed');
  return { character: target, model: character(target, saved).model, pool, reason };
}
