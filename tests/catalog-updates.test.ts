import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Store } from '../src/main/database';
import { StarterStore } from '../src/main/starter-store';
import { selectCatalog } from '../src/main/starter-catalog';
import { migrateDatabase, currentSchema, validateSchema } from '../src/main/database-migrations';
import { readCatalog } from '../src/main/migrations/019-data';
import { legacyCatalogRaw } from '../src/main/catalog-v1-compat';
import { readCurrentCatalog, verifyInstalledCatalog, catalogHash, updateCatalog } from '../src/main/catalog-content';
import { prepareBackup, installBackup } from '../src/main/backup';
import { emptyMemory, memoryJson, memoryHash } from '../src/main/memory-updater';
import { flattenMemory } from '../src/main/memory-flat';
import s13 from '../src/main/migrations/schema-v13.sql?raw';
import s18 from '../src/main/migrations/schema-v18.sql?raw';
import s19 from '../src/main/migrations/schema-v19.sql?raw';
import s23 from '../src/main/migrations/schema-v23.sql?raw';
import s24 from '../src/main/schema.sql?raw';
const dirs:string[]=[],dbs:Database.Database[]=[],stores:Store[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const db of dbs.splice(0))if(db.open)db.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function dir(){const d=mkdtempSync(join(tmpdir(),'catalog-update-'));dirs.push(d);return d;}
function legacy(version=23){const directory=dir(),db=new Database(join(directory,'stomylos.sqlite3'));dbs.push(db);db.exec(({13:s13,18:s18,19:s19,23:s23} as Record<number,string>)[version]);db.pragma(`user_version=${version}`);db.transaction(()=>new StarterStore(db).initialize())();const doc=memoryJson(version>=22?flattenMemory(emptyMemory('shared')):emptyMemory('shared'));db.prepare('INSERT INTO shared_memory VALUES(1,?,?)').run(doc,memoryHash(doc));return {db,directory};}
function fresh(){const directory=dir(),store=new Store(directory,resolve('native/advisory-lock.node'));stores.push(store);return {directory,store,db:(store as any).db as Database.Database};}
const id='catalog:joint-v1:Q00004';
const counts=(db:Database.Database)=>db.prepare('SELECT answer_count,skip_count,eligible FROM starter_catalog_entries WHERE question_id=?').get(id);
it('reconstructs frozen v1 byte-for-byte and bundles exact approved revision 2',()=>{
 expect(legacyCatalogRaw()).toBe(readFileSync('src/main/assets/starter-catalog-v1.json','utf8'));
 expect(readCatalog()).toHaveLength(5000);const c=readCurrentCatalog();expect(c.manifest.revision).toBe(2);
 expect(c.rows).toEqual(readFileSync('../experiments/EXP-030-starter-pool-diversity/drafts/direct-pool/english-revision/ENGLISH_REVISED.jsonl','utf8').trim().split('\n').map(s=>JSON.parse(s)));
 const {db}=fresh();expect(verifyInstalledCatalog(db).revision).toBe(2);expect(db.prepare('SELECT COUNT(*) FROM starter_catalog_entries').pluck().get()).toBe(5000);
});
it.each([13,18,19,23])('upgrades supported schema %i to current with exact schema parity and a no-op second startup',version=>{
 const {db,directory}=legacy(version);migrateDatabase(db,directory);validateSchema(db,s24);expect(db.pragma('user_version',{simple:true})).toBe(currentSchema);expect(verifyInstalledCatalog(db).revision).toBe(2);
 const before=db.prepare('SELECT total_changes()').pluck().get();const backup=readFileSync(join(directory,`stomylos.pre-migration-v${version}.sqlite3`));migrateDatabase(db,directory);expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(before);expect(readFileSync(join(directory,`stomylos.pre-migration-v${version}.sqlite3`))).toEqual(backup);
});
it('inherits counters and eligibility and rolls back text/schema/version on a late failure, then resumes',()=>{
 const {db,directory}=legacy();db.prepare('UPDATE starter_catalog_entries SET answer_count=8,skip_count=4,eligible=0 WHERE question_id=?').run(id);db.prepare("UPDATE starter_questions SET state='retired' WHERE id=?").run(id);
 const before=db.prepare('SELECT * FROM starter_questions WHERE id=?').get(id),prepare=db.prepare.bind(db);
 const spy=vi.spyOn(db,'prepare').mockImplementation((sql:any)=>{if(sql.startsWith('UPDATE starter_catalog_install SET revision='))throw Error('catalog interruption');return prepare(sql);});
 expect(()=>migrateDatabase(db,directory)).toThrow('catalog interruption');spy.mockRestore();expect(db.pragma('user_version',{simple:true})).toBe(23);validateSchema(db,s23);expect(db.prepare('SELECT * FROM starter_questions WHERE id=?').get(id)).toEqual(before);
 migrateDatabase(db,directory);expect(counts(db)).toEqual({answer_count:8,skip_count:4,eligible:0});expect(db.prepare('SELECT text FROM starter_questions WHERE id=?').pluck().get(id)).toBe(readCurrentCatalog().rows.find(r=>r.id==='Q00004')!.en);
});
it('updates same-schema content across skipped revisions, rejects newer/corrupt state, and keeps no-op bytes',()=>{
 const {db,directory}=fresh();const target=structuredClone(readCurrentCatalog());target.manifest.revision=5;target.manifest.version='stomylos_catalog_v5';target.rows[3].en='What would convince you that a person understands a subject deeply?';target.manifest.sha256=catalogHash(target.rows);
 migrateDatabase(db,directory,target);expect(verifyInstalledCatalog(db,5).revision).toBe(5);expect(readdirSync(directory).some(n=>n.startsWith('stomylos.pre-catalog-r2-'))).toBe(true);
 const content=JSON.stringify(db.prepare('SELECT * FROM starter_catalog_install').all());expect(()=>migrateDatabase(db,directory)).toThrow('starter_catalog_newer');expect(JSON.stringify(db.prepare('SELECT * FROM starter_catalog_install').all())).toBe(content);
 migrateDatabase(db,directory,target);db.prepare("UPDATE starter_questions SET text='tampered' WHERE id=?").run(id);expect(()=>migrateDatabase(db,directory,target)).toThrow('starter_catalog_corrupt');
});
it('rejects a changed hash at the same revision and changed IDs without overwriting',()=>{
 const {db}=fresh(),bad=structuredClone(readCurrentCatalog());bad.rows[0].en='A different question?';bad.manifest.sha256=catalogHash(bad.rows);expect(()=>updateCatalog(db,bad)).toThrow('starter_catalog_corrupt');
 bad.manifest.revision=3;bad.manifest.version='stomylos_catalog_v3';bad.rows[0].id='Q99999';bad.manifest.sha256=catalogHash(bad.rows);expect(()=>db.transaction(()=>updateCatalog(db,bad))()).toThrow('starter_catalog_corrupt');expect(verifyInstalledCatalog(db).revision).toBe(2);
});
function copyRow(db:Database.Database,table:string,row:Record<string,unknown>){const keys=Object.keys(row);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));}
it.each(['draft','parked','legacy'])('preserves a changed %s opening, counts by lineage, and excludes its successor',mode=>{
 const template=fresh(),session=template.store.createSession(),old=readCatalog().find(r=>r.id==='Q00004')!;
 const {db,directory}=legacy();const originalId=mode==='legacy'?'legacy-question':id;
 if(mode==='legacy')db.prepare("INSERT INTO starter_questions(id,version,text,normalized_text,origin,state,created_at) VALUES(?,'old',?,?,'seed','retired','today')").run(originalId,old.en,old.en.toLowerCase());
 const original=template.store.messages(session.id)[0];const saved={...session,starter_id:originalId,starter_version:'stomylos_catalog_v1',starter_text:old.en,draft:'My unfinished answer.'};const message={...original,content:old.en};
 if(mode==='parked'){const parked={question:{id,version:saved.starter_version,text:old.en},message};const config=JSON.parse(saved.chat_config);config.opening.kind='user';saved.chat_config=JSON.stringify(config);Object.assign(saved,{opening_kind:'user',starter_id:null,starter_version:null,starter_text:null,parked_starter:JSON.stringify(parked)});}
 copyRow(db,'sessions',saved);if(mode!=='parked')copyRow(db,'messages',message);
 db.prepare("INSERT INTO starter_events VALUES('shown',?,'presented',?,'stomylos_catalog_v1',?,'today')").run(session.id,originalId,old.en);
 const snap=JSON.stringify(db.prepare('SELECT * FROM sessions').all());const msg=JSON.stringify(db.prepare('SELECT * FROM messages').all());migrateDatabase(db,directory);expect(JSON.stringify(db.prepare('SELECT * FROM sessions').all())).toBe(snap);expect(JSON.stringify(db.prepare('SELECT * FROM messages').all())).toBe(msg);
 for(let i=0;i<4;i++)expect(selectCatalog(db,undefined,session.id,()=>0).question.id).not.toBe(id);
 db.close();const reopened=new Store(directory,resolve('native/advisory-lock.node'));stores.push(reopened);
 if(mode==='parked')reopened.setOpening(session.id,'restore',saved.opening_revision,'starter');
 expect(reopened.session(session.id).starter_text).toBe(old.en);expect(reopened.session(session.id).draft).toBe('My unfinished answer.');
 reopened.submit(session.id,'My answer.','submit');reopened.submit(session.id,'My answer.','submit');expect(counts((reopened as any).db)).toEqual({answer_count:1,skip_count:0,eligible:1});expect(reopened.messages(session.id)[0].content).toBe(old.en);
});
function archive(db:Database.Database,version:number){const file=join(dir(),'backup.gz');const database=readFileSync(db.name),manifest={format:1,appVersion:'old',schemaVersion:version,createdAt:new Date().toISOString(),files:[{path:'stomylos.sqlite3',size:database.length,sha256:createHash('sha256').update(database).digest('hex')}]};const json=Buffer.from(JSON.stringify(manifest)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);writeFileSync(file,gzipSync(Buffer.concat([Buffer.from('STOMYLOS_BACKUP_1\n'),length,json,database])));return file;}
it('upgrades a supported backup in staging and installs latest, refusing a newer catalog before replacement',async()=>{
 const old=legacy(),file=archive(old.db,23),target=fresh();target.store.close();stores.splice(stores.indexOf(target.store),1);
 const before=readFileSync(join(target.directory,'stomylos.sqlite3'));const prepared=await prepareBackup(target.directory,file);expect(readFileSync(join(target.directory,'stomylos.sqlite3'))).toEqual(before);
 await installBackup(target.directory,prepared.directory);const check=new Database(join(target.directory,'stomylos.sqlite3'));dbs.push(check);expect(verifyInstalledCatalog(check).revision).toBe(2);check.prepare("UPDATE starter_catalog_install SET revision=99").run();const newer=archive(check,24);check.close();const saved=readFileSync(join(target.directory,'stomylos.sqlite3'));await expect(prepareBackup(target.directory,newer)).rejects.toThrow('starter_catalog_newer');expect(readFileSync(join(target.directory,'stomylos.sqlite3'))).toEqual(saved);
});
it('preserves active/ended session, message, event and frozen request snapshots byte-for-byte',()=>{
 const template=fresh(),s=template.store.createSession(),{db,directory}=legacy(),old=readCatalog().find(r=>r.id==='Q00004')!;
 for(const state of ['ended','active']){
  copyRow(db,'sessions',{...s,id:state,state:'active',starter_id:id,starter_version:'stomylos_catalog_v1',starter_text:old.en});
  copyRow(db,'messages',{...template.store.messages(s.id)[0],id:`m-${state}`,session_id:state,content:old.en});
  db.prepare("INSERT INTO model_requests(id,session_id,role,status,created_at,source_sequence,source_hash,config,config_hash,response_content,metadata) VALUES(?,?,'chat','succeeded','then',0,'frozen hash',?,'frozen config hash','old response','{}')").run(`r-${state}`,state,JSON.stringify({question:old.en}));
  db.prepare("INSERT INTO starter_events VALUES(?,?,'answered',?,'stomylos_catalog_v1',?,'then')").run(`e-${state}`,state,id,old.en);
  if(state==='ended')db.prepare("UPDATE sessions SET state='ended' WHERE id=?").run(state);
 }
 const snapshots=()=>['sessions','messages','model_requests','starter_events'].map(t=>JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()));const before=snapshots();migrateDatabase(db,directory);expect(snapshots()).toEqual(before);
});
it('skips preserved v1 text exactly once and uses stable IDs for recent and same-session exclusions',()=>{
 const t=fresh(),s=t.store.createSession(),{db,directory}=legacy(),old=readCatalog().find(r=>r.id==='Q00004')!;
 copyRow(db,'sessions',{...s,starter_id:id,starter_version:'stomylos_catalog_v1',starter_text:old.en});copyRow(db,'messages',{...t.store.messages(s.id)[0],content:old.en});
 db.prepare("INSERT INTO starter_events VALUES('old-shown',?,'presented',?,'stomylos_catalog_v1',?,'then')").run(s.id,id,old.en);migrateDatabase(db,directory);
 db.transaction(()=>{db.prepare("UPDATE starter_catalog_entries SET eligible=0 WHERE question_id NOT IN (?, 'catalog:joint-v1:Q05912')").run(id);db.prepare("UPDATE starter_questions SET state='retired' WHERE id IN (SELECT question_id FROM starter_catalog_entries WHERE eligible=0)").run();})();
 expect(selectCatalog(db,undefined,undefined,()=>0).question.id).toBe('catalog:joint-v1:Q05912');expect(selectCatalog(db,undefined,s.id,()=>0).question.id).toBe('catalog:joint-v1:Q05912');
 db.close();const store=new Store(directory,resolve('native/advisory-lock.node'));stores.push(store);store.replaceQuestion(s.id,'skip-old',id,s.opening_revision);store.replaceQuestion(s.id,'skip-old',id,s.opening_revision);
 const current=(store as any).db as Database.Database;expect(counts(current)).toEqual({answer_count:0,skip_count:1,eligible:1});expect(current.prepare('SELECT outgoing_text,outgoing_version FROM starter_skips').get()).toEqual({outgoing_text:old.en,outgoing_version:'stomylos_catalog_v1'});
});
