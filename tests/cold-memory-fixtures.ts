import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../src/main/database';

export function coldFixture() {
  const directory = mkdtempSync('/tmp/stomylos-cold-');
  let store = new Store(directory, resolve('native/advisory-lock.node'));
  const db = new Database(join(directory, 'stomylos.sqlite3'));
  db.pragma('foreign_keys=ON');
  return {
    directory, db, get store() { return store; },
    reopen() { store.close(); store = new Store(directory, resolve('native/advisory-lock.node')); },
    close() { store.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
  };
}
export function coldSession(store: Store, text = 'I enjoy my projects.') {
  const session = store.createSession();
  store.searchMode(session.id, 'off'); store.selectManual(session.id, 'model_04');
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
