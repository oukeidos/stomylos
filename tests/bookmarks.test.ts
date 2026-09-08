import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { validateCommand } from '../src/main/ipc';
import { v5Snapshot } from './time-fixtures';

let directory: string, store: Store, raw: Database.Database;
const native = resolve('native/advisory-lock.node');
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stomylos-bookmarks-'));
  store = new Store(directory, native); raw = (store as unknown as { db: Database.Database }).db;
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function chat(index: number, ended = true) {
  const s = store.createSession();
  if (index % 2) store.setOpening(s.id, randomUUID(), s.opening_revision, 'user');
  store.submit(s.id, `A public conversation about topic ${index}.`);
  if (ended) store.end(s.id);
  return s.id;
}
function originalRows() {
  return Object.fromEntries((raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='session_bookmarks' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, raw.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).raw().all()]));
}

it('filters the complete library before paging and preserves deterministic creation order', () => {
  const ids = Array.from({ length: 83 }, (_, i) => chat(i));
  raw.prepare("UPDATE sessions SET created_at='2026-09-07T00:00:00Z'").run();
  ids.filter((_, i) => i % 2 === 0).forEach(id => store.setSessionBookmark(id, true));
  const expected = ids.filter((_, i) => i % 2 === 0).sort().reverse();
  const first = store.sessionPage(0, 'bookmarked'), second = store.sessionPage(40, 'bookmarked');
  expect(first.sessions.map(s => s.id)).toEqual(expected.slice(0, 40));
  expect(first).toMatchObject({ hasMore: true, offset: 0, filter: 'bookmarked' });
  expect(second.sessions.map(s => s.id)).toEqual(expected.slice(40));
  expect(second.hasMore).toBe(false);
  expect([...first.sessions, ...second.sessions].every(s => s.bookmarked === true && s.canBookmark === true)).toBe(true);
  expect(store.sessionPage().sessions.map(s => s.id)).toEqual(ids.sort().reverse().slice(0, 40));
  expect(store.sessionPage(80).sessions).toHaveLength(3);
  const before = store.sessionPage().sessions.map(s => s.id);
  store.setSessionBookmark(expected.at(-1)!, false); store.setSessionBookmark(expected.at(-1)!, true);
  expect(store.sessionPage().sessions.map(s => s.id)).toEqual(before);
});

it('refills a filtered page and clamps its last removal without changing the selected source', () => {
  const ids = Array.from({ length: 42 }, (_, i) => chat(i)); ids.forEach(id => store.setSessionBookmark(id, true));
  const first = store.sessionPage(0, 'bookmarked'), last = store.sessionPage(40, 'bookmarked');
  store.setSessionBookmark(first.sessions[0].id, false);
  expect(store.sessionPage(0, 'bookmarked').sessions.at(-1)!.id).toBe(last.sessions[0].id);
  const final = store.sessionPage(40, 'bookmarked').sessions[0].id;
  const source = store.view(final); store.setSessionBookmark(final, false);
  expect(store.sessionPage(40, 'bookmarked')).toMatchObject({ offset: 0, hasMore: false });
  expect(store.sessionPage(40, 'bookmarked').sessions).toHaveLength(40);
  expect(store.view(final)).toEqual({ ...source, bookmarked: false });
  ids.forEach(id => store.setSessionBookmark(id, false));
  expect(store.sessionPage(80, 'bookmarked')).toEqual({ offset: 0, filter: 'bookmarked', hasMore: false, sessions: [] });
});

it('requires a committed learner message for starter and user openings, including ended skips', () => {
  const s = store.createSession(); expect(store.view(s.id)).toMatchObject({ bookmarked: false, canBookmark: false });
  store.saveDraft(s.id, 'Unsent text');
  expect(() => store.setSessionBookmark(s.id, true)).toThrow('bookmark_requires_message');
  store.end(s.id); expect(() => store.setSessionBookmark(s.id, true)).toThrow('bookmark_requires_message');
  const active = chat(1, false); store.setSessionBookmark(active, true);
  expect(store.unfinished()).toMatchObject({ id: active, bookmarked: true, canBookmark: true });
  store.setSessionBookmark(active, false);
  expect(store.sessionPage(0, 'bookmarked').sessions).toEqual([]);
  expect(store.unfinished()?.id).toBe(active);
});

it('replays desired states without modifying any source row or historical contract and persists restart', () => {
  const old = chat(2), active = chat(1, false);
  raw.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(v5Snapshot()), old);
  const before = originalRows();
  for (const id of [old, active]) {
    store.setSessionBookmark(id, true); store.setSessionBookmark(id, true);
    store.setSessionBookmark(id, false); store.setSessionBookmark(id, false); store.setSessionBookmark(id, true);
  }
  expect(raw.prepare('SELECT COUNT(*) n FROM session_bookmarks').get()).toEqual({ n: 2 });
  expect(originalRows()).toEqual(before);
  for (let i = 0; i < 2; i++) {
    store.close(); store = new Store(directory, native);
    expect(store.view(old).bookmarked).toBe(true); expect(store.view(active).bookmarked).toBe(true);
    expect(store.integrity().foreignKeys).toEqual([]);
  }
});

it('rolls back marks with a failed source deletion and never recreates a deleted conversation', () => {
  const id = chat(0); store.setSessionBookmark(id, true);
  raw.exec("CREATE TRIGGER test_delete_failure BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'test_failure'); END");
  expect(() => store.deleteSession(id)).toThrow('test_failure'); expect(store.view(id).bookmarked).toBe(true);
  raw.exec('DROP TRIGGER test_delete_failure'); store.deleteSession(id);
  expect(raw.prepare('SELECT * FROM session_bookmarks').all()).toEqual([]);
  for (const value of [true, false]) expect(() => store.setSessionBookmark(id, value)).toThrow('session_not_found');
  expect(store.integrity().foreignKeys).toEqual([]);
});

it('leaves the frozen model request and reconstructed context byte-equivalent through marking', () => {
  const id = store.createSession().id; store.searchMode(id, 'off');
  store.submit(id, 'A request whose exact context must remain unchanged.');
  store.commitRoute(id, null, 'public', null); store.freezeMemory(id);
  const request = store.prepareChat(id, randomUUID()), body = JSON.stringify(store.chatBody(request.id));
  const before = originalRows();
  for (const marked of [true, false, true]) {
    store.setSessionBookmark(id, marked);
    expect(store.prepareChat(id, request.id)).toEqual(request);
    expect(JSON.stringify(store.chatBody(request.id))).toBe(body);
    expect(originalRows()).toEqual(before);
  }
});

it('validates filter, offset, desired state and IDs at the IPC boundary', () => {
  for (const filter of ['all', 'bookmarked']) validateCommand('listSessions', { offset: 0, filter });
  validateCommand('listSessions', { offset: 40 });
  validateCommand('setSessionBookmark', { sessionId: 'public-id', bookmarked: false });
  for (const args of [{ offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: 0, filter: 'saved' }, { offset: 0, sql: 'x' }])
    expect(() => validateCommand('listSessions', args)).toThrow('invalid_command');
  for (const args of [{ sessionId: 'id', bookmarked: 1 }, { sessionId: 'id' }, { sessionId: '../id', bookmarked: true }, { sessionId: 'id', bookmarked: true, sql: 'x' }])
    expect(() => validateCommand('setSessionBookmark', args)).toThrow('invalid_command');
});
