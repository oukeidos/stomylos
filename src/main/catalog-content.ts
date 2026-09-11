import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import raw from './assets/starter-catalog-current.json?raw';
import manifest from './assets/starter-catalog-current-manifest.json';
import { AppFailure } from './errors';
import { catalogKey, verifyCatalog19, type CatalogRecord } from './migrations/019-data';

export const currentCatalogManifest = manifest;
export type Catalog = { rows: CatalogRecord[]; manifest: typeof manifest };
export const catalogHash = (rows: CatalogRecord[]) => createHash('sha256').update(JSON.stringify(rows)+'\n').digest('hex');
const fail = (): never => { throw new AppFailure('starter_catalog_corrupt'); };
export function readCurrentCatalog(payload = raw): Catalog {
  const rows: CatalogRecord[] = JSON.parse(payload);
  const catalog = { rows, manifest }; validateCatalog(catalog); return catalog;
}
export function validateCatalog(c: Catalog) {
  const ids = new Set<string>(), texts = new Set<string>(), cells: Record<string,number> = {};
  if (!Number.isSafeInteger(c.manifest.revision) || c.manifest.revision < 1 || c.manifest.catalog_id !== manifest.catalog_id ||
    c.manifest.version !== `stomylos_catalog_v${c.manifest.revision}` || !Array.isArray(c.rows) || c.rows.length !== 5000) fail();
  for (const r of c.rows) {
    if (Object.keys(r).sort().join(',') !== 'activity,en,id,subject' || !/^Q\d{5}$/.test(r.id) || typeof r.en !== 'string' ||
      !r.en.trim() || /[\uac00-\ud7af]/u.test(r.en) || ids.has(r.id) || texts.has(catalogKey(r.en))) fail();
    ids.add(r.id); texts.add(catalogKey(r.en)); const cell = `${r.subject}-${r.activity}`; cells[cell]=(cells[cell]??0)+1;
  }
  if (c.manifest.count !== c.rows.length || catalogHash(c.rows)!==c.manifest.sha256 ||
    JSON.stringify(Object.entries(cells).sort()) !== JSON.stringify(Object.entries(manifest.joint_cells).sort())) fail();
}
type Install = { catalog_id:string; version:string; source_hash:string; installed_count:number; revision:number };
export function hasCatalogUpdates(db: Database.Database) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='starter_catalog_aliases'").get(); }
export function verifyInstalledCatalog(db: Database.Database, maximumRevision = manifest.revision): Install {
  const all = db.prepare('SELECT * FROM starter_catalog_install').all() as Install[];
  if (all.length !== 1) fail(); const installed=all[0];
  if (!Number.isSafeInteger(installed.revision) || installed.revision < 1) fail();
  if (installed.revision > maximumRevision) throw new AppFailure('starter_catalog_newer');
  const stored=db.prepare(`SELECT c.*,q.text,q.version,q.normalized_text,q.state,q.origin,q.expires_at,
    (SELECT slot FROM starter_slots WHERE question_id=q.id) slot FROM starter_catalog_entries c
    JOIN starter_questions q ON q.id=c.question_id ORDER BY c.source_id`).all() as any[];
  const rows=stored.map(r=>({id:r.source_id,en:r.text,subject:r.subject,activity:r.activity}));
  validateCatalog({rows,manifest:{...manifest,revision:installed.revision,version:installed.version,count:installed.installed_count,sha256:installed.source_hash,catalog_id:installed.catalog_id}});
  for (const r of stored) {
    if (r.catalog_id!==installed.catalog_id || r.question_id!==`catalog:${installed.catalog_id}:${r.source_id}` || r.version!==installed.version ||
      r.normalized_text!==catalogKey(r.text) || r.origin!=='seed' || r.expires_at!==null || r.slot!==null ||
      r.state!==(r.eligible?'active':'retired') || !Number.isSafeInteger(r.answer_count) || r.answer_count<0 ||
      !Number.isSafeInteger(r.skip_count) || r.skip_count<0) fail();
  }
  return installed;
}
export function verifyCatalogForSchema(db: Database.Database) {
  if (hasCatalogUpdates(db)) verifyInstalledCatalog(db); else verifyCatalog19(db);
}
export function installCurrentCatalog(db: Database.Database) {
  const {rows,manifest:m}=readCurrentCatalog();
  db.prepare('INSERT INTO starter_catalog_install(catalog_id,version,source_hash,installed_count,revision) VALUES(?,?,?,?,?)').run(m.catalog_id,m.version,m.sha256,m.count,m.revision);
  const insert=db.prepare("INSERT INTO starter_questions(id,version,text,normalized_text,origin,state,created_at) VALUES(?,?,?,?,'seed','active',?)");
  const entry=db.prepare('INSERT INTO starter_catalog_entries(question_id,catalog_id,source_id,subject,activity) VALUES(?,?,?,?,?)');
  const now=new Date().toISOString();
  for(const r of rows){const id=`catalog:${m.catalog_id}:${r.id}`;insert.run(id,m.version,r.en,catalogKey(r.en),now);entry.run(id,m.catalog_id,r.id,r.subject,r.activity);}
  db.exec(`INSERT INTO starter_catalog_aliases SELECT old.id,c.question_id FROM starter_questions old
    JOIN starter_questions q ON q.normalized_text=old.normalized_text JOIN starter_catalog_entries c ON c.question_id=q.id
    WHERE old.id NOT IN (SELECT question_id FROM starter_catalog_entries)`);
  verifyInstalledCatalog(db);
}
/** Caller owns the startup transaction and has already made a verified backup. */
export function updateCatalog(db: Database.Database, target = readCurrentCatalog()) {
  validateCatalog(target); const installed=verifyInstalledCatalog(db,target.manifest.revision);
  if(installed.revision===target.manifest.revision) {if(installed.source_hash!==target.manifest.sha256) fail();return;}
  const old=db.prepare('SELECT source_id,subject,activity FROM starter_catalog_entries ORDER BY source_id').all() as any[];
  if(JSON.stringify(old.map(r=>[r.source_id,r.subject,r.activity]))!==JSON.stringify(target.rows.map(r=>[r.id,r.subject,r.activity]))) fail();
  const update=db.prepare('UPDATE starter_questions SET text=?,normalized_text=?,version=? WHERE id=?');
  for(const r of target.rows) update.run(r.en,catalogKey(r.en),target.manifest.version,`catalog:${installed.catalog_id}:${r.id}`);
  db.prepare('UPDATE starter_catalog_install SET revision=?,version=?,source_hash=?,installed_count=? WHERE catalog_id=?')
    .run(target.manifest.revision,target.manifest.version,target.manifest.sha256,target.rows.length,installed.catalog_id);
  verifyInstalledCatalog(db,target.manifest.revision);
}
/** Resolve lineage first, with exact text fallback only for unmapped legacy evidence. */
export function catalogIdentity(db: Database.Database, id: string | null | undefined, text?: string | null): string | undefined {
  if(id) {
    if(db.prepare('SELECT 1 FROM starter_catalog_entries WHERE question_id=?').get(id)) return id;
    if(hasCatalogUpdates(db)) {const alias=db.prepare('SELECT question_id FROM starter_catalog_aliases WHERE legacy_id=?').get(id) as {question_id:string}|undefined;if(alias)return alias.question_id;}
  }
  if(!text && id) text=(db.prepare('SELECT text FROM starter_questions WHERE id=?').get(id) as {text:string}|undefined)?.text;
  if(text)return (db.prepare('SELECT c.question_id FROM starter_catalog_entries c JOIN starter_questions q ON q.id=c.question_id WHERE q.normalized_text=?').get(catalogKey(text)) as {question_id:string}|undefined)?.question_id;
}
