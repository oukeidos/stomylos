import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateCommand } from '../src/main/ipc';
import { Store } from '../src/main/database';
import { StarterStore } from '../src/main/starter-store';
import { selectCatalog, weightedQuestion } from '../src/main/starter-catalog';
import { readCatalog, catalogManifest, verifyCatalog19 } from '../src/main/migrations/019-data';
import { migrateDatabase, validateSchema } from '../src/main/database-migrations';
import old from '../src/main/migrations/schema-v18.sql?raw';
import schema from '../src/main/schema.sql?raw';
import { emptyMemory, memoryJson, memoryHash } from '../src/main/memory-updater';
const dirs: string[] = [], stores: Store[] = [], dbs: Database.Database[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dbs.splice(0)) if (d.open) d.close(); for (const d of dirs.splice(0)) rmSync(d,{recursive:true,force:true}); });
function dir() { const d = mkdtempSync(join(tmpdir(),'stomylos-catalog-')); dirs.push(d); return d; }
function fresh() { const directory = dir(), store = new Store(directory,resolve('native/advisory-lock.node')); stores.push(store); const db = (store as unknown as {db:Database.Database}).db; return {directory,store,db}; }
function count(db: Database.Database, id: string) { return db.prepare('SELECT answer_count,skip_count FROM starter_catalog_entries WHERE question_id=?').get(id); }
it('bundles exactly the English-only matrix and rejects corrupted payloads', () => {
  const rows = readCatalog(); expect(rows).toHaveLength(5000); expect(Object.keys(catalogManifest.joint_cells)).toHaveLength(80);
  expect(() => readCatalog('[]')).toThrow('starter_catalog_corrupt');
  const {db} = fresh(); verifyCatalog19(db);
  expect(db.prepare('SELECT COUNT(*) FROM starter_catalog_entries').pluck().get()).toBe(5000);
  expect(db.prepare('PRAGMA table_info(starter_catalog_entries)').all().map((r:any)=>r.name)).not.toContain('ko');
  db.prepare("UPDATE starter_catalog_install SET source_hash='corrupt'").run(); expect(()=>verifyCatalog19(db)).toThrow('starter_catalog_corrupt');
});
it('keeps answered candidates selectable at one/20 unanswered and at large equal counts', () => {
  for (const remaining of [1,20]) {
    const rows = Array.from({length:5000},(_,i)=>({id:i,answer_count:i<remaining?0:1}));
    expect(weightedQuestion(rows,0).id).toBe(0);
    expect(weightedQuestion(rows,0.999999).id).toBe(4999);
  }
  expect(weightedQuestion([{answer_count:0,id:0},{answer_count:1,id:1}],0.66).id).toBe(0);
  expect(weightedQuestion([{answer_count:0,id:0},{answer_count:1,id:1}],0.67).id).toBe(1);
  expect(weightedQuestion([{answer_count:10000,id:0},{answer_count:10000,id:1}],0.75).id).toBe(1);
});
it('commits skips and first answers once, preserves parked identity, and creates no renewal jobs', () => {
  const {store,db} = fresh(); const s=store.createSession(), first=s.starter_id!;
  store.setOpening(s.id,'park',s.opening_revision,'user');
  store.setOpening(s.id,'restore',store.session(s.id).opening_revision,'starter');
  expect(store.session(s.id).starter_id).toBe(first);
  store.replaceQuestion(s.id,'skip',first,store.session(s.id).opening_revision);
  store.replaceQuestion(s.id,'skip',first,0);
  expect(count(db,first)).toEqual({answer_count:0,skip_count:1});
  const next=store.session(s.id).starter_id!; expect(next).not.toBe(first);
  store.submit(s.id,'I have a thought.','answer'); store.submit(s.id,'I have a thought.','answer');
  expect(count(db,next)).toEqual({answer_count:1,skip_count:0});
  store.end(s.id); expect(store.starterJob(s.id)).toBeNull(); expect(store.endStatus(s.id)?.stages.starter).toBe('skipped');
  expect(()=>store.retryStarter(s.id,'retry')).toThrow('feature_removed');
  expect(db.prepare('SELECT COUNT(*) FROM starter_preparations').pluck().get()).toBe(0);
  db.prepare('UPDATE starter_catalog_entries SET answer_count=100').run();
  for(let i=0;i<20;i++) expect(selectCatalog(db).question.id).toMatch(/^catalog:/);
  store.cancelEnd(s.id); expect(store.createSession().starter_id).toMatch(/^catalog:/);
});
it('rolls back a skip if no same-session replacement exists; never relaxes that exclusion', () => {
  const {store,db}=fresh(), s=store.createSession();
  const records=db.prepare('SELECT q.* FROM starter_catalog_entries c JOIN starter_questions q ON q.id=c.question_id').all() as any[];
  const insert=db.prepare("INSERT INTO starter_events VALUES(?,?,'presented',?,?,?,?)");
  db.transaction(()=>{for(const q of records) insert.run(`seen-${q.id}`,s.id,q.id,q.version,q.text,'2026-09-09');})();
  expect(()=>store.replaceQuestion(s.id,'blocked',s.starter_id!,s.opening_revision)).toThrow('starter_session_exhausted');
  expect(count(db,s.starter_id!)).toEqual({answer_count:0,skip_count:0}); expect(store.session(s.id).starter_id).toBe(s.starter_id);
  expect(db.prepare("SELECT 1 FROM starter_skips WHERE operation_id='blocked'").get()).toBeUndefined();
  expect(selectCatalog(db).question.id).toMatch(/^catalog:/);
});
it('ignores skip counts, excludes same-session and recent text, and relaxes only recent history', () => {
  const {store,db}=fresh(),s=store.createSession();
  const before=selectCatalog(db,undefined,s.id,()=>0.4).question.id;
  db.prepare('UPDATE starter_catalog_entries SET skip_count=10000 WHERE question_id=?').run(before);
  expect(selectCatalog(db,undefined,s.id,()=>0.4).question.id).toBe(before);
  db.transaction(()=>{
    db.prepare('UPDATE starter_catalog_entries SET eligible=0').run();
    db.prepare("UPDATE starter_questions SET state='retired' WHERE id IN (SELECT question_id FROM starter_catalog_entries)").run();
    db.prepare('UPDATE starter_catalog_entries SET eligible=1 WHERE question_id=?').run(s.starter_id);
    db.prepare("UPDATE starter_questions SET state='active' WHERE id=?").run(s.starter_id);
  })();
  expect(selectCatalog(db).relaxed).toBe(true);
  expect(()=>selectCatalog(db,undefined,s.id)).toThrow('starter_session_exhausted');
});
it('migrates v18 atomically, preserves legacy drafts/evidence, seeds exact counts, and disables replay', () => {
  const directory=dir(),db=new Database(join(directory,'stomylos.sqlite3')); dbs.push(db); db.exec(old); db.pragma('user_version=18');
  new StarterStore(db).initialize();
  const memory=memoryJson(emptyMemory('shared')); db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run(memory,memoryHash(memory));
  const q=readCatalog()[0];
  db.prepare("INSERT INTO starter_questions(id,version,text,normalized_text,origin,state,created_at) VALUES('legacy','old',?,?,'seed','retired','2026-09-09')").run(q.en,q.en.toLowerCase());
  db.exec("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind,analysis_state) VALUES('ended','ended','2026-09-09','{}','user','skipped'); INSERT INTO end_processing(session_id,created_at) VALUES('ended','2026-09-09')");
  db.prepare("INSERT INTO starter_events VALUES('answer1','ended','answered','legacy','old',?,'2026-09-09')").run(q.en);
  db.prepare("INSERT INTO starter_events VALUES('answer2','ended','answered','legacy','old',?,'2026-09-09')").run(q.en);
  db.exec("INSERT INTO starter_renewal_jobs(id,session_id,created_at,source_sequence,source_hash,source_messages,input_json,input_hash,config,config_hash,model,state) VALUES('job','ended','2026-09-09',0,'hash','[]','input','hash','{}','hash','model','pending'); INSERT INTO starter_renewal_attempts(id,job_id,status,created_at,response_content) VALUES('attempt','job','queued','2026-09-09','saved response')");
  const source=db.prepare('SELECT input_json,config FROM starter_renewal_jobs').get();
  const exec=db.exec.bind(db),fault=vi.spyOn(db,'exec').mockImplementation(sql=>{const r=exec(sql);if(sql.includes('CREATE TABLE starter_catalog_install'))throw new Error('v19 interruption');return r;});
  expect(()=>migrateDatabase(db,directory)).toThrow('v19 interruption'); fault.mockRestore(); validateSchema(db,old); expect(db.pragma('user_version',{simple:true})).toBe(18);
  const backup=readFileSync(join(directory,'stomylos.pre-migration-v18.sqlite3'));
  migrateDatabase(db,directory); validateSchema(db,schema); verifyCatalog19(db);
  expect(count(db,`catalog:joint-v1:${q.id}`)).toEqual({answer_count:1,skip_count:0});
  expect(db.prepare('SELECT input_json,config FROM starter_renewal_jobs').get()).toEqual(source);
  expect(db.prepare('SELECT status,failure,response_content FROM starter_renewal_attempts').get()).toEqual({status:'interrupted',failure:'feature_removed',response_content:'saved response'});
  migrateDatabase(db,directory); expect(readFileSync(join(directory,'stomylos.pre-migration-v18.sqlite3'))).toEqual(backup);
  db.close(); const store=new Store(directory,resolve('native/advisory-lock.node'));stores.push(store);
  expect(store.endStatus('ended')?.complete).toBe(true); expect(new StarterStore((store as any).db).view('ended')?.retired).toBe(true);
  expect(()=>store.resumeEndResponse('ended','starter')).not.toThrow();
  expect(()=>store.dispatchStarter('attempt')).toThrow('feature_removed');
  expect(count((store as any).db,`catalog:joint-v1:${q.id}`)).toEqual({answer_count:1,skip_count:0});
});
it('preserves an exact legacy parked opening across migration and counts its submitted answer once', () => {
  const {directory,store,db}=fresh(), session=store.createSession();
  const original=store.messages(session.id)[0];
  store.setOpening(session.id,'park-legacy',session.opening_revision,'user');
  const saved=store.session(session.id);
  // Build an isolated supported-v18 fixture with the same frozen draft contract.
  const legacyDir=dir(),legacy=new Database(join(legacyDir,'stomylos.sqlite3'));dbs.push(legacy);legacy.exec(old);legacy.pragma('user_version=18');
  new StarterStore(legacy).initialize();
  const memory=memoryJson(emptyMemory('shared'));legacy.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run(memory,memoryHash(memory));
  const q=JSON.parse(saved.parked_starter!).question;
  legacy.prepare("INSERT INTO starter_questions(id,version,text,normalized_text,origin,state,created_at) VALUES(?,?,?,?,'seed','retired','2026-09-09')").run('legacy-parked',q.version,q.text,q.text.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim());
  const parked=JSON.parse(saved.parked_starter!);parked.question.id='legacy-parked';
  legacy.prepare("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind,parked_starter,opening_revision) VALUES(?,'draft',?,?,'user',?,?)").run(saved.id,saved.created_at,saved.chat_config,JSON.stringify(parked),saved.opening_revision);
  const before=legacy.prepare('SELECT * FROM sessions').get();migrateDatabase(legacy,legacyDir);
  expect(legacy.prepare('SELECT * FROM sessions').get()).toEqual(before);legacy.close();
  const reopened=new Store(legacyDir,resolve('native/advisory-lock.node'));stores.push(reopened);
  reopened.setOpening(saved.id,'restore-legacy',saved.opening_revision,'starter');
  expect(reopened.messages(saved.id)).toEqual([original]);
  reopened.submit(saved.id,'My answer.','legacy-answer');reopened.submit(saved.id,'My answer.','legacy-answer');
  expect(count((reopened as any).db,q.id)).toEqual({answer_count:1,skip_count:0});
});
it('records bounded catalog insertion and selection timings on isolated data', () => {
  const start=performance.now(),{db}=fresh(), startupMs=performance.now()-start;
  const samples:number[]=[];
  for(let i=0;i<100;i++){const time=performance.now();selectCatalog(db);samples.push(performance.now()-time);}
  samples.sort((a,b)=>a-b);
  mkdirSync('test-results',{recursive:true});
  writeFileSync('test-results/starter-catalog-performance.json',JSON.stringify({catalogRows:5000,freshStoreMs:startupMs,selectionSamples:100,selectionMedianMs:samples[50],selectionP95Ms:samples[95]},null,2));
});

it('accepts namespaced catalog question IDs only in the starter identity IPC field', () => {
  const args={sessionId:'session',operationId:'skip',expectedQuestionId:'catalog:joint-v1:Q05912',expectedRevision:0};
  expect(()=>validateCommand('replaceStarter',args)).not.toThrow();
  for(const id of ['catalog:joint-v1:Q05912/path','catalog:other:Q00001','catalog:joint-v1:Q1']) expect(()=>validateCommand('replaceStarter',{...args,expectedQuestionId:id})).toThrow('invalid_command');
  expect(()=>validateCommand('replaceStarter',{...args,operationId:args.expectedQuestionId})).toThrow('invalid_command');
});
