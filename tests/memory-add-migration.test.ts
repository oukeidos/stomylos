import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import source28 from '../src/main/migrations/schema-v28.sql?raw';
import source from '../src/main/migrations/schema-v27.sql?raw';
import current from '../src/main/schema.sql?raw';
import {StarterStore} from '../src/main/starter-store';
import {migrateDatabase,validateSchema} from '../src/main/database-migrations';
import {memoryHash,memoryJson} from '../src/main/memory-updater';
import {memoryCharacters} from '../src/main/memory-render';
const fixtures:{dir:string;db:Database.Database}[]=[];
afterEach(()=>{for(const {dir,db} of fixtures.splice(0)){db.close();rmSync(dir,{recursive:true,force:true});}});
function fixture(sql=source,version=27){const dir=mkdtempSync('/tmp/stomylos-add-migration-'),db=new Database(join(dir,'stomylos.sqlite3'));fixtures.push({dir,db});db.exec(sql);db.pragma(`user_version=${version}`);db.transaction(()=>new StarterStore(db).initialize())();
 const document=memoryJson({character_id:'shared',revision:7,database_records:[{id:'a',text:'a'.repeat(2000)},{id:'b',text:'b'.repeat(2000)},{id:'c',text:'c'.repeat(2000)}]});db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run(document,memoryHash(document));return {dir,db,document};}
it('preserves old memory in the migration backup only, retires pending work and seeds newest records with unknown dates',()=>{
 const {dir,db,document}=fixture();db.prepare("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind,character) VALUES('s','ended','2026-09-01','{}','user','model_04')").run();
 db.prepare('INSERT INTO session_memories VALUES(?,?,?,?)').run('s','model_04',document,memoryHash(document));
 db.prepare("INSERT INTO memory_jobs(session_id,character_id,source,source_hash,config,config_hash,created_at,state) VALUES('s','model_04','transcript','sh','old settings','ch','2026-09-01','running')").run();
 db.prepare("INSERT INTO memory_attempts(id,job_id,input_json,input_hash,status,created_at,response_content,metadata) VALUES('old',1,'old input','ih','dispatched','2026-09-01','old response','{\"usage\":{\"cost\":0.02}}')").run();
 db.prepare("INSERT INTO end_processing(session_id,created_at) VALUES('s','2026-09-01')").run();db.prepare("INSERT INTO end_stage_state(session_id,stage,response_id,response_content,response_metadata) VALUES('s','update','old','old response','{}')").run();
 const jobs=db.prepare('SELECT * FROM memory_jobs').all(),attempts=db.prepare('SELECT * FROM memory_attempts').all(),snapshots=db.prepare('SELECT * FROM session_memories').all();
 migrateDatabase(db,dir);validateSchema(db,current);expect(db.pragma('user_version',{simple:true})).toBe(29);
 expect(db.prepare("SELECT name FROM sqlite_master WHERE name='memory_cutover_archive'").get()).toBeUndefined();
 const recovery=new Database(join(dir,'stomylos.pre-migration-v27.sqlite3'),{readonly:true});
 try {expect(recovery.prepare('SELECT document FROM shared_memory').pluck().get()).toBe(document);} finally {recovery.close();}
 const active=JSON.parse(db.prepare('SELECT document FROM shared_memory').pluck().get() as string);expect(active.database_records.map((r:any)=>r.id)).toEqual(['c']);expect(memoryCharacters(active)).toBeLessThanOrEqual(4000);
 expect(db.prepare('SELECT observed_at,source_order FROM memory_item_metadata').all()).toEqual([{observed_at:null,source_order:0}]);
 expect(db.prepare('SELECT * FROM session_memories').all()).toEqual(snapshots);const retired=JSON.parse(db.prepare('SELECT evidence FROM memory_retired_jobs').pluck().get() as string);expect(retired.job).toEqual(jobs[0]);expect(retired.attempts).toEqual(attempts);expect(retired.responses[0].response_content).toBe('old response');
 expect(db.prepare('SELECT state FROM memory_jobs').pluck().get()).toBe('skipped');expect(db.prepare('SELECT count(*) FROM memory_add_jobs').pluck().get()).toBe(0);
 const backup=readFileSync(join(dir,'stomylos.pre-migration-v27.sqlite3'));migrateDatabase(db,dir);expect(readFileSync(join(dir,'stomylos.pre-migration-v27.sqlite3'))).toEqual(backup);
 expect(db.pragma('foreign_key_check')).toEqual([]);
});
it('rolls back step 28 and retries with the original verified backup',()=>{
 const {dir,db,document}=fixture(),exec=db.exec.bind(db);const fault=vi.spyOn(db,'exec').mockImplementation(sql=>{const result=exec(sql);if(sql.includes('CREATE TABLE memory_add_jobs'))throw new Error('cutover failure');return result;});
 expect(()=>migrateDatabase(db,dir)).toThrow('cutover failure');fault.mockRestore();expect(db.pragma('user_version',{simple:true})).toBe(27);validateSchema(db,source);expect(db.prepare('SELECT document FROM shared_memory').pluck().get()).toBe(document);
 const bytes=readFileSync(join(dir,'stomylos.pre-migration-v27.sqlite3'));migrateDatabase(db,dir);expect(readFileSync(join(dir,'stomylos.pre-migration-v27.sqlite3'))).toEqual(bytes);expect(db.pragma('user_version',{simple:true})).toBe(29);
});

it('opens the installed archive-bearing schema 28, rolls back interrupted removal and preserves every remaining table in schema 29',()=>{
 const {dir,db,document}=fixture(source28,28);
 const active=memoryJson({character_id:'shared',revision:8,database_records:[{id:'active',text:'Keep this active note.'}]});
 db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(active,memoryHash(active));
 db.prepare("INSERT INTO memory_item_metadata VALUES('active',0,0,NULL,NULL,NULL,'legacy')").run();
 db.prepare("INSERT INTO memory_cutover_archive VALUES(1,?,?,?,0)").run(document,memoryHash(document),'2026-09-11');
 const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='memory_cutover_archive' ORDER BY name").all() as {name:string}[]).map(r=>r.name);
 const state=()=>Object.fromEntries(tables.map(t=>[t,db.prepare(`SELECT * FROM "${t}"`).all()]));const before=state();
 const exec=db.exec.bind(db),fault=vi.spyOn(db,'exec').mockImplementation(sql=>{const result=exec(sql);if(sql.includes('DROP TABLE memory_cutover_archive'))throw new Error('removal interrupted');return result;});
 expect(()=>migrateDatabase(db,dir)).toThrow('removal interrupted');fault.mockRestore();
 expect(db.pragma('user_version',{simple:true})).toBe(28);validateSchema(db,source28);expect(state()).toEqual(before);
 const backup=readFileSync(join(dir,'stomylos.pre-migration-v28.sqlite3'));
 migrateDatabase(db,dir);expect(db.pragma('user_version',{simple:true})).toBe(29);validateSchema(db,current);expect(state()).toEqual(before);
 expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('memory_cutover_archive','immutable_memory_cutover')").all()).toEqual([]);
 expect(readFileSync(join(dir,'stomylos.pre-migration-v28.sqlite3'))).toEqual(backup);
 migrateDatabase(db,dir);expect(state()).toEqual(before);
});
