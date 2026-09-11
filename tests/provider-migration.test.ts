import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/database';
import { migrateDatabase, validateSchema } from '../src/main/database-migrations';
import old from '../src/main/migrations/schema-v26.sql?raw';
import current from '../src/main/schema.sql?raw';
import { prepareProviderRequest } from '../src/main/provider-policy';
const dirs:string[]=[]; afterEach(()=>{ for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true}); });
const tables=['model_requests','search_router_attempts','pattern_report_attempts','memory_attempts','memory_cleanup_attempts','explanation_attempts'];
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'stomylos-provider-upgrade-'));dirs.push(dir);
 const store=new Store(dir,resolve('native/advisory-lock.node'));
 const s=store.createSession();store.setOpening(s.id,randomUUID(),s.opening_revision,'user');store.selectManual(s.id,'model_03');store.searchMode(s.id,'off');
 store.submit(s.id,'Keep this exact source.');store.commitRoute(s.id,null,'fixture',null);
 const request=store.prepareChat(s.id,randomUUID());store.dispatch(request.id);store.prepareReply(s.id,request.id);store.failRequest(request.id,'http_429','',{});
 store.close();
 const db=new Database(join(dir,'stomylos.sqlite3'));for(const t of tables)db.exec(`ALTER TABLE ${t} DROP COLUMN provider_request`);db.pragma('user_version = 26');validateSchema(db,old);
 return{dir,db,session:s,request};
}
it('upgrades 26 to 27 additively, preserves old requests and creates truthful linked retry routing',()=>{
 const {dir,db,session,request}=fixture();
 try {
  migrateDatabase(db,dir);validateSchema(db,current);expect(db.pragma('user_version',{simple:true})).toBe(27);
  const prior=db.prepare('SELECT * FROM model_requests WHERE id=?').get(request.id) as any;
  expect(prior.config).toBe(request.config);expect(prior.config_hash).toBe(request.config_hash);expect(prior.provider_request).toBeNull();
  const backup=readFileSync(join(dir,'stomylos.pre-migration-v26.sqlite3'));migrateDatabase(db,dir);expect(readFileSync(join(dir,'stomylos.pre-migration-v26.sqlite3'))).toEqual(backup);
 }finally{db.close();}
 const store=new Store(dir,resolve('native/advisory-lock.node'));
 try{
  const retry=store.prepareChat(session.id,randomUUID(),'retry');expect(retry.parent_id).toBe(request.id);
  const input=store.chatBody(retry.id),routed=store.prepareProvider('model',retry.id,input,null);
  expect(routed).toEqual(prepareProviderRequest(input));expect(routed.body.provider.allow_fallbacks).toBe(true);
  expect(store.prepareProvider('model',retry.id,input,null)).toEqual(routed);
  expect(()=>store.prepareProvider('model',retry.id,{...input,model:'changed'},null)).toThrow('provider_source_changed');
  expect(store.request(request.id).config_hash).toBe(request.config_hash);
  expect((store.request(request.id) as any).provider_request).toBeNull();
  expect(JSON.parse((store.request(retry.id) as any).provider_request)).toEqual(routed);
  expect(store.integrity().foreignKeys).toEqual([]);
 }finally{store.close();}
});
it('rolls back a partial 27 step and reuses its consistent backup on recovery',()=>{
 const {db,dir}=fixture();try{
  const exec=db.exec.bind(db);const fault=vi.spyOn(db,'exec').mockImplementation(sql=>{const result=exec(sql);if(sql.includes('ADD COLUMN provider_request'))throw Error('interrupted upgrade');return result;});
  expect(()=>migrateDatabase(db,dir)).toThrow('interrupted upgrade');fault.mockRestore();
  expect(db.pragma('user_version',{simple:true})).toBe(26);validateSchema(db,old);
  const before=readFileSync(join(dir,'stomylos.pre-migration-v26.sqlite3'));migrateDatabase(db,dir);validateSchema(db,current);
  expect(readFileSync(join(dir,'stomylos.pre-migration-v26.sqlite3'))).toEqual(before);
 }finally{db.close();}
});
