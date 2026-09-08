import { createHash } from 'node:crypto';
import prompt from './pattern-prompt.txt?raw';
import scopePrompt from './pattern-scope.txt?raw';
import stylePrompt from './pattern-style-v2.txt?raw';
import contract from './pattern-contract.json';
import historicalContract from './pattern-contract-v1.json';
import type { PatternPreview, PatternSource } from '../shared/pattern-report';
import type { Json } from '../shared/types';
import { AppFailure } from './errors';

export const patternLimits = { sessions: 20, days: 90, minimum: 5, recurrence: 3, input: 20_000, html: 512 * 1024 } as const;
export const patternContract = contract;
export const patternHash = (text: string) => createHash('sha256').update(text).digest('hex');
export const patternEstimator = 'utf8-request-plus-1024-v1';
type PatternContract = typeof historicalContract | typeof contract;
const originalSystem = prompt + '\n' + scopePrompt;
const styleAnchor = 'Return only a complete self-contained HTML document';
const styledSystem = originalSystem.replace(styleAnchor, stylePrompt.trim() + '\n\n' + styleAnchor);
export function verifyPatternRuntime() {
  if ([contract, historicalContract].some(c => patternHash(prompt) !== c.prompt_sha256 || patternHash(scopePrompt) !== c.scope_sha256) ||
      originalSystem.split(styleAnchor).length !== 2 || patternHash(stylePrompt) !== contract.style_sha256 ||
      patternHash(styledSystem) !== contract.system_sha256 ||
      patternHash(originalSystem) !== 'b3027e3d454cb5178b6e8a492670572b67c858e9a45df992fc1b6ff5e7466c83') throw new AppFailure('pattern_contract');
}
export function resolvePatternContract(saved: unknown): PatternContract {
  for (const supported of [historicalContract, contract]) {
    if (JSON.stringify(saved) === JSON.stringify(supported)) return supported;
  }
  throw new AppFailure('pattern_unsupported_contract');
}
export function patternBody(sources: PatternSource[], selected: PatternContract = contract): Json {
  verifyPatternRuntime();
  const supported = resolvePatternContract(selected);
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
  const sources = sorted.slice(0, patternLimits.sessions); let body = patternBody(sources), removed = 0;
  while (sources.length && patternEstimate(body) > patternLimits.input) { sources.pop(); removed++; body = patternBody(sources); }
  const scope = { asOf: new Date(time).toISOString(), cutoff, count: sources.length, records: sources.reduce((n, s) => n + s.units.length, 0),
    from: sources.at(-1)?.ended_at ?? null, to: sources[0]?.ended_at ?? null, eligible: sorted.length,
    excluded: { unavailable, older, overCount: Math.max(0, sorted.length - patternLimits.sessions), overBudget: removed },
    estimate: patternEstimate(body), estimator: patternEstimator, limit: patternLimits.input };
  // Dates used only for the preview do not defeat identical-input reuse.
  const fingerprint = patternHash(JSON.stringify({ sources, body, limits: patternLimits, estimator: patternEstimator, version: contract.version }));
  const blocked: PatternPreview['blocked'] = sources.length >= patternLimits.minimum ? null : removed ? 'input_limit' : 'insufficient';
  return { sources, body, preview: { scope, fingerprint, blocked, existingId: null, unavailableSessions: [] } as PatternPreview };
}
export function validatePatternHtml(html: string) {
  if (Buffer.byteLength(html) > patternLimits.html) throw new AppFailure('pattern_output_limit');
  if (!/^\s*<!doctype html>\s*<html(?:\s[^>]*)?>/i.test(html) || !/<\/html>\s*$/i.test(html) ||
      !/<head(?:\s[^>]*)?>[\s\S]*<\/head>/i.test(html) || !/<body(?:\s[^>]*)?>[\s\S]*<\/body>/i.test(html)) throw new AppFailure('pattern_output');
  return html;
}
