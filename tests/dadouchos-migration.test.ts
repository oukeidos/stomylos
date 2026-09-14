import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { StarterStore } from '../src/main/starter-store';
import current from '../src/main/schema.sql?raw';
import { migrateDatabase, validateSchema, currentSchema } from '../src/main/database-migrations';
it('adds content-free Dadouchos history from v38 with atomic rollback, preservation and restart',()=>{
 const old=current.replace(/\n-- Public schema 38 -> 39:[\s\S]*$/,''),dir=mkdtempSync('/tmp/stomylos-dadouchos-migration-'),db=new Database(join(dir,'stomylos.sqlite3'));
 try{
  db.exec(old);db.pragma('user_version=38');db.transaction(()=>new StarterStore(db).initialize())();
  db.exec("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind) VALUES('s','draft','2026-09-14','{}','user'); INSERT INTO genie_request_attempts(id,session_id,status,created_at,settings) VALUES('g','s','succeeded','2026-09-14','{}')");
  const before=db.prepare('SELECT * FROM sessions').all(),exec=db.exec.bind(db);
  const fault=vi.spyOn(db,'exec').mockImplementation(sql=>{const value=exec(sql);if(sql.includes('CREATE TABLE dadouchos_request_attempts'))throw Error('fault');return value;});
  expect(()=>migrateDatabase(db,dir)).toThrow('fault');fault.mockRestore();expect(db.pragma('user_version',{simple:true})).toBe(38);validateSchema(db,old);
  const backup=readFileSync(join(dir,'stomylos.pre-migration-v38.sqlite3'));migrateDatabase(db,dir);
  expect(db.pragma('user_version',{simple:true})).toBe(currentSchema);validateSchema(db,current);expect(db.prepare('SELECT * FROM sessions').all()).toEqual(before);
  expect(db.prepare('SELECT id FROM genie_request_attempts').pluck().get()).toBe('g');expect(db.prepare('SELECT * FROM dadouchos_request_attempts').all()).toEqual([]);
  migrateDatabase(db,dir);expect(readFileSync(join(dir,'stomylos.pre-migration-v38.sqlite3'))).toEqual(backup);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
