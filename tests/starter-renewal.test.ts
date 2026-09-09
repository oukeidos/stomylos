import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { StarterStore } from '../src/main/starter-store';
import { Store } from '../src/main/database';
import { conversationSnapshot, hash, starters, transcriptJson } from '../src/main/contracts';
import { parseStarterQuestions, questionKey, selectStarter, starterBody, starterContext, starterGenerators, starterPrompt, starterPromptHash, starterSnapshot, verifyStarterRuntime, renewalV2, renewalV3, renewalV4, renewalV5 } from '../src/main/starter-renewal';
import goldens from './fixtures/contract-goldens.json';

let directory: string; let store: Store; let raw: Database.Database; let choices: number[];
const native = resolve('native/advisory-lock.node');
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stomylos-starters-')); choices = [];
  store = new Store(directory, native, n => { choices.push(n); return (choices.length - 1) % n; });
  raw = (store as unknown as { db: Database.Database }).db;
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function skip(id: string, op: string = crypto.randomUUID()) {
  const old = store.session(id); store.replaceQuestion(id, op, old.starter_id!, old.opening_revision); return old;
}
function newSession() {
  const blocker = store.endBlocker();
  if (blocker) {
    // Grammar is outside this starter-only fixture; completed starter results stay usable.
    raw.prepare("UPDATE sessions SET analysis_state='skipped' WHERE id=?").run(blocker);
    if (store.endBlocker()) store.cancelEnd(blocker);
  }
  return store.createSession();
}
it('copies the selected prompt and all three serving contracts without sampling or formatting additions', () => {
  verifyStarterRuntime(); expect(hash(starterPrompt)).toBe(starterPromptHash); expect(starterPrompt.endsWith('\n')).toBe(true);
  const expected = [
    ['google/gemini-3.7-flash', 'google-ai-studio', 8192, { exclude: true, effort: 'low' }],
    ['z-ai/glm-5.2', 'novita/fp8', 2048, { enabled: false, exclude: true }],
    ['anthropic/claude-sonnet-4.6', 'anthropic', 2048, { enabled: false, exclude: true }]
  ];
  expected.forEach(([model, tag, max_tokens, reasoning], i) => {
    const snapshot = starterSnapshot(n => { expect(n).toBe(3); return i; });
    expect(starterBody(snapshot, '{"public":"한글"}')).toEqual({ model, stream: false, max_tokens, reasoning,
      provider: { only: [tag], allow_fallbacks: false, require_parameters: true, data_collection: 'deny' },
      messages: [{ role: 'system', content: starterPrompt }, { role: 'user', content: '{"public":"한글"}' }] });
    expect(snapshot.response_identity).toEqual({ allowed_models: [model, starterGenerators[i].canonical], provider: starterGenerators[i].provider });
    expect(() => starterBody(snapshot, 'x'.repeat(1_050_000))).toThrow('starter_input_too_large');
    snapshot.parameters.temperature = 1; expect(() => starterBody(snapshot, '{}')).toThrow('unsupported_starter_settings');
  });
});
it('uses the exact minimal prompt and weighted tickets while preserving all historical request contracts', () => {
  const current = starterSnapshot(() => 0, renewalV5);
  const job = { input_json: '["An old learner message."]' };
  expect(current.version).toBe(renewalV5);
  expect(current.prompt_id).toBe('stomylos_starter_generation_prompt_v4');
  expect(current.prompt).toBe(readFileSync(resolve('../experiments/EXP-012-starter-question-renewal/prompt-user-only.txt'), 'utf8'));
  const selected = Array.from({ length: 5 }, (_, ticket) => starterSnapshot(n => { expect(n).toBe(5); return ticket; }, renewalV5));
  expect(selected.map(s => s.parameters.model)).toEqual([starterGenerators[0].model, starterGenerators[1].model, starterGenerators[1].model, starterGenerators[2].model, starterGenerators[2].model]);
  for (const snapshot of selected) expect(starterBody(snapshot, job.input_json)).toEqual({...snapshot.parameters, messages:[{role:'system',content:current.prompt},{role:'user',content:job.input_json}]});
  for (const choice of [-1, 5, 0.5]) expect(() => starterSnapshot(() => choice, renewalV5)).toThrow('invalid_generator_choice');
  for (const input of ['{}', '[1]', '[{"text":"hello"}]', 'null', 'broken']) expect(() => starterBody(current, input)).toThrow('starter_input_format');
  expect(starterBody(current, '[]').messages[1].content).toBe('[]');
  expect(() => starterBody(current, JSON.stringify(['x'.repeat(1_050_000)]))).toThrow('starter_input_too_large');
  const tampered = structuredClone(current); tampered.policy.generator_weights = [1, 1, 1];
  expect(() => starterBody(tampered, job.input_json)).toThrow('unsupported_starter_settings');
  const historicalInput = JSON.stringify({session_context:{recipe:'C-full', opening_kind:'starter', starter_question:'An old question?', turns:[]},just_used_question_id:'old'});
  for (const version of ['stomylos_starter_renewal_v1', renewalV2, renewalV3, renewalV4]) {
    for (let index = 0; index < starterGenerators.length; index++) {
      const saved = starterSnapshot(n => { expect(n).toBe(3); return index; }, version);
      saved.app_version = '0.20.0';
      const oldBody = starterBody(JSON.parse(JSON.stringify(saved)), historicalInput);
      expect(oldBody).toEqual({...saved.parameters,messages:[{role:'system',content:saved.prompt},{role:'user',content:historicalInput}]});
      expect(saved.policy.generator_weights).toBeUndefined();
    }
  }

});
it('parses only complete two-line pairs and applies textual normalization without semantic labels', () => {
  expect(parseStarterQuestions('\n1. How was today?\r\n• What is time?\n')).toEqual(['How was today?', 'What is time?']);
  for (const text of ['One?', 'One?\nTwo?\nThree?', 'Here are questions:\nOne?\nTwo?', 'One?\none?', 'One.\nTwo?', '```One?\nTwo?']) {
    expect(() => parseStarterQuestions(text)).toThrow('starter_output_format');
  }
  expect(questionKey('  ＨＥＬＬＯ\t world? ')).toBe('hello world?');
});
it('acknowledges a duplicated skip without skipping again, rejects stale input, and preserves the draft', () => {
  const session = newSession(); store.saveDraft(session.id, 'Still typing.');
  skip(session.id, 'skip-once'); const next = store.session(session.id);
  store.replaceQuestion(session.id, 'skip-once', session.starter_id!, session.opening_revision); expect(store.session(session.id)).toEqual(next);
  expect(next.draft).toBe('Still typing.'); expect(next.starter_id).not.toBe(session.starter_id);
  expect(() => store.replaceQuestion(session.id, 'stale', session.starter_id!, next.opening_revision)).toThrow('starter_changed');
  expect(raw.prepare('SELECT COUNT(*) n FROM starter_skips').get()).toEqual({ n: 1 });
  expect(store.starterInventory().events.replacements).toBe(0);
});
it('prefers fresh slots and relaxes only the oldest recent exclusions when necessary', () => {
  const slots = starters.map((q, i) => ({ ...q, slot: i + 1, pending_since: i < 19 ? '2026-09-01' : null }));
  expect(selectStarter(slots, [slots[19].id], undefined, () => 0)).toMatchObject({ question: slots[19], fallback: false, relaxed: true });
  const pending = slots.map(s => ({ ...s, pending_since: '2026-09-01' }));
  expect(selectStarter(pending, [], pending[0].id, () => 0)).toMatchObject({ question: pending[1], fallback: true });
});
it('rejects schema v1 byte-for-byte before recovery and creates only fresh schema v2', () => {
  store.close(); const file = join(directory, 'stomylos.sqlite3'); rmSync(file);
  const v1 = new Database(file); v1.exec(goldens.legacy.schema); v1.pragma('user_version=1'); v1.close();
  const before = readFileSync(file); expect(() => new Store(directory, native)).toThrow('unsupported_schema_version');
  expect(readFileSync(file)).toEqual(before);
});
