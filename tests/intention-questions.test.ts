import selectedIntention from './fixtures/intention-selected.json';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { hash } from '../src/main/contracts';
import { emptyMemory, memoryHash, memoryJson } from '../src/main/memory-updater';
import { intentionBody, intentionConfig, intentionDiff, intentionFallback, parseIntentionQuestion } from '../src/main/intention-questions';
import { validateCommand } from '../src/main/ipc';
let directory: string, store: Store, raw: Database.Database;
const native = resolve('native/advisory-lock.node');
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'stomylos-intentions-')); store = new Store(directory, native); raw = (store as unknown as { db: Database.Database }).db; });
afterEach(() => { vi.useRealTimers(); store.close(); rmSync(directory, { recursive: true, force: true }); });
function ended() {
  const s = store.createSession(); store.searchMode(s.id, 'off'); store.selectManual(s.id, 'model_04');
  const message = store.submit(s.id, 'I am considering a trip.'); store.commitRoute(s.id, null, 'fixture', null); store.end(s.id);
  const attempt = store.prepareMemory(s.id, randomUUID()); store.dispatchMemory(attempt.id);
  return { id: s.id, message, attempt };
}
function memory(operations: any[]) {
  const s = ended(), content = JSON.stringify({ operations: operations.map(op => ({ ...op, source_message_ids: [s.message.id] })) });
  const doc = store.saveMemory(s.attempt.id, content, {}); return { ...s, doc, content, jobs: store.intentionJobs(s.id) };
}
const add = (text = 'Wants to plan a trip.') => ({ op: 'add', id: null, category: 'intentions', text });
const update = (id: string, text: string) => ({ op: 'update', id, category: 'intentions', text });
const remove = (id: string) => ({ op: 'delete', id, category: null, text: null });
function accept(id: string, question = 'What kind of trip would you like to plan?') {
  const a = store.dispatchIntention(id, randomUUID())!; expect(a).not.toBeNull();
  store.receiveIntention(a.id, question, { usage: { cost: 0.001 } }); store.acceptIntention(id); return a;
}
it('pins all tested inputs, prompt bytes, routes and reasoning without adding context', () => {
  const config = intentionConfig(), saved = selectedIntention.routes;
  expect(hash(config.prompt)).toBe(selectedIntention.prompt_sha256);
  expect(config.routes.map((route: any) => route.parameters.model)).toEqual(saved.map(route => route.model));
  for (const [i, route] of config.routes.entries()) {
    const row = saved.find((r: any) => r.model === route.parameters.model);
    if (!row) throw new Error('Missing frozen Intention route');
    expect(route.parameters.reasoning).toEqual(row.reasoning);
    expect(route.parameters.max_tokens).toBe(row.max_tokens);
    expect(route.parameters.provider.only).toEqual([row.provider_tag]);
    const input = JSON.stringify({ operation: 'add', intention: 'Try drawing.' });
    expect(intentionBody(config, input, i).messages).toEqual([{ role: 'system', content: config.prompt }, { role: 'user', content: input }]);
  }
  const corrupt = structuredClone(config); corrupt.routes[0].parameters.temperature = 1;
  expect(() => intentionBody(corrupt, '{}', 0)).toThrow('intention_config_changed');
  expect(() => validateCommand('retryIntentionQuestions', { sessionId: 'id' })).not.toThrow();
});
it('validates one question while tolerating quoted titles and plain unremarkable questions', () => {
  for (const q of ['What would you like to try?', 'What did “Why?” mean to you?', "How would reading 'Why?' fit your plans?"]) expect(parseIntentionQuestion('  ' + q + '  ')).toBe(q);
  for (const q of ['One? Two?', '1. What next?', 'Question: What next?', 'What next?\nSomething else?', 'No.', '```What next?']) expect(() => parseIntentionQuestion(q)).toThrow('intention_output_format');
  for (const code of ['http_429','http_503','request_timeout','response_identity','intention_output_format']) expect(intentionFallback(code)).toBe(true);
  for (const code of ['http_401','http_402','operation_failed','request_cancelled','intention_config_changed']) expect(intentionFallback(code)).toBe(false);
});
it('diffs category membership and exact text, not global document revisions', () => {
  expect(intentionDiff([{ id: 'a', text: 'A' }], [{ id: 'a', text: 'A' }])).toEqual([]);
  expect(intentionDiff([{ id: 'a', text: 'A' }], [{ id: 'b', text: 'B' }])).toEqual([{ id: 'a', previous: 'A', text: null }, { id: 'b', previous: null, text: 'B' }]);
});
it('freezes ordinary input only after the accepted question is committed and shown in active or queue', () => {
  const s = memory([add()]); expect(store.starterJob(s.id)).toBeNull(); expect(store.advanceStarter(s.id)).toBe(false);
  const a = accept(s.jobs[0].id); expect(store.advanceStarter(s.id)).toBe(true);
  const job = store.starterJob(s.id)!, input = JSON.parse(job.input_json);
  expect([...input.active_questions.map((q: any) => q.text), ...input.queued_candidates]).toContain('What kind of trip would you like to plan?');
  store.receiveIntention(a.id, 'What kind of trip would you like to plan?', {}); store.acceptIntention(s.jobs[0].id); store.advanceStarter(s.id);
  expect(store.starterJob(s.id)).toEqual(job); expect(store.intentionJobs(s.id)).toHaveLength(1);
  expect(store.integrity().foreignKeys).toEqual([]);
});
it('rolls back memory and question jobs together, including invalidation failures', () => {
  const s = ended(); raw.exec("CREATE TEMP TRIGGER inject_job BEFORE INSERT ON intention_question_jobs BEGIN SELECT RAISE(ABORT,'injected'); END");
  const content = JSON.stringify({ operations: [{ ...add(), source_message_ids: [s.message.id] }] });
  expect(() => store.saveMemory(s.attempt.id, content, {})).toThrow('injected');
  expect(store.view(s.id).memory.current!.intentions).toEqual([]); expect(store.intentionJobs(s.id)).toEqual([]);
  expect(store.memoryJob(s.id)?.state).toBe('running'); raw.exec('DROP TRIGGER inject_job');
  store.saveMemory(s.attempt.id, content, {}); store.saveMemory(s.attempt.id, content, {}); expect(store.intentionJobs(s.id)).toHaveLength(1);
});
it('rejects late A after A to B to A, but permits unchanged items across unrelated memory updates', () => {
  const a = memory([add('A plan.')]), item = a.doc.intentions[0].id;
  const pending = store.dispatchIntention(a.jobs[0].id, randomUUID())!;
  const b = memory([update(item, 'B plan.')]); const again = memory([update(item, 'A plan.')]);
  store.receiveIntention(pending.id, 'What would you like to plan?', {}); store.acceptIntention(a.jobs[0].id);
  expect(store.intentionJob(a.jobs[0].id).state).toBe('superseded'); expect(store.intentionJob(b.jobs[0].id).state).toBe('superseded');
  memory([{ op: 'add', id: null, category: 'traits', text: 'Enjoys museums.' }]);
  accept(again.jobs[0].id); expect(store.intentionJob(again.jobs[0].id).state).toBe('accepted');
  const noOp = memory([update(item, 'A plan.')]); expect(noOp.jobs).toEqual([]);
});
it('uses the last successful question on update and never resurrects unchanged consumed or expired candidates', () => {
  const first = memory([add()]); accept(first.jobs[0].id); const qid = store.intentionJob(first.jobs[0].id).question_id!;
  const draft = store.createSession();
  raw.prepare("UPDATE sessions SET starter_id=?,starter_text=?,starter_version='stomylos_intention_questions_v1' WHERE id=?").run(qid, 'What kind of trip would you like to plan?', draft.id);
  raw.prepare("UPDATE messages SET content=? WHERE session_id=? AND origin='starter'").run('What kind of trip would you like to plan?', draft.id);
  store.submit(draft.id, 'A quiet trip.'); store.end(draft.id); // No selected model, no memory update.
  const unchanged = memory([]); expect(unchanged.jobs).toEqual([]);
  const changed = memory([update(first.doc.intentions[0].id, 'Wants a quiet trip.')]);
  expect(JSON.parse(changed.jobs[0].input_json)).toMatchObject({ operation: 'update', existing_question: 'What kind of trip would you like to plan?' });
});
it('invalidates the displayed draft without losing text and preserves submitted history', () => {
  const first = memory([add()]); accept(first.jobs[0].id); const qid = store.intentionJob(first.jobs[0].id).question_id!;
  const second = ended(); // Create another update while preserving a new unsent draft.
  const draft = store.createSession();
  raw.prepare("UPDATE sessions SET starter_id=?,starter_text=?,starter_version='stomylos_intention_questions_v1',draft='Keep my words.' WHERE id=?").run(qid, 'What kind of trip would you like to plan?', draft.id);
  raw.prepare("UPDATE messages SET content=? WHERE session_id=? AND origin='starter'").run('What kind of trip would you like to plan?', draft.id);
  const oldHistory = store.messages(first.id);
  store.saveMemory(second.attempt.id, JSON.stringify({ operations: [{ ...remove(first.doc.intentions[0].id), source_message_ids: [second.message.id] }] }), {});
  expect(store.view(draft.id).outdatedOpening).toBe(true); expect(() => store.submit(draft.id, 'Keep my words.')).toThrow('starter_outdated');
  expect(store.session(draft.id).draft).toBe('Keep my words.'); expect(store.messages(first.id)).toEqual(oldHistory);
  store.replaceQuestion(draft.id, randomUUID(), qid, draft.opening_revision); expect(store.view(draft.id).outdatedOpening).toBe(false);
  expect(store.session(draft.id).draft).toBe('Keep my words.'); expect(store.starterInventory().slots).toHaveLength(20);
});
it('marks duplicate output complete without adopting the unrelated candidate or advancing fallback', () => {
  const first = memory([add()]); const ordinary = store.starterInventory().slots[1];
  accept(first.jobs[0].id, ordinary.text); expect(store.intentionJob(first.jobs[0].id).state).toBe('duplicate');
  const d = memory([remove(first.doc.intentions[0].id)]); expect(d.jobs).toEqual([]);
  expect(store.starterInventory().slots.some(q => q.id === ordinary.id)).toBe(true);
});
it('does not charge another call after a received response survives a local acceptance failure and restart', () => {
  const first = memory([add()]), job = first.jobs[0], a = store.dispatchIntention(job.id, randomUUID())!;
  store.receiveIntention(a.id, 'What kind of trip would you like to plan?', {});
  raw.exec("CREATE TEMP TRIGGER inject_candidate BEFORE INSERT ON starter_questions BEGIN SELECT RAISE(ABORT,'injected'); END");
  expect(() => store.acceptIntention(job.id)).toThrow('injected'); expect(store.intentionJob(job.id).state).toBe('received');
  raw.exec('DROP TRIGGER inject_candidate'); store.close(); store = new Store(directory, native); raw = (store as unknown as { db: Database.Database }).db;
  expect(store.intentionJob(job.id).state).toBe('accepted'); expect(store.intentionJobs(first.id)).toHaveLength(1);
  expect(store.view(first.id).intentions?.jobs[0].attempts).toHaveLength(1);
});
it('records fallback attempts once and requires explicit retry after interruption or terminal account failure', () => {
  const first = memory([add()]), job = first.jobs[0];
  const a = store.dispatchIntention(job.id, 'route0')!; store.failIntention(a.id, 'http_429', null, {});
  const b = store.dispatchIntention(job.id, 'route1')!; expect(b.route).toBe(1); expect(store.dispatchIntention(job.id, 'route1')).toEqual(b);
  store.failIntention(b.id, 'http_401', null, {}); expect(store.intentionJob(job.id).state).toBe('failed'); expect(store.dispatchIntention(job.id, 'forbidden')).toBeNull();
  store.retryIntentions(first.id); store.retryIntentions(first.id); const c = store.dispatchIntention(job.id, 'retry')!; expect(c).toMatchObject({ run: 2, route: 0 });
  store.close(); store = new Store(directory, native); raw = (store as unknown as { db: Database.Database }).db;
  expect(store.intentionJob(job.id).state).toBe('interrupted'); expect(store.dispatchIntention(job.id, 'startup')).toBeNull();
});
it('releases partial batches at deadline and never recreates a frozen ordinary job on later retry', () => {
  const s = memory([add('A trip.'), add('A painting.')]); accept(s.jobs[0].id);
  raw.prepare("UPDATE intention_question_jobs SET deadline='2000-01-01' WHERE id=?").run(s.jobs[1].id);
  expect(store.advanceStarter(s.id)).toBe(true); const job = store.starterJob(s.id);
  expect(store.intentionJob(s.jobs[1].id).state).toBe('interrupted'); store.retryIntentions(s.id); accept(s.jobs[1].id, 'What would you like to paint?');
  store.advanceStarter(s.id); expect(store.starterJob(s.id)).toEqual(job);
});
it('bootstraps existing intentions once after a future successful memory save and does not run during startup', () => {
  const doc = emptyMemory('shared'); doc.intentions = [{ id: 'existing', text: 'Try painting.' }]; const encoded = memoryJson(doc);
  raw.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(encoded, memoryHash(encoded));
  expect(store.intentionJobs(store.createSession().id)).toEqual([]);
  const initial = memory([]); expect(initial.jobs).toHaveLength(1); const later = memory([]); expect(later.jobs).toEqual([]);
});
it('preserves accepted shared questions and ledgers while detaching a deleted source conversation', () => {
  const first = memory([add(), add('Try painting.')]); accept(first.jobs[0].id); const question = store.intentionJob(first.jobs[0].id).question_id;
  store.deleteSession(first.id); expect(store.intentionJob(first.jobs[0].id).session_id).toBeNull();
  expect(store.intentionJob(first.jobs[1].id).state).toBe('superseded');
  expect(raw.prepare('SELECT id FROM starter_questions WHERE id=?').get(question)).toBeDefined(); expect(store.integrity().foreignKeys).toEqual([]);
});
it('replaces all twenty invalid active questions offline when no queued candidate exists', () => {
  const doc = emptyMemory('shared'); doc.intentions = Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, text: `Explore project ${i}.` }));
  const encoded = memoryJson(doc); raw.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(encoded, memoryHash(encoded));
  const batch = memory([]);
  raw.prepare("UPDATE starter_slots SET pending_since='2026-01-01',pending_reason='answered'").run();
  batch.jobs.forEach((job, i) => accept(job.id, `What interests you about project ${i}?`));
  expect(store.starterInventory().queued).toHaveLength(0);
  expect(store.starterInventory().slots.every(q => q.version === 'stomylos_intention_questions_v1')).toBe(true);
  const deleted = memory(doc.intentions.map(i => remove(i.id))); expect(deleted.jobs).toEqual([]);
  const slots = store.starterInventory().slots; expect(slots).toHaveLength(20); expect(new Set(slots.map(q => q.text)).size).toBe(20);
  expect(slots.every(q => q.version !== 'stomylos_intention_questions_v1')).toBe(true);
  expect(store.createSession().starter_text).toBeTruthy(); expect(store.integrity().foreignKeys).toEqual([]);
});
it('handles moves out of and back into intentions, including a stale parked draft', () => {
  const first = memory([add()]); accept(first.jobs[0].id); const qid = store.intentionJob(first.jobs[0].id).question_id!;
  const second = ended(), draft = store.createSession();
  raw.prepare("UPDATE sessions SET starter_id=?,starter_text=?,starter_version='stomylos_intention_questions_v1',draft='Saved words.' WHERE id=?").run(qid, 'What kind of trip would you like to plan?', draft.id);
  raw.prepare("UPDATE messages SET content=? WHERE session_id=? AND origin='starter'").run('What kind of trip would you like to plan?', draft.id);
  store.setOpening(draft.id, 'park', draft.opening_revision, 'user');
  store.saveMemory(second.attempt.id, JSON.stringify({ operations: [{ op: 'update', id: first.doc.intentions[0].id, category: 'experiences', text: 'Cancelled the trip.', source_message_ids: [second.message.id] }] }), {});
  store.setOpening(draft.id, 'restore', store.session(draft.id).opening_revision, 'starter');
  expect(store.session(draft.id).starter_id).not.toBe(qid); expect(store.session(draft.id).draft).toBe('Saved words.');
  store.end(draft.id);
  const restored = memory([update(first.doc.intentions[0].id, 'Plan a trip again.')]);
  expect(JSON.parse(restored.jobs[0].input_json).operation).toBe('add');
});
it('releases at the preparation deadline without cancelling memory or dispatching questions early', () => {
  const s = ended(); expect(store.advanceStarter(s.id)).toBe(false);
  raw.prepare("UPDATE starter_preparations SET deadline='2000-01-01' WHERE session_id=?").run(s.id);
  expect(store.advanceStarter(s.id)).toBe(true); expect(store.memoryJob(s.id)?.state).toBe('running');
  const frozen = store.starterJob(s.id);
  store.saveMemory(s.attempt.id, JSON.stringify({ operations: [{ ...add(), source_message_ids: [s.message.id] }] }), {});
  accept(store.intentionJobs(s.id)[0].id); store.advanceStarter(s.id); expect(store.starterJob(s.id)).toEqual(frozen);
});
