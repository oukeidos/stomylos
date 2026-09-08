import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { conversationSnapshot, hash, starters, transcriptJson } from '../src/main/contracts';
import { parseStarterQuestions, questionKey, selectStarter, starterBody, starterContext, starterGenerators, starterPrompt, starterPromptHash, starterSnapshot, verifyStarterRuntime, renewalV3, renewalV4 } from '../src/main/starter-renewal';
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
function end(text = 'I walked beside the river.') {
  const session = newSession(); store.submit(session.id, text); store.end(session.id);
  return { session, job: store.starterJob(session.id)! };
}
function finish(id: string, content = 'What would a borrowed hour let you do?\nWhich idea would you keep in a pocket?') {
  const job = store.starterJob(id)!; const attempt = store.starterAttempts(job.id).at(-1)!;
  store.dispatchStarter(attempt.id); store.saveStarter(attempt.id, content, { usage: { cost: 0.003 } }); return attempt.id;
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
it('uses the tested non-repetition prompt for new jobs while retaining exact v3 requests', () => {
  const { session } = end();
  const job = store.starterJob(session.id)!;
  const current = JSON.parse(job.config);
  expect(current.version).toBe(renewalV4);
  expect(current.prompt_id).toBe('stomylos_starter_generation_prompt_v3');
  const previous = readFileSync(resolve('src/main/starter-prompt-v2.txt'), 'utf8');
  const addition = ' Do not repeat any question in the supplied question lists or the session’s starter question.';
  expect(starterBody(current, job.input_json).messages[0].content).toBe(previous.replace('\n\n', `${addition}\n\n`));
  for (let index = 0; index < starterGenerators.length; index++) {
    const saved = starterSnapshot(() => index, renewalV3);
    saved.app_version = '0.20.0';
    const oldBody = starterBody(JSON.parse(JSON.stringify(saved)), job.input_json);
    const newBody = starterBody(starterSnapshot(() => index, renewalV4), job.input_json);
    expect(oldBody.messages[0].content).toBe(previous);
    expect({ ...newBody, messages: oldBody.messages }).toEqual(oldBody);
  }
  finish(session.id);
  expect(store.starterJob(session.id)?.state).toBe('completed');
});
it('parses only complete two-line pairs and applies textual normalization without semantic labels', () => {
  expect(parseStarterQuestions('\n1. How was today?\r\n• What is time?\n')).toEqual(['How was today?', 'What is time?']);
  for (const text of ['One?', 'One?\nTwo?\nThree?', 'Here are questions:\nOne?\nTwo?', 'One?\none?', 'One.\nTwo?', '```One?\nTwo?']) {
    expect(() => parseStarterQuestions(text)).toThrow('starter_output_format');
  }
  expect(questionKey('  ＨＥＬＬＯ\t world? ')).toBe('hello world?');
});
it('keeps all chronological text including topic changes, escaped /end and retained partials, but excludes drafts and placeholders', () => {
  const session = newSession(); store.submit(session.id, '  I walked. 한글\n');
  store.commitRoute(session.id, null, 'public', null);
  const first = store.createRequest(session.id, 'chat', conversationSnapshot()); store.dispatch(first.id);
  const bubble = store.prepareReply(session.id, first.id); store.finishReply(first.id, bubble.id, 'Tell me about that walk.', {});
  store.submit(session.id, '//end');
  const second = store.createRequest(session.id, 'chat', conversationSnapshot()); store.dispatch(second.id);
  const partial = store.prepareReply(session.id, second.id); store.failRequest(second.id, 'public_interruption', 'Now about astronomy…', {}, true);
  store.saveDraft(session.id, 'UNSENT MUST NOT LEAK'); store.end(session.id);
  store.skipMemory(session.id); store.advanceStarter(session.id);
  const job = store.starterJob(session.id)!; const packet = JSON.parse(job.input_json);
  expect(packet.session_context).toEqual({ recipe: 'C-full', opening_kind: 'starter', starter_question: session.starter_text, turns: [
    { speaker: 'learner', text: '  I walked. 한글\n' }, { speaker: 'partner', text: 'Tell me about that walk.' },
    { speaker: 'learner', text: '/end' }, { speaker: 'partner', text: 'Now about astronomy…' }
  ] });
  expect(job.input_json).not.toContain('UNSENT'); expect(job.source_hash).toBe(hash(transcriptJson(store.messages(session.id))));
  expect(JSON.parse(job.source_messages).at(-1)).toMatchObject({ id: partial.id, delivery: 'interrupted' });
  expect(starterContext(session.starter_text, [{ ...partial, content: '' }]).turns).toEqual([]);
  expect(packet.active_questions).toHaveLength(20); expect(packet.recent_used_questions).toEqual([]);
  expect(packet.skip_history_status).toMatchObject({ status: 'observed_since_initialization', earlier_history: 'unavailable' });
});
it('freezes one independent random choice per eligible end, including skip-only drafts, and does not backfill empty ends', () => {
  const empty = newSession(); store.end(empty.id); expect(store.starterJob(empty.id)).toBeNull();
  const draft = newSession(); skip(draft.id); store.end(draft.id);
  const first = store.starterJob(draft.id)!; expect(JSON.parse(first.input_json).just_used_question_id).toBeNull();
  expect(JSON.parse(first.input_json).session_context.turns).toEqual([]);
  store.end(draft.id); expect(store.starterJob(draft.id)).toEqual(first);
  expect(end().job.model).toBe(starterGenerators[1].model); expect(end().job.model).toBe(starterGenerators[2].model);
  expect(choices).toEqual([3, 3, 3]);
});
it('acknowledges a duplicated skip without skipping again, rejects stale input, and preserves the draft', () => {
  const session = newSession(); store.saveDraft(session.id, 'Still typing.');
  skip(session.id, 'skip-once'); const next = store.session(session.id);
  store.replaceQuestion(session.id, 'skip-once', session.starter_id!, session.opening_revision); expect(store.session(session.id)).toEqual(next);
  expect(next.draft).toBe('Still typing.'); expect(next.starter_id).not.toBe(session.starter_id);
  expect(() => store.replaceQuestion(session.id, 'stale', session.starter_id!, next.opening_revision)).toThrow('starter_changed');
  expect(raw.prepare('SELECT COUNT(*) n FROM starter_skips').get()).toEqual({ n: 1 });
  expect(store.starterInventory().events.replacements).toBe(1);
});
it('caps used history at ten, collapses skips per question/session, and caps the ten-session skip window at twenty', () => {
  const history = [];
  for (let i = 0; i < 12; i++) {
    const session = newSession(); for (let j = 0; j < 25; j++) skip(session.id);
    store.submit(session.id, `Public answer ${i}.`); store.end(session.id); history.push(store.session(session.id));
  }
  const { session, job } = end('Current only.'); const packet = JSON.parse(job.input_json);
  expect(packet.recent_used_questions).toEqual(history.slice(-10).reverse().map(s => ({ question: s.starter_text, ended_at: s.ended_at })));
  expect(packet.just_used_question_id).toBe(session.starter_id); expect(packet.recent_skips).toHaveLength(20);
  expect(packet.recent_skips.every((s: any) => s.count === 1)).toBe(true);
  const expected = raw.prepare(`SELECT * FROM (SELECT *,rowid ordering,ROW_NUMBER() OVER(PARTITION BY session_id,normalized_text ORDER BY rowid DESC) n
    FROM starter_skips WHERE session_id IN (${history.slice(-10).map(() => '?').join(',')})) WHERE n=1 ORDER BY ordering DESC LIMIT 20`).all(...history.slice(-10).map(s => s.id)) as any[];
  expect(packet.recent_skips.map((s: any) => s.question_id)).toEqual(expected.map(s => s.outgoing_id));
  expect(store.starterInventory().slots.filter(s => s.pending_since)).toHaveLength(20);
  expect(store.starterInventory().events.fallbacks).toBeGreaterThan(0);
});
it('prefers fresh slots and relaxes only the oldest recent exclusions when necessary', () => {
  const slots = starters.map((q, i) => ({ ...q, slot: i + 1, pending_since: i < 19 ? '2026-09-01' : null }));
  expect(selectStarter(slots, [slots[19].id], undefined, () => 0)).toMatchObject({ question: slots[19], fallback: false, relaxed: true });
  const pending = slots.map(s => ({ ...s, pending_since: '2026-09-01' }));
  expect(selectStarter(pending, [], pending[0].id, () => 0)).toMatchObject({ question: pending[1], fallback: true });
});
it('saves a received pair once, refills the pending slot, and never overwrites a displayed draft', () => {
  const { session, job } = end(); const attempt = finish(session.id);
  const draft = newSession(); const before = store.messages(draft.id); const saved = store.starterInventory();
  expect(saved.slots).toHaveLength(20); expect(saved.slots.some(s => s.id === session.starter_id)).toBe(false);
  expect(saved.queued).toHaveLength(1); expect(store.messages(draft.id)).toEqual(before);
  store.saveStarter(attempt, 'What would a borrowed hour let you do?\nWhich idea would you keep in a pocket?', {});
  expect(store.starterInventory()).toEqual(saved); expect(store.starterJob(session.id)?.selected_attempt_id).toBe(attempt);
  expect(store.starterAttempts(job.id)).toHaveLength(1);
  expect(() => store.retryStarter(session.id, 'quality-retry')).toThrow('starter_not_retryable');
});
it('does not consume a new occupant when an old displayed question is answered after background replacement', () => {
  const { session } = end(); finish(session.id); const draft = newSession();
  // Reproduce a migrated/current draft retaining a previously consumed question.
  raw.prepare('UPDATE sessions SET starter_id=?,starter_version=?,starter_text=? WHERE id=?').run(session.starter_id, session.starter_version, session.starter_text, draft.id);
  raw.prepare('UPDATE messages SET content=? WHERE session_id=?').run(session.starter_text, draft.id);
  const slots = store.starterInventory().slots;
  store.submit(draft.id, 'Answering the question I saw.'); expect(store.starterInventory().slots).toEqual(slots);
});
it.each([0, 1, 2])('admits %i novel candidates without regenerating or removing any active slots', novel => {
  const { session } = end(); const existing = store.starterInventory().slots;
  const lines = [novel >= 1 ? 'Which cloud would make a good neighbor?' : existing[0].text,
    novel === 2 ? 'What makes an unfinished idea worthwhile?' : existing[1].text];
  const attempt = finish(session.id, lines.join('\n'));
  expect(store.starterAttempt(attempt).accepted_count).toBe(novel); expect(store.starterJob(session.id)?.state).toBe('completed');
  expect(store.starterInventory().slots).toHaveLength(20);
});
it('bounds the queue at forty, expires old unused entries, and preserves active questions past expiry', () => {
  for (let i = 0; i < 45; i++) { const { session } = end(); finish(session.id, `What could change on day ${i}?\nWhich thought belongs to hour ${i}?`); }
  const full = store.starterInventory(); expect(full.queued).toHaveLength(40);
  expect(full.counts.find(c => c.state === 'evicted')!.count).toBeGreaterThan(0);
  // The clock advances beyond the queue lifetime; original immutable timestamps remain intact.
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 31 * 86400_000);
  try {
    const activeIds = full.slots.map(s => s.id); newSession();
    expect(store.starterInventory().queued).toEqual([]); expect(store.starterInventory().slots.map(s => s.id)).toEqual(activeIds);
  } finally { vi.useRealTimers(); }
});
it('keeps identical snapshots through interrupted recovery and explicit retry without dispatching on reopen', () => {
  const { session, job } = end(); const attempt = store.starterAttempts(job.id)[0]; store.dispatchStarter(attempt.id);
  store.dispatchStarter(attempt.id); // Lost local acknowledgement, before any network send.
  store.close(); store = new Store(directory, native);
  expect(store.starterAttempt(attempt.id)).toMatchObject({ status: 'interrupted', failure: 'interrupted_unknown_outcome' });
  const retry = store.retryStarter(session.id, 'explicit-once');
  expect(store.retryStarter(session.id, 'explicit-once')).toEqual(retry);
  expect(store.starterJob(session.id)).toMatchObject({ input_json: job.input_json, config: job.config, model: job.model, state: 'pending' });
  expect(retry.parent_id).toBe(attempt.id); expect(retry.dispatched_at).toBeNull();
});
it('rejects schema v1 byte-for-byte before recovery and creates only fresh schema v2', () => {
  store.close(); const file = join(directory, 'stomylos.sqlite3'); rmSync(file);
  const v1 = new Database(file); v1.exec(goldens.legacy.schema); v1.pragma('user_version=1'); v1.close();
  const before = readFileSync(file); expect(() => new Store(directory, native)).toThrow('unsupported_schema_version');
  expect(readFileSync(file)).toEqual(before);
});
