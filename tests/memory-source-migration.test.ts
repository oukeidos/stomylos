import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import schema from '../src/main/schema.sql?raw';
import {migrateDatabase,validateSchema,currentSchema} from '../src/main/database-migrations';
import {StarterStore} from '../src/main/starter-store';
import {memoryHash} from '../src/main/memory-updater';
const fixtures:{dir:string;db:Database.Database}[]=[];
afterEach(()=>{for(const f of fixtures.splice(0)){f.db.close();rmSync(f.dir,{recursive:true,force:true});}});
it('upgrades schema 42 with rollback, immutable legacy attempts, backup and current parity',()=>{
 const dir=mkdtempSync('/tmp/stomylos-source-migration-'),db=new Database(join(dir,'stomylos.sqlite3'));fixtures.push({dir,db});
 const old=schema.replace(/\n-- Public schema 42 -> 43:[\s\S]*$/,'');db.exec(old);db.pragma('user_version=42');
 const document=JSON.stringify({character_id:'shared',revision:0,database_records:[]});db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run(document,memoryHash(document));db.transaction(()=>new StarterStore(db).initialize())();
 for(const [i,state] of ['pending','received','failed','interrupted'].entries()){
  db.prepare("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind,memory_add_scope) VALUES(?,'active','2026-09-15','{}','user','session')").run('s'+i);
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,origin,delivery,content) VALUES(?,?,0,'user','learner','complete','Source')").run('m'+i,'s'+i);
  db.prepare("UPDATE sessions SET state='ended' WHERE id=?").run('s'+i);
  db.prepare("INSERT INTO memory_add_jobs(session_id,message_id,input_json,input_hash,config,config_hash,created_at,state,source_kind,source_manifest) VALUES(?,?,'frozen','ih','old config','ch','2026-09-15',?,'session','manifest')").run('s'+i,'m'+i,state);
  if(state!=='pending')db.prepare("INSERT INTO memory_add_attempts(id,job_id,body,body_hash,status,created_at,response_content) VALUES(?,?,'frozen body','bh',?,'2026-09-15','old response')").run('a'+i,i+1,state);
 }
 const jobs=db.prepare('SELECT * FROM memory_add_jobs').all(),attempts=db.prepare('SELECT * FROM memory_add_attempts').all();
 const exec=db.exec.bind(db),fault=vi.spyOn(db,'exec').mockImplementation(sql=>{const r=exec(sql);if(sql.includes('42 -> 43'))throw Error('migration fault');return r;});
 expect(()=>migrateDatabase(db,dir)).toThrow('migration fault');fault.mockRestore();expect(db.pragma('user_version',{simple:true})).toBe(42);validateSchema(db,old);
 const path=join(dir,'stomylos.pre-migration-v42.sqlite3'),backup=readFileSync(path);migrateDatabase(db,dir);expect(db.pragma('user_version',{simple:true})).toBe(currentSchema);validateSchema(db,schema);
 expect(db.prepare('SELECT * FROM memory_add_jobs').all()).toEqual(jobs);expect(db.prepare('SELECT * FROM memory_add_attempts').all()).toEqual(attempts);expect(db.prepare('SELECT count(*) FROM memory_source_checkpoints').pluck().get()).toBe(0);
 migrateDatabase(db,dir);expect(readFileSync(path)).toEqual(backup);
});
