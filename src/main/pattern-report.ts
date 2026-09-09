import { createHash } from 'node:crypto';
import prompt from './pattern-prompt.txt?raw';
import scopePrompt from './pattern-scope.txt?raw';
import stylePrompt from './pattern-style-v2.txt?raw';
import contract from './pattern-contract.json';
import historicalContract from './pattern-contract-v1.json';
import directContract from './pattern-contract-v3.json';
import directSystem from './pattern-system-v3.txt?raw';
import type { PatternPreview, PatternSource } from '../shared/pattern-report';
import type { Json } from '../shared/types';
import { AppFailure } from './errors';

export const patternLimits = { sessions: 20, days: 90, minimum: 5, recurrence: 3, input: 20_000, html: 512 * 1024 } as const;
export const patternContract = directContract;
export const legacyPatternContract = contract;
export const patternHash = (text: string) => createHash('sha256').update(text).digest('hex');
export const patternEstimator = 'utf8-request-plus-1024-v1';
export type PatternContract = typeof historicalContract | typeof contract | typeof directContract;
const originalSystem = prompt + '\n' + scopePrompt;
const styleAnchor = 'Return only a complete self-contained HTML document';
const styledSystem = originalSystem.replace(styleAnchor, stylePrompt.trim() + '\n\n' + styleAnchor);
export function verifyPatternRuntime() {
  if (patternHash(directSystem) !== directContract.system_sha256 || [contract, historicalContract].some(c => patternHash(prompt) !== c.prompt_sha256 || patternHash(scopePrompt) !== c.scope_sha256) ||
      originalSystem.split(styleAnchor).length !== 2 || patternHash(stylePrompt) !== contract.style_sha256 ||
      patternHash(styledSystem) !== contract.system_sha256 ||
      patternHash(originalSystem) !== 'b3027e3d454cb5178b6e8a492670572b67c858e9a45df992fc1b6ff5e7466c83') throw new AppFailure('pattern_contract');
}
export function resolvePatternContract(saved: unknown): PatternContract {
  for (const supported of [historicalContract, contract, directContract]) {
    if (JSON.stringify(saved) === JSON.stringify(supported)) return supported;
  }
  throw new AppFailure('pattern_unsupported_contract');
}
export function patternBody(sources: PatternSource[], selected: PatternContract = directContract): Json {
  verifyPatternRuntime();
  const supported = resolvePatternContract(selected);
  if (supported.version === directContract.version) {
    // JSON string quoting makes each numbered occurrence one physical line. Newlines,
    // quotes and delimiter-like user text round-trip without forging source labels.
    const packet = ['Original learner messages; no prior grammar analysis is supplied.',
      'Each labeled item is one complete learner-message occurrence encoded as a JSON string. S1-1 means session 1, message 1.',
      ...sources.flatMap((s, i) => ['', `Session ${i + 1}`, ...s.units.map((u, j) => `S${i + 1}-${j + 1}: ${JSON.stringify(u.original)}`)])].join('\n');
    return { ...supported.parameters, messages: [{ role: 'system', content: directSystem }, { role: 'user', content: packet }] };
  }
  const sessions = [...sources].reverse().map(s => ({ session_id: s.session_id, ended_at: s.ended_at,
    units: s.units.map(u => ({ source_id: u.source_id, text: u.original, corrected_text: u.corrected, explanation: u.explanation })) }));
  return { ...supported.parameters, messages: [{ role: 'system', content: supported.version === historicalContract.version ? originalSystem : styledSystem },
    { role: 'user', content: JSON.stringify({ evidence_kind: 'Stored compact conversation evidence; suggestions are unreviewed.', sessions }) }] };
}
export function patternEstimate(body: Json) { return Buffer.byteLength(JSON.stringify(body), 'utf8') + 1024; }
export function selectPatternScope(eligible: PatternSource[], asOf: string, unavailable = 0, older = 0) {
  const time = Date.parse(asOf);
  if (!Number.isFinite(time)) throw new AppFailure('pattern_time');
  const cutoff = new Date(time - patternLimits.days * 86400_000).toISOString();
  const sorted = eligible.filter(s => Date.parse(s.ended_at) >= Date.parse(cutoff) && Date.parse(s.ended_at) <= time && s.units.length)
    .sort((a, b) => Date.parse(b.ended_at) - Date.parse(a.ended_at) || (b.session_id < a.session_id ? -1 : b.session_id > a.session_id ? 1 : 0));
  const sources = sorted.slice(0, patternLimits.sessions); let body = patternBody(sources, contract), removed = 0;
  while (sources.length && patternEstimate(body) > patternLimits.input) { sources.pop(); removed++; body = patternBody(sources, contract); }
  const scope = { asOf: new Date(time).toISOString(), cutoff, count: sources.length, records: sources.reduce((n, s) => n + s.units.length, 0),
    from: sources.at(-1)?.ended_at ?? null, to: sources[0]?.ended_at ?? null, eligible: sorted.length,
    excluded: { unavailable, older, overCount: Math.max(0, sorted.length - patternLimits.sessions), overBudget: removed },
    estimate: patternEstimate(body), estimator: patternEstimator, limit: patternLimits.input };
  // Dates used only for the preview do not defeat identical-input reuse.
  const fingerprint = patternHash(JSON.stringify({ sources, body, limits: patternLimits, estimator: patternEstimator, version: contract.version }));
  const blocked: PatternPreview['blocked'] = sources.length >= patternLimits.minimum ? null : removed ? 'input_limit' : 'insufficient';
  return { sources, body, preview: { scope, fingerprint, blocked, existingId: null, unavailableSessions: [] } as PatternPreview };
}
export function validatePatternHtml(html: string, selected: PatternContract = directContract) {
  if (selected.version !== directContract.version && Buffer.byteLength(html) > patternLimits.html) throw new AppFailure('pattern_output_limit');
  if (!/^\s*<!doctype html>\s*<html(?:\s[^>]*)?>/i.test(html) || !/<\/html>\s*$/i.test(html) ||
      !/<head(?:\s[^>]*)?>[\s\S]*<\/head>/i.test(html) || !/<body(?:\s[^>]*)?>[\s\S]*<\/body>/i.test(html)) throw new AppFailure('pattern_output');
  return html;
}

export const directPatternEstimator = 'unicode-chars-div4-plus32-v1';
export function directPatternEstimate(body: Json) {
  return Math.ceil(body.messages.reduce((n: number, m: {content: string}) => n + Array.from(m.content).length, 0) / 4) + directContract.capacity.framing_tokens;
}
export const directPatternLimit = Math.min(Math.floor(directContract.capacity.context * directContract.capacity.input_fraction),
  directContract.capacity.max_input, directContract.capacity.context - directContract.parameters.max_tokens);
export function patternInputCost(tokens: number) {
  const longContext = tokens > directContract.pricing.long_input_threshold;
  return { inputCost: tokens * (longContext ? directContract.pricing.long_input_per_million : directContract.pricing.input_per_million) / 1_000_000, longContext };
}
export function patternResponsePolicy(selected: PatternContract) {
  return selected.version === directContract.version ? { maxResponseBytes: null } : {};
}
