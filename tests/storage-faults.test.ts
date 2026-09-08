import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { conversationSnapshot, grammarSnapshot } from '../src/main/contracts';
let directory: string; let store: Store; let raw: Database.Database;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stomylos-fault-')); store = new Store(directory, resolve('native/advisory-lock.node'));
  // Deliberate native-driver fault injection, never part of renderer IPC.
  raw = (store as unknown as { db: Database.Database }).db;
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function source() {
  const session = store.createSession(); store.submit(session.id, 'I enjoy a walk.');
  store.commitRoute(session.id, null, 'public_fixture', null);
  const reply = store.createRequest(session.id, 'chat', conversationSnapshot()); store.dispatch(reply.id);
  const bubble = store.prepareReply(session.id, reply.id); store.finishReply(reply.id, bubble.id, 'A walk changes the pace of the day.', {});
  store.submit(session.id, 'I enjoy a walk.'); store.end(session.id);
  const request = store.createRequest(session.id, 'grammar', grammarSnapshot()); store.dispatch(request.id);
  return { id: session.id, request: request.id, content: JSON.stringify({ units: Array.from({ length: 2 }, (_, index) => ({ index, corrected_text: 'I enjoy a walk.', explanation: '' })) }) };
}
it('rolls back all units and selection when insertion fails halfway through', () => {
  const input = source();
  raw.exec("CREATE TEMP TRIGGER fail_second BEFORE INSERT ON grammar_units WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT, 'injected second-unit failure'); END");
  expect(() => store.saveAnalysis(input.request, input.content, {})).toThrow('injected second-unit failure');
  expect(raw.prepare('SELECT COUNT(*) AS n FROM grammar_units').get()).toEqual({ n: 0 });
  expect(store.session(input.id)).toMatchObject({ analysis_state: 'running', selected_analysis_id: null });
  expect(store.request(input.request).status).toBe('dispatched');
  raw.exec('DROP TRIGGER fail_second'); store.saveAnalysis(input.request, input.content, {});
  expect(store.units(input.id)).toHaveLength(2);
});
it('survives SQLITE_FULL without partial draft loss and saves the same text after space becomes available', () => {
  const session = store.createSession(); store.saveDraft(session.id, 'Previous draft');
  const limit = raw.pragma('page_count', { simple: true }); raw.pragma(`max_page_count=${limit}`);
  const text = 'Exact unsaved draft. '.repeat(4000);
  expect(() => store.saveDraft(session.id, text)).toThrow(/full/);
  expect(store.session(session.id).draft).toBe('Previous draft');
  raw.pragma('max_page_count=10000'); store.saveDraft(session.id, text);
  expect(store.session(session.id).draft).toBe(text);
  expect(store.integrity()).toEqual({ integrity: [{ integrity_check: 'ok' }], foreignKeys: [] });
});
it('does not accept analysis when SQLite is read-only and makes the exact commit retry idempotent', () => {
  const input = source(); raw.pragma('query_only=ON');
  expect(() => store.saveAnalysis(input.request, input.content, {})).toThrow(/readonly/);
  expect(store.units(input.id)).toEqual([]); expect(store.request(input.request).status).toBe('dispatched');
  raw.pragma('query_only=OFF'); store.saveAnalysis(input.request, input.content, {});
  // Repeat after a hypothetical acknowledgement loss: no new rows or requests.
  const requestCount = store.requests(input.id).length; store.saveAnalysis(input.request, input.content, {});
  expect(store.units(input.id)).toHaveLength(2); expect(store.requests(input.id)).toHaveLength(requestCount);
});
it.each(['readonly', 'full', 'second-candidate'])('keeps renewal response admission atomic after a %s storage failure', fault => {
  const input = source(); store.skipMemory(input.id); store.advanceStarter(input.id); const job = store.starterJob(input.id)!; const attempt = store.starterAttempts(job.id)[0];
  store.dispatchStarter(attempt.id); const before = store.starterInventory();
  const content = fault === 'full' ? `${'Public long question '.repeat(6000)}?\nWhere do thoughts rest?` : 'What would a quiet city notice?\nWhere do thoughts rest?';
  if (fault === 'readonly') raw.pragma('query_only=ON');
  if (fault === 'full') raw.pragma(`max_page_count=${raw.pragma('page_count', { simple: true })}`);
  if (fault === 'second-candidate') raw.exec("CREATE TEMP TRIGGER fail_candidate BEFORE INSERT ON starter_questions WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT, 'injected candidate failure'); END");
  expect(() => store.saveStarter(attempt.id, content, {})).toThrow();
  expect(store.starterInventory()).toEqual(before); expect(store.starterAttempt(attempt.id).status).toBe('dispatched');
  expect(store.starterJob(input.id)?.selected_attempt_id).toBeNull();
  raw.pragma('query_only=OFF'); raw.pragma('max_page_count=10000'); raw.exec('DROP TRIGGER IF EXISTS temp.fail_candidate');
  store.saveStarter(attempt.id, content, {}); store.saveStarter(attempt.id, content, {});
  expect(store.starterAttempt(attempt.id).accepted_count).toBe(2); expect(store.starterJob(input.id)?.state).toBe('completed');
  expect(store.integrity()).toEqual({ integrity: [{ integrity_check: 'ok' }], foreignKeys: [] });
});
