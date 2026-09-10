import { currentSchema } from '../src/main/database-migrations';
import { flat } from './flat-memory-fixtures';
import { validateFlatMemory } from '../src/main/memory-flat';
import { candidateLimits } from '../src/main/memory-updater';
import { convertToCurrent } from './conversion-chain';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { StarterStore } from '../src/main/starter-store';
import { emptyMemory, memoryHash, memoryJson, validateMemory } from '../src/main/memory-updater';
import { v5Snapshot } from './time-fixtures';
// @ts-expect-error Standalone external converter, never bundled with the app.
import { convertSharedMemory, mergeMemories } from '../scripts/convert-shared-memory.mjs';
let directory: string, file: string;
const native = resolve('native/advisory-lock.node');
const row = (character: string, texts: string[]) => {
  const doc = emptyMemory(character); doc.traits = texts.map((text, i) => ({ id: `item-${i}`, text }));
  const document = memoryJson(doc); return { character_id: character, document, document_hash: memoryHash(document) };
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stomylos-shared-conversion-')); file = join(directory, 'stomylos.sqlite3');
  const db = new Database(file); db.exec(readFileSync('tests/fixtures/schema-v8-before-shared-memory.sql', 'utf8')); db.pragma('user_version=8'); new StarterStore(db).initialize();
  const q = db.prepare('SELECT * FROM starter_questions LIMIT 1').get() as any;
  db.prepare("INSERT INTO sessions(id,state,starter_id,starter_version,starter_text,created_at,chat_config,draft) VALUES('old','draft',?,?,?,'2026-09-06T00:00:00Z',?,'An exact draft.')").run(q.id, q.version, q.text, JSON.stringify(v5Snapshot()));
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES('starter','old',0,'assistant',?,'starter','complete')").run(q.text);
  for (const r of [row('model_03', ['Enjoys museums.', 'Prefers tea.']), row('model_04', ['  Enjoys   museums. ', 'Prefers coffee.'])]) db.prepare('INSERT INTO character_memories VALUES(?,?,?)').run(r.character_id, r.document, r.document_hash);
  db.close();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
it('merges exact duplicates with stable unique IDs, preserves different claims and every original row', () => {
  const before = readFileSync(file); expect(() => new Store(directory, native)).toThrow('external_migration_required'); expect(readFileSync(file)).toEqual(before);
  const report = convertSharedMemory(file); expect(report.merge).toEqual({ sourceItems: 4, sharedItems: 3, exactDuplicates: 1 });
  expect(readFileSync(join(report.archive, 'before-v8.sqlite3'))).toEqual(before);
  convertToCurrent(file);
  for (let i = 0; i < 2; i++) {
    const store = new Store(directory, native); const memory = store.view('old').memory.current!;
    expect(memory.character_id).toBe('shared'); expect(flat(memory).database_records.map(i => i.text)).toEqual(['Enjoys museums.', 'Prefers tea.', 'Prefers coffee.']); validateFlatMemory(memory,candidateLimits);
    expect(store.session('old').draft).toBe('An exact draft.'); store.close();
  }
  const raw = new Database(file); expect(raw.pragma('user_version', { simple: true })).toBe(currentSchema);
  expect(raw.prepare('SELECT COUNT(*) AS n FROM character_memories').get()).toEqual({ n: 2 });
  expect(() => raw.prepare("UPDATE character_memories SET document='{}'").run()).toThrow('archived'); raw.close();
});
it('is deterministic across row order, preserves category distinctions and refuses truncation or corrupt input', () => {
  const a = row('model_03', ['Tea.']), b = row('model_04', ['Coffee.']);
  expect(mergeMemories([a, b])).toEqual(mergeMemories([b, a]));
  const c = JSON.parse(b.document); c.experiences = [{ id: 'experience', text: 'Tea.' }]; b.document = memoryJson(c); b.document_hash = memoryHash(b.document);
  expect(mergeMemories([a, b]).sharedItems).toBe(3);
  expect(() => mergeMemories([{ ...a, document_hash: 'bad' }])).toThrow('memory_document_hash');
  expect(() => mergeMemories([row('a', Array.from({ length: 40 }, (_, i) => `Fact ${i}`)), row('b', Array.from({ length: 40 }, (_, i) => `Other ${i}`))])).toThrow('shared_memory_budget_requires_review');
});
it.each(['pending', 'failed', 'interrupted', 'running'])('preserves unresolved %s legacy jobs instead of rewriting frozen retry contracts', state => {
  const db = new Database(file);
  db.prepare('INSERT INTO memory_jobs(session_id,character_id,source,source_hash,config,config_hash,created_at,state) VALUES(?,?,?,?,?,?,?,?)').run('old', 'model_04', '{}', 'hash', '{}', 'hash', '2026-09-06T00:00:00Z', state); db.close();
  const before = readFileSync(file); expect(() => convertSharedMemory(file)).toThrow('resolve_legacy_memory_jobs_before_conversion'); expect(readFileSync(file)).toEqual(before);
});
it('preserves the source during prepare-only, stale-hash, failed-replace and concurrent-write cases', () => {
  const before = readFileSync(file); const report = convertSharedMemory(file, { prepareOnly: true }); expect(report.status).toBe('prepared'); expect(readFileSync(file)).toEqual(before);
  expect(() => convertSharedMemory(file, { expectedSourceHash: '0'.repeat(64) })).toThrow('source_changed_since_acceptance');
  expect(() => convertSharedMemory(file, { replace() { throw new Error('replace_failed'); } })).toThrow('replace_failed'); expect(readFileSync(file)).toEqual(before);
  writeFileSync(file + '-wal', 'unclean'); expect(() => convertSharedMemory(file)).toThrow('unclean_sidecar'); rmSync(file + '-wal');
  expect(() => convertSharedMemory(file, { beforeReplace() { const db = new Database(file); db.prepare("UPDATE sessions SET draft='newer' WHERE id='old'").run(); db.close(); } })).toThrow('source_changed');
  const db = new Database(file); expect(db.pragma('user_version', { simple: true })).toBe(8); expect(db.prepare("SELECT draft FROM sessions WHERE id='old'").get()).toEqual({ draft: 'newer' }); db.close();
});
it('honors the cross-process application lock', async () => {
  const child = spawn('python3', ['-u', '-c', 'import fcntl,sys,time; f=open(sys.argv[1],"a+"); fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print("ready",flush=True); time.sleep(30)', join(directory, 'stomylos.lock')]);
  try { await new Promise<void>((r, j) => { child.stdout.once('data', () => r()); child.once('error', j); }); expect(() => convertSharedMemory(file)).toThrow(); }
  finally { child.kill(); await new Promise<void>(r => child.once('exit', () => r())); }
});
it('runs its archived converter with frozen schemas and a supplied runtime', () => {
  const prepared = convertSharedMemory(file, { prepareOnly: true }), copy = join(directory, 'copy.sqlite3'); copyFileSync(file, copy);
  const result = spawnSync(process.execPath, [join(prepared.archive, 'convert-shared-memory.mjs'), copy], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', STOMYLOS_CONVERTER_RUNTIME: process.cwd() }, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).target_version).toBe(9);
});
