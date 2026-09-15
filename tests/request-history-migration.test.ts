import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/main/database';
import current from '../src/main/schema.sql?raw';
import { migrateDatabase, validateSchema, currentSchema } from '../src/main/database-migrations';
const dirs:string[]=[],dbs:Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))if(db.open)db.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'stomylos-history-migration-'));dirs.push(dir);
 const store=new Store(dir,'isolated' as const);const s=store.createSession();store.saveDraft(s.id,'Keep this unsent draft');store.close();
 const db=new Database(join(dir,'stomylos.sqlite3'));dbs.push(db);db.exec('DROP TABLE genie_request_attempts; PRAGMA user_version=33;');
 return {dir,db,id:s.id};
}
it('upgrades schema 33 with immutable history, verified backup, empty new history and current no-op',()=>{
 const {dir,db,id}=fixture();const before=db.prepare('SELECT * FROM sessions').all();
 migrateDatabase(db,dir);validateSchema(db,current);expect(db.pragma('user_version',{simple:true})).toBe(currentSchema);
 expect(db.prepare('SELECT * FROM sessions').all()).toEqual(before);expect(db.prepare('SELECT * FROM genie_request_attempts').all()).toEqual([]);
 const file=join(dir,'stomylos.pre-migration-v33.sqlite3'),bytes=readFileSync(file);const backup=new Database(file,{readonly:true});dbs.push(backup);
 expect(backup.prepare('SELECT draft FROM sessions WHERE id=?').pluck().get(id)).toBe('Keep this unsent draft');expect(backup.pragma('user_version',{simple:true})).toBe(33);
 migrateDatabase(db,dir);expect(readFileSync(file)).toEqual(bytes);expect(db.pragma('foreign_key_check')).toEqual([]);
});
it('rolls back the new history step and resumes without replacing the original recovery backup',()=>{
 const {dir,db}=fixture(),original=db.exec.bind(db),before=db.prepare('SELECT * FROM sessions').all();
 const fault=vi.spyOn(db,'exec').mockImplementation(sql=>{const result=original(sql);if(sql.includes('CREATE TABLE genie_request_attempts'))throw new Error('history step interrupted');return result;});
 expect(()=>migrateDatabase(db,dir)).toThrow('history step interrupted');fault.mockRestore();
 expect(db.pragma('user_version',{simple:true})).toBe(33);expect(db.prepare('SELECT * FROM sessions').all()).toEqual(before);
 validateSchema(db,current.replace(/\n-- Public schema 33 -> 34:[\s\S]*$/,''));
 const file=join(dir,'stomylos.pre-migration-v33.sqlite3'),bytes=readFileSync(file);db.close();
 const restart=new Database(join(dir,'stomylos.sqlite3'));dbs.push(restart);migrateDatabase(restart,dir);validateSchema(restart,current);expect(readFileSync(file)).toEqual(bytes);
});
