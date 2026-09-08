import { convertToCurrent } from './conversion-chain';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync, spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { StarterStore } from '../src/main/starter-store';
import { universalSnapshot } from './time-fixtures';
// @ts-expect-error The standalone converter deliberately has no TypeScript runtime dependency.
import { convertPatterns } from '../scripts/convert-patterns.mjs';
let directory:string, file:string;
const native=resolve('native/advisory-lock.node');
beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),'stomylos-pattern-conversion-')); file=join(directory,'stomylos.sqlite3');
  const db=new Database(file); db.exec(readFileSync('tests/fixtures/schema-v6-before-pattern.sql','utf8')); db.pragma('user_version=6');
  new StarterStore(db).initialize(); const q=db.prepare('SELECT * FROM starter_questions LIMIT 1').get() as any;
  db.prepare("INSERT INTO sessions(id,state,starter_id,starter_version,starter_text,created_at,chat_config,draft) VALUES('old','draft',?,?,?,?,?,?)")
    .run(q.id,q.version,q.text,'2026-09-05T00:00:00Z',JSON.stringify(universalSnapshot(true)),'Exact Unicode 한글 👩🏽‍💻\r\n');
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES('sent','old',0,'user','Yesterday I walked.','learner','complete')").run();
  db.prepare("INSERT INTO message_times VALUES('sent','2026-09-05T00:00:00.123Z','Asia/Seoul',540)").run();
  db.prepare("UPDATE opening_preferences SET kind='user'").run(); db.close();
});
afterEach(()=>rmSync(directory,{recursive:true,force:true}));
it('refuses v6 without writes, backs up exact bytes, retains temporal data and reopens the current app without backfill',()=>{
  const original=readFileSync(file); expect(()=>new Store(directory,native)).toThrow('external_migration_required'); expect(readFileSync(file)).toEqual(original);
  const result=convertPatterns(file); expect(result).toMatchObject({status:'converted',source_version:6,target_version:7});
  expect(readFileSync(join(result.archive,'before-v6.sqlite3'))).toEqual(original);
  expect(()=>new Store(directory,native)).toThrow('external_migration_required'); convertToCurrent(file);
  for(let n=0;n<2;n++){const store=new Store(directory,native); expect(store.session('old').draft).toBe('Exact Unicode 한글 👩🏽‍💻\r\n'); expect(store.patternList(0).reports).toEqual([]); store.close();}
  const db=new Database(file,{readonly:true});
  expect(db.prepare('SELECT * FROM message_times').all()).toEqual([{message_id:'sent',sent_at_utc:'2026-09-05T00:00:00.123Z',timezone:'Asia/Seoul',utc_offset_minutes:540}]);
  expect(db.prepare('SELECT kind FROM opening_preferences').get()).toEqual({kind:'user'}); expect(db.pragma('foreign_key_check')).toEqual([]); db.close();
});
it('keeps originals unchanged on preparation, failed replacement and a mismatched accepted hash',()=>{
  const original=readFileSync(file);
  expect(()=>convertPatterns(file,{expectedSourceHash:'0'.repeat(64)})).toThrow('source_changed_since_acceptance');
  expect(()=>convertPatterns(file,{replace(){throw new Error('failed_replace')}})).toThrow('failed_replace');
  expect(readFileSync(file)).toEqual(original);
  const result=convertPatterns(file,{prepareOnly:true}); expect(result.status).toBe('prepared'); expect(readFileSync(file)).toEqual(original);
  const db=new Database(join(result.archive,'verified-v7.sqlite3'),{readonly:true}); expect(db.pragma('user_version',{simple:true})).toBe(7); db.close();
});
it('rejects a source edit during acceptance and nonempty database sidecars',()=>{
  writeFileSync(file+'-wal','not a closed database'); expect(()=>convertPatterns(file)).toThrow('unclean_sidecar'); rmSync(file+'-wal');
  expect(()=>convertPatterns(file,{beforeReplace(){const db=new Database(file);db.prepare("UPDATE sessions SET draft='newer draft' WHERE id='old'").run();db.close();}})).toThrow('source_changed');
  const db=new Database(file,{readonly:true}); expect(db.pragma('user_version',{simple:true})).toBe(6); expect(db.prepare("SELECT draft FROM sessions WHERE id='old'").get()).toEqual({draft:'newer draft'}); db.close();
});
it('honors a lock owned by another process',async()=>{
  const child=spawn('python3',['-u','-c','import fcntl,sys,time; f=open(sys.argv[1],"a+"); fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print("ready",flush=True); time.sleep(30)',join(directory,'stomylos.lock')]);
  try { await new Promise<void>((r,j)=>{child.stdout.once('data',()=>r());child.once('error',j);}); expect(()=>convertPatterns(file)).toThrow(); }
  finally { const exited=new Promise(r=>child.once('exit',r)); child.kill();await exited; }
});
it('runs the archived standalone converter against its own frozen schemas',()=>{
  const prepared=convertPatterns(file,{prepareOnly:true}), copy=join(directory,'separate.sqlite3'); copyFileSync(file,copy);
  const child=spawnSync(createRequire(import.meta.url)('electron'),[join(prepared.archive,'convert-patterns.mjs'),copy],{encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1',STOMYLOS_CONVERTER_RUNTIME:process.cwd()}});
  expect(child.status,child.stderr).toBe(0);
  expect(JSON.parse(child.stdout).status).toBe('converted');
  expect(readFileSync(file)).toEqual(readFileSync(join(prepared.archive,'before-v6.sqlite3')));
});
