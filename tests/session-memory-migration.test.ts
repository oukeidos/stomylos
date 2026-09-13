import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import current from '../src/main/schema.sql?raw';
import {migrateDatabase,validateSchema,currentSchema} from '../src/main/database-migrations';
import {StarterStore} from '../src/main/starter-store';
import {installCatalog19} from '../src/main/migrations/019-data';
import {memoryHash} from '../src/main/memory-updater';
const sources=import.meta.glob('../src/main/migrations/schema-v*.sql',{query:'?raw',import:'default',eager:true}) as Record<string,string>;
const source37=current.replace(/\n-- Public schema 37 -> 38:[\s\S]*$/, '');
const fixtures:{dir:string;db:Database.Database}[]=[];
afterEach(()=>{for(const {dir,db} of fixtures.splice(0)){db.close();rmSync(dir,{recursive:true,force:true});}});
function fixture(version:number){
 const source=version<14?13:version<19?18:version===19?19:version<22?21:version<24?23:version<26?25:version;
 const sql=version>=36?source37:version>=34?current.replace(/\n-- Public schema 35 -> 36:[\s\S]*$/,''):version===33?current.replace(/\n-- Public schema 33 -> 34:[\s\S]*$/,''):version===32?current.replace(/\n-- Public schema 32 -> 33:[\s\S]*$/,''):sources[`../src/main/migrations/schema-v${source}.sql`];
 const dir=mkdtempSync('/tmp/stomylos-session-migration-'),db=new Database(join(dir,'stomylos.sqlite3'));fixtures.push({dir,db});db.exec(sql);db.pragma(`user_version=${version}`);
 const document=JSON.stringify(version<22?{character_id:'shared',revision:0,traits:[],relationships:[],experiences:[],intentions:[]}:{character_id:'shared',revision:0,database_records:[]});db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run(document,memoryHash(document));
 if(version>=24)db.transaction(()=>new StarterStore(db).initialize())();else if(version>=19)db.transaction(()=>installCatalog19(db))();
 return {dir,db,sql};
}
it.each(Array.from({length:25},(_,i)=>i+13))('upgrades supported schema %i to session-capable schema with fresh parity and no-op',version=>{
 const {db,dir}=fixture(version);migrateDatabase(db,dir);expect(db.pragma('user_version',{simple:true})).toBe(currentSchema);validateSchema(db,current);
 const backup=join(dir,`stomylos.pre-migration-v${version}.sqlite3`),bytes=readFileSync(backup);migrateDatabase(db,dir);expect(readFileSync(backup)).toEqual(bytes);
});
it.each(['active','draft','ended'])('preserves legacy %s sessions and every frozen job byte through rollback and restart',state=>{
 const {db,dir,sql}=fixture(37);
 db.prepare('INSERT INTO sessions(id,state,created_at,chat_config,opening_kind) VALUES(?,?,?, ?,?)').run('source','active','2026-09-01','{}','user');
 db.exec("INSERT INTO messages(id,session_id,sequence,role,origin,delivery,content) VALUES('m','source',0,'user','learner','complete','Historical text')");
 db.exec("INSERT INTO memory_add_jobs(session_id,message_id,input_json,input_hash,config,config_hash,created_at,state) VALUES('source','m','frozen input','ih','frozen Luna config','ch','2026-09-01','received')");
 db.exec("INSERT INTO memory_add_attempts(id,job_id,body,body_hash,status,created_at,response_content) VALUES('a',1,'frozen wire','bh','received','2026-09-01','{\"add\":[]}')");
 db.prepare('UPDATE sessions SET state=? WHERE id=?').run(state,'source');
 const old=db.prepare('SELECT * FROM memory_add_jobs').get() as Record<string,unknown>,attempts=db.prepare('SELECT * FROM memory_add_attempts').all();
 const exec=db.exec.bind(db),fault=vi.spyOn(db,'exec').mockImplementation(sql=>{const result=exec(sql);if(sql.includes('37 -> 38'))throw Error('step 38 fault');return result;});
 expect(()=>migrateDatabase(db,dir)).toThrow('step 38 fault');fault.mockRestore();validateSchema(db,sql);expect(db.pragma('user_version',{simple:true})).toBe(37);
 const bytes=readFileSync(join(dir,'stomylos.pre-migration-v37.sqlite3'));migrateDatabase(db,dir);validateSchema(db,current);
 expect(db.prepare('SELECT * FROM memory_add_jobs').get()).toEqual({...old,source_kind:'turn',source_manifest:null});expect(db.prepare('SELECT * FROM memory_add_attempts').all()).toEqual(attempts);
 expect(db.prepare('SELECT memory_add_scope FROM sessions').all()).toEqual([{memory_add_scope:'turn'}]);
 expect(()=>db.exec("UPDATE sessions SET memory_add_scope='session'")).toThrow('Immutable');
 expect(readFileSync(join(dir,'stomylos.pre-migration-v37.sqlite3'))).toEqual(bytes);
 db.pragma(`user_version=${currentSchema+1}`);expect(()=>migrateDatabase(db,dir)).toThrow('unsupported_schema_version');
});
