import { convertToCurrent } from './conversion-chain';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { StarterStore } from '../src/main/starter-store';
import { universalSnapshot } from './time-fixtures';
import { conversationBody, conversationRequestSnapshot, hash, transcriptJson } from '../src/main/contracts';
import type { Message } from '../src/shared/types';
// @ts-expect-error The external converter uses the Electron dependency runtime.
import { convertSearch } from '../scripts/convert-search.mjs';
let directory: string, file: string;
const native = resolve('native/advisory-lock.node');
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stomylos-search-conversion-')); file = join(directory, 'stomylos.sqlite3');
  const db = new Database(file); db.exec(readFileSync('tests/fixtures/schema-v7-before-search.sql', 'utf8')); db.pragma('user_version=7');
  new StarterStore(db).initialize();
  const q = db.prepare('SELECT * FROM starter_questions LIMIT 1').get() as any;
  db.prepare("INSERT INTO sessions(id,state,starter_id,starter_version,starter_text,created_at,chat_config,draft) VALUES('old','draft',?,?,?,?,?,?)")
    .run(q.id, q.version, q.text, '2026-09-05T00:00:00Z', JSON.stringify(universalSnapshot(true)), 'An exact draft.\r\n');
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES('starter','old',0,'assistant',?,'starter','complete')").run(q.text);
  db.close();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
it('requires external conversion, preserves all original columns and defaults only future chats to Auto', () => {
  const original = readFileSync(file); expect(() => new Store(directory, native)).toThrow('external_migration_required');
  expect(readFileSync(file)).toEqual(original);
  const report = convertSearch(file); expect(report).toMatchObject({ status: 'converted', source_version: 7, target_version: 8 });
  expect(readFileSync(join(report.archive, 'before-v7.sqlite3'))).toEqual(original);
  convertToCurrent(file);
  for (let i = 0; i < 2; i++) {
    const store = new Store(directory, native);
    expect(store.session('old')).toMatchObject({ draft: 'An exact draft.\r\n', search_mode: 'off' });
    expect(store.searchView('old')).toBeNull(); expect(store.integrity().foreignKeys).toEqual([]); store.close();
  }
  const store = new Store(directory, native); store.end('old'); expect(store.createSession().search_mode).toBe('auto'); store.close();
});
it('preserves the source through preparation, failed cutover and stale accepted hash', () => {
  const original = readFileSync(file);
  expect(() => convertSearch(file, { expectedSourceHash: '0'.repeat(64) })).toThrow('source_changed_since_acceptance');
  expect(() => convertSearch(file, { replace() { throw new Error('failed_replace'); } })).toThrow('failed_replace');
  expect(readFileSync(file)).toEqual(original);
  const prepared = convertSearch(file, { prepareOnly: true }); expect(prepared.status).toBe('prepared'); expect(readFileSync(file)).toEqual(original);
  const db = new Database(join(prepared.archive, 'verified-v8.sqlite3'), { readonly: true });
  expect(db.pragma('user_version', { simple: true })).toBe(8); expect(db.prepare('SELECT * FROM search_turns').all()).toEqual([]); db.close();
});
it('rejects concurrent data changes and unclean sidecars', () => {
  writeFileSync(file + '-wal', 'unclean'); expect(() => convertSearch(file)).toThrow('unclean_sidecar'); rmSync(file + '-wal');
  expect(() => convertSearch(file, { beforeReplace() { const db = new Database(file); db.prepare("UPDATE sessions SET draft='Changed' WHERE id='old'").run(); db.close(); } })).toThrow('source_changed');
  const db = new Database(file, { readonly: true }); expect(db.pragma('user_version', { simple: true })).toBe(7); db.close();
});
it('honors a writer lock from another process', async () => {
  const child = spawn('python3', ['-u', '-c', 'import fcntl,sys,time; f=open(sys.argv[1],"a+"); fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print("ready",flush=True); time.sleep(30)', join(directory, 'stomylos.lock')]);
  try { await new Promise<void>((r, j) => { child.stdout.once('data', () => r()); child.once('error', j); }); expect(() => convertSearch(file)).toThrow(); }
  finally { child.kill(); await new Promise<void>(r => child.once('exit', () => r())); }
});
it('can execute the archived converter using only its frozen schemas and supplied runtime', () => {
  const prepared = convertSearch(file, { prepareOnly: true }), copy = join(directory, 'separate.sqlite3'); copyFileSync(file, copy);
  const result = spawnSync(process.execPath, [join(prepared.archive, 'convert-search.mjs'), copy], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', STOMYLOS_CONVERTER_RUNTIME: process.cwd() }, encoding: 'utf8'
  });
  expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).target_version).toBe(8);
});

it.each(['active-complete', 'active-interrupted', 'ended'])('preserves a v7 %s transcript and its exact historical no-search request', state => {
  const db = new Database(file), snapshot = universalSnapshot();
  const partner = snapshot.characters[1];
  db.prepare("UPDATE sessions SET state='active',character=?,model=?,chat_config=? WHERE id='old'").run(partner.id, partner.model, JSON.stringify(snapshot));
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES('user','old',1,'user','A public historical message.','learner','complete')").run();
  const source = db.prepare("SELECT * FROM messages WHERE session_id='old' ORDER BY sequence").all() as Message[];
  const frozen = { ...conversationRequestSnapshot(snapshot), app_version: '0.12.2' }, encoded = JSON.stringify(frozen);
  const question = source[0].content, expected = conversationBody(frozen, partner.id, question, source);
  const interrupted = state === 'active-interrupted';
  db.prepare("INSERT INTO model_requests(id,session_id,role,status,created_at,source_sequence,source_hash,config,config_hash,response_content) VALUES('reply','old','chat',?,'2026-09-05T00:00:01Z',1,?,?,?,'A saved reply.')")
    .run(interrupted ? 'interrupted' : 'succeeded', hash(transcriptJson(source)), encoded, hash(encoded));
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery,request_id) VALUES('answer','old',2,'assistant','A saved reply.','model',?,'reply')")
    .run(interrupted ? 'interrupted' : 'complete');
  if (state === 'ended') db.prepare("UPDATE sessions SET state='ended',ended_at='2026-09-05T00:01:00Z' WHERE id='old'").run();
  const originalMessages = db.prepare('SELECT * FROM messages ORDER BY sequence').all(); db.close();
  convertToCurrent(file);
  const store = new Store(directory, native);
  try {
    expect(store.messages('old')).toEqual(originalMessages);
    expect(store.request('reply').config).toBe(encoded);
    expect(store.session('old').search_mode).toBe('off'); expect(store.searchView('old')).toBeNull();
    if (state !== 'ended') expect(store.chatBody('reply')).toEqual(expected);
    if (interrupted) {
      const retry = store.prepareChat('old', 'explicit-retry');
      expect(retry.config).toBe(encoded); expect(store.chatBody(retry.id)).toEqual(expected);
      expect(store.chatBody(retry.id).tools).toBeUndefined(); expect(store.searchView('old')).toBeNull();
    }
  } finally { store.close(); }
});
