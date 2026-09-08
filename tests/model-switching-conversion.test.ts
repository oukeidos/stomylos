import { convertToCurrent } from './conversion-chain';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { StarterStore } from '../src/main/starter-store';
import { emptyMemory, memoryHash, memoryJson } from '../src/main/memory-updater';
import { v5Snapshot } from './time-fixtures';
// @ts-expect-error Standalone external converter, never imported by the runtime.
import { convertModelSwitching } from '../scripts/convert-model-switching.mjs';

let directory: string, file: string;
const native = resolve('native/advisory-lock.node');
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stomylos-partner-conversion-')); file = join(directory, 'stomylos.sqlite3');
  const db = new Database(file); db.exec(readFileSync('tests/fixtures/schema-v11-before-model-switching.sql', 'utf8'));
  db.pragma('user_version=11'); new StarterStore(db).initialize();
  const memory = memoryJson(emptyMemory('shared')); db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run(memory, memoryHash(memory));
  const q = db.prepare('SELECT * FROM starter_questions LIMIT 1').get() as any;
  db.prepare("INSERT INTO sessions(id,state,starter_id,starter_version,starter_text,created_at,chat_config,draft) VALUES('old','active',?,?,?,'2026-09-06T00:00:00Z',?,'한글 draft\nSecond line.')").run(q.id, q.version, q.text, JSON.stringify(v5Snapshot()));
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES('starter','old',0,'assistant',?,'starter','complete')").run(q.text);
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES('learner','old',1,'user','Exact historical learner text.','learner','complete')").run();
  db.prepare("INSERT INTO session_bookmarks VALUES('old')").run();
  db.close();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
it('preserves v11 rows, bookmarks, drafts and private backups across two v12 opens', () => {
  const before = readFileSync(file);
  expect(() => new Store(directory, native)).toThrow('external_migration_required'); expect(readFileSync(file)).toEqual(before);
  const report = convertModelSwitching(file);
  expect(report).toMatchObject({ status: 'converted', source_version: 11, target_version: 12 });
  expect(readFileSync(join(report.archive, 'before-v11.sqlite3'))).toEqual(before);
  expect(statSync(report.archive).mode & 0o777).toBe(0o700);
  for (const path of ['before-v11.sqlite3', 'verified-v12.sqlite3', 'schema-v11.sql', 'schema-v12.sql', 'manifest.json', 'convert-model-switching.mjs'])
    expect(statSync(join(report.archive, path)).mode & 0o777).toBe(0o600);
  convertToCurrent(file);
  for (let i = 0; i < 2; i++) {
    const store = new Store(directory, native);
    expect(store.view('old').partner.pending).toBeNull();
    expect(store.view('old').partner.revision).toBe(0);
    expect(store.view('old').bookmarked).toBe(true); expect(store.view('old').canBookmark).toBe(true);
    expect(store.session('old').draft).toBe('한글 draft\nSecond line.');
    expect(store.messages('old')[1].content).toBe('Exact historical learner text.');
    expect(store.integrity().foreignKeys).toEqual([]); store.setSessionBookmark('old', true); store.close();
  }
});
it('keeps prepared or failed-replacement sources exact and refuses changed acceptance hashes', () => {
  const before = readFileSync(file), report = convertModelSwitching(file, { prepareOnly: true });
  expect(report.status).toBe('prepared'); expect(readFileSync(file)).toEqual(before);
  expect(() => convertModelSwitching(file, { expectedSourceHash: '0'.repeat(64) })).toThrow('source_changed_since_acceptance');
  expect(() => convertModelSwitching(file, { replace() { throw new Error('replace_failed'); } })).toThrow('replace_failed');
  expect(readFileSync(file)).toEqual(before);
  expect(() => convertModelSwitching(file, { beforeReplace() {
    const db = new Database(file); db.prepare("UPDATE sessions SET draft='Newer draft' WHERE id='old'").run(); db.close();
  } })).toThrow('source_changed');
  const db = new Database(file); expect(db.pragma('user_version', { simple: true })).toBe(11);
  expect(db.prepare("SELECT draft FROM sessions WHERE id='old'").get()).toEqual({ draft: 'Newer draft' }); db.close();
});
it.each(['version', 'structure', 'sidecar', 'backup'])('refuses an unsafe %s before replacing the source', failure => {
  if (failure === 'version' || failure === 'structure') {
    const db = new Database(file); db.exec(failure === 'version' ? 'PRAGMA user_version=9' : 'CREATE TABLE unexpected(id TEXT)'); db.close();
  }
  if (failure === 'sidecar') writeFileSync(file + '-wal', 'dirty');
  if (failure === 'backup') writeFileSync(join(directory, 'backups'), 'not a directory');
  const before = readFileSync(file); expect(() => convertModelSwitching(file)).toThrow(); expect(readFileSync(file)).toEqual(before);
});
it('honors a live cross-process application lock', async () => {
  const child = spawn('python3', ['-u', '-c', 'import fcntl,sys,time; f=open(sys.argv[1],"a+"); fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print("ready",flush=True); time.sleep(30)', join(directory, 'stomylos.lock')]);
  try {
    await new Promise<void>((done, reject) => { child.stdout.once('data', () => done()); child.once('error', reject); });
    const before = readFileSync(file); expect(() => convertModelSwitching(file)).toThrow(); expect(readFileSync(file)).toEqual(before);
  } finally { child.kill(); await new Promise<void>(done => child.once('exit', () => done())); }
});
it('reproduces conversion from archived schemas with an explicitly supplied dependency runtime', () => {
  const report = convertModelSwitching(file, { prepareOnly: true }), copy = join(directory, 'copy.sqlite3'); copyFileSync(file, copy);
  const result = spawnSync(process.execPath, [join(report.archive, 'convert-model-switching.mjs'), copy], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', STOMYLOS_CONVERTER_RUNTIME: resolve('.') }, encoding: 'utf8'
  });
  expect(result.status, result.stderr).toBe(0);
  const db = new Database(copy); expect(db.pragma('user_version', { simple: true })).toBe(12);
  expect(db.prepare('SELECT COUNT(*) n FROM session_bookmarks').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT COUNT(*) n FROM session_partner_state').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) n FROM partner_selection_operations').get()).toEqual({ n: 0 }); db.close();
});
