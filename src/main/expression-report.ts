import { createHash } from 'node:crypto';
import prompt from './expression-prompt-v1.txt?raw';
import format from './expression-format-v1.json';
import contract from './expression-contract-v1.json';
import type { ExpressionSuggestion, PatternSource } from '../shared/pattern-report';
import type { Json } from '../shared/types';
import { AppFailure } from './errors';
import { strictJson } from './strict-json';
export const expressionContract = contract;
export const expressionLimit = contract.capacity.input_characters;
export const expressionEstimator = 'unicode-system-corpus-schema-v1';
export function expressionBody(sources: PatternSource[]): Json {
  verifyExpressionRuntime();
  const corpus = ['<conversation_corpus>', ...sources.flatMap(s => [
    `SESSION ${s.session_id}`,
    // Quote each complete message losslessly to prevent text from forging labels.
    ...(s.messages ?? []).map(m => `${m.id} ${m.role.toUpperCase()}: ${JSON.stringify(m.content)}`)
  ]), '</conversation_corpus>'].join('\n');
  return {...contract.parameters, response_format: format, messages: [{role:'system',content:prompt},{role:'user',content:corpus}]};
}
export function expressionCharacters(body: Json) {
  return body.messages.reduce((n: number, m: {content: string}) => n + Array.from(m.content).length, 0) + Array.from(JSON.stringify(body.response_format)).length;
}
export function validateExpressions(content: string, sources: PatternSource[]): ExpressionSuggestion[] {
  const fail = (): never => { throw new AppFailure('pattern_expression_output'); };
  let value: any; try { value = strictJson(content, null); } catch { return fail(); }
  const keys = (v: any, expected: string[]) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === expected.sort().join(',');
  if (!keys(value, ['suggestions']) || !Array.isArray(value.suggestions)) return fail();
  const ids = new Set(sources.flatMap(s => s.units.map(u => u.message_id)));
  for (const item of value.suggestions) {
    if (!keys(item, ['expression','explanation','example','evidence_ids']) ||
      ['expression','explanation','example'].some(k => typeof item[k] !== 'string' || !item[k].trim()) ||
      !Array.isArray(item.evidence_ids) || !item.evidence_ids.length ||
      item.evidence_ids.some((id: unknown) => typeof id !== 'string' || !ids.has(id)) || new Set(item.evidence_ids).size !== item.evidence_ids.length) return fail();
  }
  return (value.suggestions as ExpressionSuggestion[]).slice().sort((a,b) => b.evidence_ids.length - a.evidence_ids.length);
}
export function verifyExpressionRuntime() {
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  if (hash(prompt) !== '6b53249ccd3fbe54fe7378359d7c8f09290dae7fa1eb8f12192bd7fcc8ac0e54' || hash(JSON.stringify(format)) !== '5afafcca8c83118fee91501ea92a143c80d960cdf251fc6e35156dd6ac0c67a9') throw new AppFailure('pattern_expression_contract');
}
