import { emptyMemory, memoryJson, memoryHash } from '../src/main/memory-updater';
import { Store } from '../src/main/database';
import { StarterStore } from '../src/main/starter-store';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import old from '../src/main/migrations/schema-v13.sql?raw';
import current from '../src/main/schema.sql?raw';
import { migrateDatabase, validateSchema } from '../src/main/database-migrations';
const dirs: string[] = [], databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(schema = old, version = 13) {
  const dir = mkdtempSync(join(tmpdir(), 'stomylos-migration-')); dirs.push(dir);
  const db = new Database(join(dir, 'stomylos.sqlite3')); databases.push(db);
  db.exec(schema); db.pragma(`user_version = ${version}`); return { db, dir };
}
it('migrates first public schema to current with a consistent recovery snapshot and exact fresh schema parity', () => {
  const { db, dir } = fixture();
  db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run('original', 'original-hash');
  db.pragma('journal_mode = WAL');
  migrateDatabase(db, dir);
  expect(db.pragma('user_version', { simple: true })).toBe(17); validateSchema(db, current);
  expect(db.prepare('SELECT document FROM shared_memory').pluck().get()).toBe('original');
  const file = join(dir, 'stomylos.pre-migration-v13.sqlite3'); const bytes = readFileSync(file);
  const backup = new Database(file, { readonly: true }); databases.push(backup);
  expect(backup.pragma('user_version', { simple: true })).toBe(13);
  expect(backup.prepare('SELECT document FROM shared_memory').pluck().get()).toBe('original');
  migrateDatabase(db, dir); expect(readFileSync(file)).toEqual(bytes);
});
it('refuses unknown/newer schemas without backup or writes', () => {
  for (const version of [0, 12, 18]) {
    const { db, dir } = fixture(); db.pragma(`user_version = ${version}`);
    expect(() => migrateDatabase(db, dir)).toThrow('unsupported_schema_version');
    expect(db.pragma('user_version', { simple: true })).toBe(version);
    expect(existsSync(join(dir, `stomylos.pre-migration-v${version}.sqlite3`))).toBe(false);
  }
});
it('refuses modified source structure and preserves it unchanged', () => {
  const { db, dir } = fixture(); db.exec('CREATE TABLE unexpected(x)');
  expect(() => migrateDatabase(db, dir)).toThrow('unsupported_schema_structure');
  expect(db.pragma('user_version', { simple: true })).toBe(13);
  expect(existsSync(join(dir, 'stomylos.pre-migration-v13.sqlite3'))).toBe(false);
});

it('rolls back a mid-migration failure and restarts without replacing the original backup', () => {
  const { db, dir } = fixture();
  db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run('retained', 'hash');
  const execute = db.exec.bind(db);
  const fault = vi.spyOn(db, 'exec').mockImplementation(sql => {
    const result = execute(sql);
    if (sql.includes('CREATE TABLE end_processing')) throw new Error('simulated interruption');
    return result;
  });
  expect(() => migrateDatabase(db, dir)).toThrow('simulated interruption'); fault.mockRestore();
  expect(db.pragma('user_version', { simple: true })).toBe(13); validateSchema(db, old);
  expect(db.prepare('SELECT document FROM shared_memory').pluck().get()).toBe('retained');
  const backup = join(dir, 'stomylos.pre-migration-v13.sqlite3'), original = readFileSync(backup);
  db.close();
  const restarted = new Database(join(dir, 'stomylos.sqlite3')); databases.push(restarted);
  migrateDatabase(restarted, dir); validateSchema(restarted, current);
  expect(restarted.pragma('user_version', { simple: true })).toBe(17);
  expect(readFileSync(backup)).toEqual(original);
});

it('retires dedicated intention work, refills its slot, and preserves historical response evidence', () => {
  const { db, dir } = fixture(); const starter = new StarterStore(db); starter.initialize();
  db.exec(`INSERT INTO intention_question_state VALUES('item',1,'Try hiking.','hash',NULL);
    INSERT INTO intention_question_jobs(id,item_id,epoch,text_hash,input_json,input_hash,config,config_hash,created_at,deadline,state)
    VALUES('job','item',1,'hash','frozen input','ih','frozen settings','ch','2026-09-01','2026-09-10','received');
    INSERT INTO intention_question_attempts(id,job_id,run,route,status,dispatched_at,response_content)
    VALUES('attempt','job',1,0,'received','2026-09-01','Where would you like to hike?');
    INSERT INTO starter_questions(id,version,text,normalized_text,origin,state,created_at,expires_at,intention_job_id)
    VALUES('question','historical','Where would you like to hike?','where would you like to hike?','intention','active','2026-09-01','2026-09-10','job');
    UPDATE starter_questions SET state='retired' WHERE id=(SELECT question_id FROM starter_slots WHERE slot=1);
    UPDATE starter_slots SET question_id='question' WHERE slot=1;`);
  db.prepare("INSERT INTO sessions(id,state,created_at,draft,chat_config,opening_kind,parked_starter) VALUES('draft','draft','2026-09-01','Keep my unsent text','{}','user',?)").run(JSON.stringify({question:{id:'question',version:'historical',text:'Where would you like to hike?'},message:{id:'parked'}}));
  db.exec("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind,analysis_state) VALUES('old-ended','ended','2026-09-01','{}','user','pending')");
  starter.verify(); migrateDatabase(db, dir); starter.verify();
  expect(db.prepare("SELECT parked_starter FROM sessions WHERE id='draft'").pluck().get()).toBeNull();
  expect(db.prepare("SELECT draft FROM sessions WHERE id='draft'").pluck().get()).toBe('Keep my unsent text');
  expect(db.prepare("SELECT COUNT(*) FROM end_stage_state WHERE session_id='old-ended'").pluck().get()).toBe(4);
  expect(db.prepare("SELECT state FROM intention_question_jobs WHERE id='job'").pluck().get()).toBe('superseded');
  expect(db.prepare("SELECT state FROM starter_questions WHERE id='question'").pluck().get()).toBe('invalidated');
  expect(db.prepare("SELECT response_content FROM intention_question_attempts WHERE id='attempt'").pluck().get()).toBe('Where would you like to hike?');
  expect(db.prepare("SELECT input_json FROM intention_question_jobs WHERE id='job'").pluck().get()).toBe('frozen input');
  expect(db.prepare("SELECT origin FROM starter_questions WHERE id=(SELECT question_id FROM starter_slots WHERE slot=1)").pluck().get()).toBe('seed');
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('initializes a genuinely empty SQLite file directly without a migration backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stomylos-empty-')); dirs.push(dir);
  const empty = new Database(join(dir, 'stomylos.sqlite3')); empty.exec('VACUUM'); empty.close();
  const store = new Store(dir, resolve('native/advisory-lock.node'));
  try { expect(store.currentMemory().revision).toBe(0); }
  finally { store.close(); }
  const db = new Database(join(dir, 'stomylos.sqlite3')); databases.push(db);
  expect(db.pragma('user_version', { simple: true })).toBe(17); validateSchema(db, current);
  expect(existsSync(join(dir, 'stomylos.pre-migration-v13.sqlite3'))).toBe(false);
});

it('refuses a same-schema backup from another database instead of trusting or overwriting it', () => {
  const a = fixture(), b = fixture();
  a.db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run('original A','hash A');
  b.db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run('original B','hash B');
  const backup = join(a.dir,'stomylos.pre-migration-v13.sqlite3');
  copyFileSync(join(b.dir,'stomylos.sqlite3'),backup); const bytes = readFileSync(backup);
  expect(()=>migrateDatabase(a.db,a.dir)).toThrow('migration_backup_invalid');
  expect(a.db.pragma('user_version',{simple:true})).toBe(13);
  expect(readFileSync(backup)).toEqual(bytes);
});

it('upgrades through real Store startup and lists all legacy unfinished sessions without replay', () => {
  const {db,dir} = fixture(); new StarterStore(db).initialize();
  const memory = memoryJson(emptyMemory('shared')); db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run(memory,memoryHash(memory));
  for (const id of ['first-old','second-old']) db.prepare("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind,analysis_state) VALUES(?,'ended','2026-09-01','{}','user','pending')").run(id);
  db.close();
  const store = new Store(dir,resolve('native/advisory-lock.node'));
  try {
    expect(store.endBlockers().map(row=>row.sessionId)).toEqual(['first-old','second-old']);
    expect(()=>store.createSession()).toThrow('end_processing_pending');
    expect(store.requests('first-old')).toEqual([]); expect(store.requests('second-old')).toEqual([]);
    store.cancelEnd('first-old'); expect(store.endBlocker()).toBe('second-old');
    store.cancelEnd('second-old'); expect(store.endBlockers()).toEqual([]);
    expect(store.currentMemory()).toEqual(emptyMemory('shared'));
  } finally { store.close(); }
  const after = new Database(join(dir,'stomylos.sqlite3')); databases.push(after);
  expect(after.pragma('user_version',{simple:true})).toBe(17);
  expect(existsSync(join(dir,'stomylos.pre-migration-v13.sqlite3'))).toBe(true);
});

 it('upgrades schema 14 without changing data and rolls back a failed v15 step before retry', () => {
  const { db, dir } = fixture(current, 14);
  db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run('unchanged document', 'unchanged hash');
  db.prepare("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind) VALUES('old','ended','2026-09-01','{}','user')").run();
  db.prepare("INSERT INTO starter_renewal_jobs(id,session_id,created_at,source_sequence,source_hash,source_messages,input_json,input_hash,config,config_hash,model,state) VALUES('job','old','2026-09-01',-1,'source','[]','frozen input','input hash','frozen settings','config hash','model','pending')").run();
  const before = db.prepare('SELECT * FROM starter_renewal_jobs').all();
  const exec = db.exec.bind(db);
  const fault = vi.spyOn(db, 'exec').mockImplementation(sql => {
    const result = exec(sql);
    if (sql.includes('Schema 15 admits')) throw new Error('v15 interruption');
    return result;
  });
  expect(() => migrateDatabase(db, dir)).toThrow('v15 interruption'); fault.mockRestore();
  expect(db.pragma('user_version',{simple:true})).toBe(14);
  const backup = join(dir, 'stomylos.pre-migration-v14.sqlite3'), bytes = readFileSync(backup);
  migrateDatabase(db, dir);
  expect(db.pragma('user_version',{simple:true})).toBe(17); validateSchema(db, current);
  expect(db.prepare('SELECT * FROM starter_renewal_jobs').all()).toEqual(before);
  expect(db.prepare('SELECT document FROM shared_memory').pluck().get()).toBe('unchanged document');
  migrateDatabase(db, dir); expect(readFileSync(backup)).toEqual(bytes);
});

it('upgrades schema 15 atomically for low memory requests without changing rows and preserves recovery', () => {
  const { db, dir } = fixture(current, 15);
  db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run('retained memory', 'retained hash');
  const execute = db.exec.bind(db);
  const fault = vi.spyOn(db, 'exec').mockImplementation(sql => {
    const result = execute(sql);
    if (sql.includes('Schema 16 admits')) throw new Error('v16 interruption');
    return result;
  });
  expect(() => migrateDatabase(db, dir)).toThrow('v16 interruption'); fault.mockRestore();
  expect(db.pragma('user_version', { simple: true })).toBe(15);
  const file = join(dir, 'stomylos.pre-migration-v15.sqlite3'), bytes = readFileSync(file);
  migrateDatabase(db, dir);
  expect(db.pragma('user_version', { simple: true })).toBe(17); validateSchema(db, current);
  expect(db.prepare('SELECT * FROM shared_memory').get()).toEqual({ id: 1, document: 'retained memory', document_hash: 'retained hash' });
  migrateDatabase(db, dir); expect(readFileSync(file)).toEqual(bytes);
});

it('upgrades schema 16 without rewriting saved routing contracts and recovers a failed v17 step', () => {
  const { db, dir } = fixture(current, 16);
  db.prepare("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind) VALUES('saved','draft','2026-09-08',?,'user')").run('{"version":"stomylos_conversation_v7","historical":"unchanged"}');
  const before = db.prepare('SELECT * FROM sessions').all();
  const execute = db.exec.bind(db);
  const fault = vi.spyOn(db, 'exec').mockImplementation(sql => {
    const result = execute(sql);
    if (sql.includes('Schema 17 admits')) throw new Error('v17 interruption');
    return result;
  });
  expect(() => migrateDatabase(db, dir)).toThrow('v17 interruption'); fault.mockRestore();
  expect(db.pragma('user_version', { simple: true })).toBe(16);
  expect(db.prepare('SELECT * FROM sessions').all()).toEqual(before);
  const file = join(dir, 'stomylos.pre-migration-v16.sqlite3'), bytes = readFileSync(file);
  migrateDatabase(db, dir);
  expect(db.pragma('user_version', { simple: true })).toBe(17); validateSchema(db, current);
  expect(db.prepare('SELECT * FROM sessions').all()).toEqual(before);
  migrateDatabase(db, dir); expect(readFileSync(file)).toEqual(bytes);
});
