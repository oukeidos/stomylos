import { timed } from './time-fixtures';
import v5 from '../src/main/conversation-v5-config.json';
import universal from '../src/main/universal-v1-config.json';
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { config, conversationSnapshot, conversationBody, conversationRequestSnapshot, eligible, hash, routerScores, transcriptJson, validateGrammar, verifyRuntime } from '../src/main/contracts';
import { parseStrict } from '../src/main/strict-json';
import type { Message } from '../src/shared/types';
import goldens from './fixtures/contract-goldens.json';
import selected from './fixtures/selected-conversation.json';
import cRuntime from '../src/main/c-conversation-config.json';
import { emptyMemory } from '../src/main/memory-updater';
const learner = (content: string, id = 'source'): Message => ({ id, content, role: 'user', origin: 'learner', session_id: 'session', sequence: 1, delivery: 'complete', request_id: null });
it('matches approved source text and selected schema references independently', () => {
  verifyRuntime();
  expect(universal.conversationPrompt).toBe(selected.prompt);
  expect(hash(v5.conversationPrompt)).toBe('4771a29f98f413a30ebb1514a338cd4d031a66393ea01faed66cfc6d5b4bedd9');
  expect(config.conversation.seed_template).toBe(selected.seed);
  expect(config.grammarPrompt).toBe(goldens.grammar.prompt);
  expect(config.grammar.request_parameters.response_format.json_schema.schema).toEqual(goldens.grammar.schema);
  expect(v5.router.response_format.json_schema.schema.required).toEqual(selected.router.score_fields);
  expect(v5.routerPrompt).toBe(selected.router_prompt);
  expect(v5.conversation.characters.map(c => c.model)).toEqual(selected.selection.models);
});
it('rejects escaped duplicate keys and noninteger router tokens', () => {
  expect(() => parseStrict('{"a":1,"\\u0061":2}')).toThrow();
  const scores = Object.fromEntries(config.conversation.characters.map(c => [c.id, 1]));
  expect(routerScores(JSON.stringify(scores))).toEqual(scores);
  for (const token of ['1.0', '1e0', 'true', 'null', '3', '-1']) expect(() => routerScores(JSON.stringify(scores).replace(':1', ':' + token))).toThrow();
  expect(() => parseStrict('['.repeat(70) + '0' + ']'.repeat(70))).toThrow();
});
it('preserves transcript whitespace and rejects grammar source repair', () => {
  const source = [learner('  안녕\r\n"quoted"\\  ')];
  const encoded = transcriptJson(source);
  expect(JSON.parse(encoded)).toEqual([{ role: 'user', content: source[0].content }]); expect(encoded.endsWith('\n')).toBe(false);
  const unit = { text: source[0].content, corrected_text: source[0].content, explanation: 'Context retained.' };
  expect(validateGrammar(JSON.stringify({ units: [unit] }), source)[0]).toMatchObject({ warnings: '["unchanged_with_note"]', evidence_status: 'unreviewed' });
  expect(() => validateGrammar(JSON.stringify({ units: [{ ...unit, text: unit.text.trim() }] }), source)).toThrow('grammar_source_text');
  expect(() => validateGrammar(JSON.stringify({ units: [{ ...unit, corrected_text: 'Different', explanation: '' }] }), source)).toThrow();
});

it('keeps old and new prompt/model bundles separate and rejects mixed snapshots', () => {
  const old = goldens.legacy.conversation_snapshot;
  const upgraded = conversationRequestSnapshot(old);
  expect(upgraded.version).toBe('stomylos_conversation_v2');
  expect(upgraded.system_prompt).toBe(old.system_prompt);
  expect(conversationBody(upgraded, 'warm_reflection', 'Public question?', []).model).toBe('google/gemini-3.1-pro-preview');
  const current = conversationSnapshot();
  current.memory_context = emptyMemory('shared');
  expect(conversationBody(timed(current, []), 'model_04', 'Public question?', []).model).toBe('openai/gpt-6-astra');
  expect(() => conversationRequestSnapshot({ ...current, characters: old.characters })).toThrow();
  expect(() => conversationRequestSnapshot({ ...current, system_prompt: old.system_prompt })).toThrow();
  expect(eligible(null)).toEqual(['model_03', 'model_04']);
  expect(eligible(null, old)).toEqual(['informative_generalist', 'warm_reflection', 'everyday_listening']);
  const oldScores = JSON.stringify(Object.fromEntries(old.characters.map(c => [c.id, 1])));
  expect(() => routerScores(oldScores)).toThrow();
  expect(Object.keys(routerScores(oldScores, old))).toHaveLength(5);
});

it('preserves C sessions and rejects mixed universal/C contracts', () => {
  const saved = { ...structuredClone(cRuntime.conversation), system_prompt: cRuntime.conversationPrompt,
    prompt_sha256: hash(cRuntime.conversationPrompt) };
  expect(hash(saved.system_prompt)).toBe('426b8939b9f7ab57e495287c676fb3581ce4c687c051f8ae70858879e026d2a3');
  const request = conversationRequestSnapshot(saved);
  expect(request.version).toBe('stomylos_conversation_v3');
  const body = conversationBody(request, 'model_04', 'Public question?', []);
  expect(body.messages[0].content).toBe(saved.system_prompt);
  expect(body.messages[1].content).toBe(saved.seed_template.replace('{{QUESTION}}', 'Public question?'));
  const current = conversationSnapshot();
  expect(current.version).toBe('stomylos_conversation_v7');
  expect(eligible(null, saved)).toEqual(eligible(null, current));
  for (const mixed of [
    { ...current, system_prompt: saved.system_prompt, prompt_sha256: saved.prompt_sha256 },
    { ...current, seed_template: saved.seed_template },
    { ...saved, version: current.version },
    { ...current, version: 'unknown' }
  ]) expect(() => conversationRequestSnapshot(mixed)).toThrow();
});
