import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { StarterStore } from '../src/main/starter-store';
import { conversationSnapshot } from '../src/main/contracts';
import { replyContext } from '../src/main/reply-context';
import old from '../src/main/migrations/schema-v31.sql?raw';
import current from '../src/main/schema.sql?raw';
import { migrateDatabase, validateSchema, currentSchema } from '../src/main/database-migrations';
const fixtures:{dir:string,db:Database.Database}[]=[];
afterEach(()=>{for(const {dir,db} of fixtures.splice(0)){db.close();rmSync(dir,{recursive:true,force:true});}});
it.each([false,true])('upgrades preference memory without rewriting chat history (saved choice: %s)',selected=>{
 const dir=mkdtempSync('/tmp/stomylos-composer-migration-'),db=new Database(join(dir,'stomylos.sqlite3'));fixtures.push({dir,db});
 db.exec(old);db.pragma('user_version=31');db.transaction(()=>new StarterStore(db).initialize())();
 if(selected){
   const config=JSON.stringify({...conversationSnapshot('user'),reply_context:replyContext('standard')});
   db.prepare("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind,search_mode,reply_context_revision,last_reply_context_operation,draft) VALUES('s','draft','2026-09-12',?,'user','off',1,?,'Kept draft')").run(config,JSON.stringify({operationId:'choice',expectedRevision:0,mode:'standard',revision:1}));
 }
 const before=db.prepare('SELECT * FROM sessions').all(),exec=db.exec.bind(db);
 const fault=vi.spyOn(db,'exec').mockImplementation(sql=>{const result=exec(sql);if(sql.includes('CREATE TABLE search_preferences'))throw new Error('simulated interruption');return result;});
 expect(()=>migrateDatabase(db,dir)).toThrow('simulated interruption');fault.mockRestore();
 expect(db.pragma('user_version',{simple:true})).toBe(31);validateSchema(db,old);
 const backup=join(dir,'stomylos.pre-migration-v31.sqlite3'),bytes=readFileSync(backup);
 migrateDatabase(db,dir);expect(db.pragma('user_version',{simple:true})).toBe(currentSchema);validateSchema(db,current);
 expect(db.prepare('SELECT * FROM sessions').all()).toEqual(before);
 expect(db.prepare('SELECT mode FROM search_preferences').pluck().get()).toBe(selected?'off':'auto');
 expect(db.prepare('SELECT mode FROM reply_preferences').pluck().get()).toBe(selected?'standard':'one_point');
 migrateDatabase(db,dir);expect(readFileSync(backup)).toEqual(bytes);
});
