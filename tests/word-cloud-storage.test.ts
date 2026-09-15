import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../src/main/database';
import { StarterStore } from '../src/main/starter-store';
import { Coordinator } from '../src/main/coordinator';
import type { DatabaseClient } from '../src/main/db-client';
import { validateCommand } from '../src/main/ipc';
import current from '../src/main/schema.sql?raw';
import { migrateDatabase, validateSchema, currentSchema } from '../src/main/database-migrations';
it('migrates 39 with rollback, preserved sessions, backup, restart and no-op',()=>{
 const old=current.replace(/\n-- Public schema 39 -> 40:[\s\S]*$/,''),dir=mkdtempSync('/tmp/stomylos-cloud-migration-');
 let db=new Database(join(dir,'stomylos.sqlite3'));
 try {
  db.exec(old);db.pragma('user_version=39');db.transaction(()=>new StarterStore(db).initialize())();
  db.exec("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind,draft) VALUES('s','draft','2026-09-15','{}','user','Keep my text')");
  const before=db.prepare('SELECT * FROM sessions').all(),execute=db.exec.bind(db);
  const fault=vi.spyOn(db,'exec').mockImplementation(sql=>{const value=execute(sql);if(sql.includes('CREATE TABLE word_cloud_preferences'))throw Error('fault');return value;});
  expect(()=>migrateDatabase(db,dir)).toThrow('fault');fault.mockRestore();
  expect(db.pragma('user_version',{simple:true})).toBe(39);validateSchema(db,old);
  const backup=readFileSync(join(dir,'stomylos.pre-migration-v39.sqlite3'));
  db.close();db=new Database(join(dir,'stomylos.sqlite3'));migrateDatabase(db,dir);
  expect(db.pragma('user_version',{simple:true})).toBe(currentSchema);validateSchema(db,current);
  expect(db.prepare('SELECT * FROM sessions').all()).toEqual(before);
  expect(db.prepare('SELECT enabled FROM word_cloud_preferences').pluck().get()).toBe(1);
  expect(db.pragma('integrity_check',{simple:true})).toBe('ok');expect(db.pragma('foreign_key_check')).toEqual([]);
  migrateDatabase(db,dir);expect(readFileSync(join(dir,'stomylos.pre-migration-v39.sqlite3'))).toEqual(backup);
 } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
it('validates content-free IPC and persists the global setting through coordinator and fresh-store restart',async()=>{
 const dir=mkdtempSync('/tmp/stomylos-cloud-store-');let store=new Store(dir,resolve('native/advisory-lock.node'));
 try {
  const session=store.createSession(), before=store.session(session.id);
  const complete=vi.fn(), stream=vi.fn();
  const db={ready:Promise.resolve(),call:async(method:string,...args:any[])=>(store as any)[method](...args)} as unknown as DatabaseClient;
  const app=new Coordinator(db,{complete,stream} as any,{keyPresent:false,keyPath:'',dataPath:dir,appVersion:'test',development:true},()=>{},()=>false);
  expect((await app.snapshot()).settings.wordCloud).toBe(true);
  validateCommand('setWordCloudPreference',{enabled:false});
  for(const args of [{enabled:1},{enabled:false,word:'song'},{}]) expect(()=>validateCommand('setWordCloudPreference',args)).toThrow();
  expect(await app.command('setWordCloudPreference',{enabled:false})).toBe(false);
  expect((await app.snapshot()).settings.wordCloud).toBe(false);
  expect(complete).not.toHaveBeenCalled();expect(stream).not.toHaveBeenCalled();
  expect(store.session(session.id)).toEqual(before);expect(store.messages(session.id)).toEqual([]);
  store.close();store=new Store(dir,resolve('native/advisory-lock.node'));
  expect(store.wordCloudPreference()).toBe(false);
  store.setWordCloudPreference(true);expect(store.wordCloudPreference()).toBe(true);
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
