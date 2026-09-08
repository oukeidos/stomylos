import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { conversationSnapshot, grammarSnapshot } from '../src/main/contracts';
import { validateCommand } from '../src/main/ipc';
let directory: string, store: Store, raw: Database.Database;
const native = resolve('native/advisory-lock.node');
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stomylos-delete-')); store = new Store(directory, native);
  raw = (store as unknown as { db: Database.Database }).db;
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function end(text = 'I enjoy quiet museums.') {
  const id = store.createSession().id; store.submit(id, text);
  store.commitRoute(id, null, 'public', null); store.freezeMemory(id);
  const request = store.createRequest(id, 'chat', conversationSnapshot());
  store.dispatch(request.id); const message = store.prepareReply(id, request.id);
  store.finishReply(request.id, message.id, 'What do you enjoy seeing there?', {});
  store.end(id); return id;
}
function rows(table: string) { return raw.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all(); }
it('deletes all owned records atomically while preserving shared questions, memory and other chats', () => {
  const id = end();
  const grammar = store.createRequest(id, 'grammar', grammarSnapshot()); store.dispatch(grammar.id);
  store.saveAnalysis(grammar.id, JSON.stringify({ units: [{ text: 'I enjoy quiet museums.', corrected_text: 'I enjoy quiet museums.', explanation: 'No change needed.' }] }), {});
  const memory = store.prepareMemory(id, 'memory-public'); store.dispatchMemory(memory.id);
  const packet = JSON.parse(memory.input_json);
  store.saveMemory(memory.id, JSON.stringify({ operations: [{ op: 'add', id: null, category: 'traits', text: 'Enjoys quiet museums.', source_message_ids: [packet.session.messages.find((m: any) => m.origin === 'learner').id] }] }), {});
  store.advanceStarter(id);
  const attempt = store.starterAttempts(store.starterJob(id)!.id)[0]; store.dispatchStarter(attempt.id);
  store.saveStarter(attempt.id, 'What would a borrowed hour let you do?\nWhich idea would you keep in a pocket?', {});
  let questions = raw.prepare('SELECT * FROM starter_questions WHERE attempt_id=?').all(attempt.id) as any[];
  expect(questions).toHaveLength(2);
  const next = end('I enjoy astronomy.'); const nextView = store.view(next);
  questions = raw.prepare('SELECT * FROM starter_questions WHERE attempt_id=?').all(attempt.id) as any[];
  const shared = ['shared_memory', 'starter_slots'].map(rows);
  const assets = { speechKeys: ['a'.repeat(64)], dictationIds: ['00000000-0000-0000-0000-000000000000'] };
  store.deleteSession(id, assets);
  expect(store.deletionAssets(id)).toEqual(assets);
  expect(() => store.view(id)).toThrow('session_not_found'); expect(store.view(next)).toEqual(nextView);
  expect(['shared_memory', 'starter_slots'].map(rows)).toEqual(shared);
  for (const q of questions) expect(raw.prepare('SELECT * FROM starter_questions WHERE id=?').get(q.id)).toEqual({ ...q, origin: 'detached', attempt_id: null, ordinal: null });
  for (const table of ['sessions', 'messages', 'model_requests', 'grammar_units', 'route_decisions', 'starter_events', 'starter_skips', 'session_memories', 'memory_jobs', 'starter_renewal_jobs']) {
    expect(raw.prepare(`SELECT count(*) n FROM ${table} WHERE ${table === 'sessions' ? 'id' : 'session_id'}=?`).get(id)).toEqual({ n: 0 });
  }
  expect(store.pendingDeletions()).toEqual([id]); expect(store.integrity().foreignKeys).toEqual([]);
  store.deleteSession(id); store.close(); store = new Store(directory, native);
  expect(store.pendingDeletions()).toEqual([id]); expect(store.deletionAssets(id)).toEqual(assets); store.finishDeletion(id); store.deleteSession(id);
  expect(store.pendingDeletions()).toEqual([]); expect(store.view(next)).toBeDefined();
});
it('retains immutable-message protection, rejects unfinished deletion and rolls back a failing deletion', () => {
  const draft = store.createSession().id;
  expect(() => store.deleteSession(draft)).toThrow('delete_requires_ended');
  store.submit(draft, 'An immutable submitted message.');
  expect(() => raw.prepare('DELETE FROM messages WHERE session_id=?').run(draft)).toThrow('immutable');
  store.end(draft); const before = store.view(draft);
  raw.exec("CREATE TRIGGER injected_delete_failure BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'injected'); END");
  expect(() => store.deleteSession(draft)).toThrow('injected');
  expect(store.view(draft)).toEqual(before); expect(store.pendingDeletions()).toEqual([]);
  expect(() => raw.prepare('DELETE FROM messages WHERE session_id=?').run(draft)).toThrow('immutable');
  raw.exec('DROP TRIGGER injected_delete_failure'); store.deleteSession(draft);
  expect(store.integrity().foreignKeys).toEqual([]);
});
it('releases a failed memory job blocker without modifying already applied memory', () => {
  const first = end(); const partner = store.session(first).character;
  const attempt = store.prepareMemory(first, 'failed-memory'); store.dispatchMemory(attempt.id); store.failMemory(attempt.id, 'public_failure', null, {});
  const second = store.createSession().id; store.selectManual(second, partner); store.submit(second, 'A second topic.'); store.commitRoute(second, null, 'public', null); store.freezeMemory(second); store.end(second);
  expect(store.view(second).memory.blockedBy).toBe(first);
  const current = rows('shared_memory'); store.deleteSession(first);
  expect(store.memoryReady([second])).toBe(second); expect(rows('shared_memory')).toEqual(current);
});
it('refuses a schema-v3 database without writing or recovering it', () => {
  store.close(); rmSync(join(directory, 'stomylos.sqlite3'));
  const old = new Database(join(directory, 'stomylos.sqlite3')); old.exec(readFileSync('tests/fixtures/schema-v3.sql', 'utf8')); old.pragma('user_version=3'); old.close();
  const before = readFileSync(join(directory, 'stomylos.sqlite3'));
  expect(() => new Store(directory, native)).toThrow('external_migration_required');
  expect(readFileSync(join(directory, 'stomylos.sqlite3'))).toEqual(before);
});
it('accepts only a bounded session ID and no renderer-provided deletion paths or SQL', () => {
  validateCommand('deleteSession', { sessionId: 'public-id' }); validateCommand('retryDeletionCleanup', undefined);
  for (const args of [{ sessionId: '../data' }, { sessionId: 's', path: '/tmp' }, { sessionId: 's', sql: 'DELETE' }, {}]) expect(() => validateCommand('deleteSession', args)).toThrow('invalid_command');
});
