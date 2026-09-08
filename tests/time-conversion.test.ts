import { convertToCurrent } from './conversion-chain';
// @ts-expect-error Standalone external converter.
import { convertSharedMemory } from '../scripts/convert-shared-memory.mjs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { StarterStore } from '../src/main/starter-store';
import { universalSnapshot } from './time-fixtures';
import { emptyMemory, memoryConfig, memoryJson, memoryHash } from '../src/main/memory-updater';
import { hash } from '../src/main/contracts';
// @ts-expect-error Standalone converter intentionally has no runtime TypeScript dependency.
import { convertTime } from '../scripts/convert-time.mjs';

let directory: string, file: string;
const native = resolve('native/advisory-lock.node');
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stomylos-time-conversion-')); file = join(directory, 'stomylos.sqlite3');
  const db = new Database(file); db.exec(readFileSync('tests/fixtures/schema-v5.sql', 'utf8')); db.pragma('user_version=5');
  new StarterStore(db).initialize();
  const q = db.prepare('SELECT * FROM starter_questions LIMIT 1').get() as any;
  const config = universalSnapshot(true); config.opening = { version: 'stomylos_opening_v1', kind: 'starter' };
  db.prepare("INSERT INTO sessions(id,state,starter_id,starter_version,starter_text,created_at,chat_config,draft) VALUES('old','draft',?,?,?,?,?,?)")
    .run(q.id, q.version, q.text, '2026-09-04T23:00:00.000Z', JSON.stringify(config), '  Unknown old time.\r\n한글  ');
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES('starter','old',0,'assistant',?,'starter','complete')").run(q.text);
  db.close();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('refuses v5 before recovery, preserves all original rows and reopens converted old sessions without backfill', () => {
  const original = readFileSync(file);
  expect(() => new Store(directory, native)).toThrow('external_migration_required');
  expect(readFileSync(file)).toEqual(original);
  const report = convertTime(file);
  expect(report.status).toBe('converted'); expect(report.source_version).toBe(5); expect(report.target_version).toBe(6);
  expect(readFileSync(join(report.archive, 'before-v5.sqlite3'))).toEqual(original);
  convertToCurrent(file);
  for (let i = 0; i < 2; i++) {
    const store = new Store(directory, native);
    expect(store.session('old').draft).toBe('  Unknown old time.\r\n한글  ');
    expect(JSON.parse(store.session('old').chat_config).version).toBe('stomylos_conversation_v4');
    expect(store.view('old').memory.job).toBeNull(); store.close();
  }
  const db = new Database(file); expect(db.prepare('SELECT * FROM message_times').all()).toEqual([]); db.close();
});

it('preserves source on failed replacement and preparation-only conversion', () => {
  const original = readFileSync(file);
  expect(() => convertTime(file, { expectedSourceHash: '0'.repeat(64) })).toThrow('source_changed_since_acceptance');
  expect(readFileSync(file)).toEqual(original);
  expect(() => convertTime(file, { replace() { throw new Error('replacement_failure'); } })).toThrow('replacement_failure');
  expect(readFileSync(file)).toEqual(original);
  const report = convertTime(file, { prepareOnly: true }); expect(report.status).toBe('prepared');
  expect(readFileSync(file)).toEqual(original);
  expect(readdirSync(report.archive)).toContain('verified-v6.sqlite3');
});

it('rejects structural modifications, unsafe sidecars and source changes', () => {
  writeFileSync(file + '-wal', 'not a clean database');
  expect(() => convertTime(file)).toThrow('unclean_sidecar'); rmSync(file + '-wal');
  const original = readFileSync(file);
  expect(() => convertTime(file, { beforeReplace() { const db = new Database(file); db.prepare("UPDATE sessions SET draft='Changed while checking' WHERE id='old'").run(); db.close(); } })).toThrow('source_changed');
  expect(readFileSync(file)).not.toEqual(original);
  const db = new Database(file); db.exec('CREATE TABLE unexpected(value)'); db.close();
  expect(() => convertTime(file)).toThrow('incompatible_schema');
});

it('honors the same POSIX lock held by an independent application process', async () => {
  const child = spawn('python3', ['-u', '-c', 'import fcntl,sys,time; f=open(sys.argv[1],"a+"); fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print("ready",flush=True); time.sleep(30)', join(directory, 'stomylos.lock')]);
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', code => reject(new Error('Lock child exited ' + code))); });
    expect(() => convertTime(file)).toThrow();
    const db = new Database(file, { readonly: true }); expect(db.pragma('user_version', { simple: true })).toBe(5); db.close();
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited; } }
});

it('preserves historical failed input through the time conversion and requires resolution before shared-memory adoption', () => {
  const db = new Database(file);
  db.prepare("UPDATE sessions SET state='active',character='model_04',model='openai/gpt-6-astra' WHERE id='old'").run();
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES('old-user','old',1,'user','Tomorrow I will visit a museum.','learner','complete')").run();
  db.prepare("UPDATE sessions SET state='ended',ended_at='2026-09-07T03:00:00.000Z',analysis_state='skipped',source_hash=? WHERE id='old'").run(hash(JSON.stringify(db.prepare('SELECT role,content FROM messages ORDER BY sequence').all(), null, 2)));
  const source = memoryJson({ id: 'old', character_id: 'model_04', ended_at: '2026-09-07T03:00:00.000Z', timezone: 'Asia/Seoul', messages: db.prepare("SELECT id,role,origin,delivery,content FROM messages WHERE session_id='old' ORDER BY sequence").all() });
  const config = memoryJson(memoryConfig());
  db.prepare("INSERT INTO memory_jobs(session_id,character_id,source,source_hash,config,config_hash,created_at,state) VALUES('old','model_04',?,?,?,?,?,'failed')").run(source, memoryHash(source), config, memoryHash(config), '2026-09-07T03:00:00.000Z');
  const input = memoryJson({ current_memory: emptyMemory('model_04'), session: JSON.parse(source), limits: { max_items: 60, max_item_chars: 240, max_bytes: 20000 } });
  db.prepare("INSERT INTO memory_attempts(id,job_id,input_json,input_hash,status,created_at,failure) VALUES('failed-before-conversion',1,?,?,'failed','2026-09-07T03:00:00.000Z','request_timeout')").run(input, memoryHash(input));
  const q = db.prepare('SELECT * FROM starter_questions LIMIT 1').get() as any;
  db.prepare("INSERT INTO sessions(id,state,starter_id,starter_version,starter_text,created_at,chat_config,character,model) VALUES('old-active','active',?,?,?,'2026-09-04T03:00:00.000Z',?,'model_04','openai/gpt-6-astra')").run(q.id, q.version, q.text, JSON.stringify(universalSnapshot(true)));
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES('active-starter','old-active',0,'assistant',?,'starter','complete')").run(q.text);
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES('active-user','old-active',1,'user','An undated historical tomorrow.','learner','complete')").run();
  db.close();
  convertToCurrent(file, 8);
  const beforeShared = readFileSync(file);
  expect(() => convertSharedMemory(file)).toThrow('resolve_legacy_memory_jobs_before_conversion');
  expect(readFileSync(file)).toEqual(beforeShared);
  // Simulate the explicit skip available in the prior release; never reset a frozen attempt.
  const resolved = new Database(file); resolved.prepare("UPDATE memory_jobs SET state='skipped' WHERE session_id='old'").run(); resolved.close();
  convertToCurrent(file);
  const store = new Store(directory, native);
  try {
    const request = store.prepareChat('old-active', 'old-after-conversion');
    expect(store.chatBody(request.id).messages[0].content).not.toContain('application_time_context');
    expect(store.chatBody(request.id).messages.at(-1).content).toBe('An undated historical tomorrow.');
    store.failRequest(request.id, 'cancelled', null, {}, true); store.end('old-active');
    const next = store.createSession(); store.selectManual(next.id, 'model_04'); store.submit(next.id, 'A newly timed tomorrow.'); store.commitRoute(next.id, null, 'fixture', null); store.end(next.id);
    expect(store.memoryReady([next.id])).toBeNull();
    const historical = (store as any).db.prepare("SELECT input_json FROM memory_attempts WHERE id='failed-before-conversion'").get();
    expect(historical.input_json).toBe(input);
    for (const id of ['old-active', next.id]) { const a = store.prepareMemory(id, 'memory-' + id); store.dispatchMemory(a.id); store.saveMemory(a.id, '{"operations":[]}', {}); }
    expect(JSON.parse(store.memoryJob('old-active')!.source).messages.every((m: any) => m.sent_time === null)).toBe(true);
    expect(JSON.parse(store.memoryJob(next.id)!.source).messages.find((m: any) => m.origin === 'learner').sent_time).not.toBeNull();
  } finally { store.close(); }
});
