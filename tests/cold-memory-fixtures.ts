import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../src/main/database';

const stores=new WeakMap<Store,Database.Database>();

export function coldFixture() {
  const directory = mkdtempSync('/tmp/stomylos-cold-');
  let store = new Store(directory, 'isolated' as const);
  const db = new Database(join(directory, 'stomylos.sqlite3'));
  db.pragma('foreign_keys=ON');stores.set(store,db);
  return {
    directory, db, get store() { return store; },
    reopen() { store.close(); store = new Store(directory, 'isolated' as const);stores.set(store,db); },
    close() { store.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
  };
}
export function coldSession(store: Store, text = 'I enjoy my projects.') {
  const session = store.createSession();
  // These fixtures exercise historical per-turn ADD, not new session extraction.
  const db=stores.get(store)!;db.exec('DROP TRIGGER immutable_memory_add_scope');
  db.prepare("UPDATE sessions SET memory_add_scope='turn' WHERE id=?").run(session.id);
  db.exec("CREATE TRIGGER immutable_memory_add_scope BEFORE UPDATE OF memory_add_scope ON sessions BEGIN SELECT RAISE(ABORT, 'Immutable memory ADD scope'); END");
  store.searchMode(session.id, 'off'); store.selectManual(session.id, 'model_01');
  store.submit(session.id, text); store.commitRoute(session.id, null, 'fixture', null);
  const chat = store.startChat(store.prepareChat(session.id, crypto.randomUUID()).id);
  store.finishReply(chat.request.id, chat.bubble.id, 'Tell me more.', {});
  return session;
}
export function receiveNotes(store: Store, texts: string[]) {
  const job = store.memoryAddReady()!;
  const attempt = store.prepareMemoryAdd(job.ordinal, crypto.randomUUID());
  store.prepareProvider('memory_add', attempt.id, JSON.parse(attempt.body), JSON.parse(job.config).identity);
  store.dispatchMemoryAdd(attempt.id);
  store.receiveMemoryAdd(attempt.id, JSON.stringify({ add: texts }), {});
  return attempt;
}
