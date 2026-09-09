import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import raw from '../assets/starter-catalog-v1.json?raw';
import manifest from '../assets/starter-catalog-v1-manifest.json';
import { AppFailure } from '../errors';

// Frozen v19 content and normalization: future catalogs require a forward step.
export const catalogManifest = manifest;
export const catalogKey = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
export type CatalogRecord = { id: string; en: string; subject: string; activity: string };
export function readCatalog(payload = raw): CatalogRecord[] {
  const fail = () => { throw new AppFailure('starter_catalog_corrupt'); };
  if (createHash('sha256').update(payload).digest('hex') !== manifest.sha256) fail();
  const rows: CatalogRecord[] = JSON.parse(payload), ids = new Set(), texts = new Set();
  const cells: Record<string, number> = {};
  if (!Array.isArray(rows) || rows.length !== manifest.count) fail();
  for (const r of rows) {
    if (Object.keys(r).sort().join(',') !== 'activity,en,id,subject' || !/^Q\d{5}$/.test(r.id) ||
      typeof r.en !== 'string' || !r.en.trim() || /[\uac00-\ud7af]/u.test(r.en) || ids.has(r.id) || texts.has(catalogKey(r.en))) fail();
    ids.add(r.id); texts.add(catalogKey(r.en));
    const cell = `${r.subject}-${r.activity}`; cells[cell] = (cells[cell] ?? 0) + 1;
  }
  if (Object.keys(cells).length !== Object.keys(manifest.joint_cells).length ||
    Object.entries(manifest.joint_cells).some(([key, count]) => cells[key] !== count)) fail();
  return rows;
}
export function installCatalog19(db: Database.Database) {
  const rows = readCatalog();
  db.prepare('INSERT INTO starter_catalog_install VALUES(?,?,?,?)').run(manifest.catalog_id, manifest.version, manifest.sha256, rows.length);
  const history = new Map<string, Set<string>>();
  for (const e of db.prepare("SELECT session_id,text FROM starter_events WHERE kind='answered'").all() as {session_id:string;text:string}[]) {
    const key = catalogKey(e.text), sessions = history.get(key) ?? new Set<string>();
    sessions.add(e.session_id); history.set(key, sessions);
  }
  const insert = db.prepare("INSERT INTO starter_questions(id,version,text,normalized_text,origin,state,created_at) VALUES(?,?,?,?,'seed','active',?)");
  const entry = db.prepare('INSERT INTO starter_catalog_entries(question_id,catalog_id,source_id,subject,activity,answer_count) VALUES(?,?,?,?,?,?)');
  const time = new Date().toISOString();
  for (const r of rows) {
    const id = `catalog:${manifest.catalog_id}:${r.id}`, key = catalogKey(r.en);
    insert.run(id, manifest.version, r.en, key, time);
    entry.run(id, manifest.catalog_id, r.id, r.subject, r.activity, history.get(key)?.size ?? 0);
  }
  db.prepare("UPDATE starter_renewal_attempts SET status='interrupted',failure='feature_removed',finished_at=COALESCE(finished_at,?) WHERE job_id IN (SELECT id FROM starter_renewal_jobs WHERE state!='completed') AND status IN ('queued','dispatched','failed','interrupted')").run(time);
  db.exec("UPDATE starter_renewal_jobs SET state='failed' WHERE state!='completed'");
  db.exec("UPDATE starter_preparations SET state='released',reason='feature_removed' WHERE state='waiting'");
  db.exec("UPDATE end_stage_state SET automatic_retry_used=1 WHERE stage='starter'");
  verifyCatalog19(db);
}
export function verifyCatalog19(db: Database.Database) {
  const fail = () => { throw new AppFailure('starter_catalog_corrupt'); };
  const installed = db.prepare('SELECT * FROM starter_catalog_install').all() as any[];
  if (installed.length !== 1 || installed[0].catalog_id !== manifest.catalog_id || installed[0].version !== manifest.version ||
    installed[0].source_hash !== manifest.sha256 || installed[0].installed_count !== manifest.count) fail();
  const stored = db.prepare(`SELECT c.*,q.text,q.version,q.normalized_text,q.state,q.origin,q.expires_at,
    (SELECT slot FROM starter_slots WHERE question_id=q.id) slot FROM starter_catalog_entries c JOIN starter_questions q ON q.id=c.question_id`).all() as any[];
  const expected = new Map(readCatalog().map(r => [r.id, r]));
  if (stored.length !== expected.size) fail();
  for (const r of stored) {
    const source = expected.get(r.source_id);
    if (!source || r.catalog_id !== manifest.catalog_id || r.question_id !== `catalog:${manifest.catalog_id}:${r.source_id}` ||
      r.text !== source.en || r.subject !== source.subject || r.activity !== source.activity || r.version !== manifest.version ||
      r.normalized_text !== catalogKey(source.en) || r.origin !== 'seed' || r.expires_at !== null || r.slot !== null ||
      r.state !== (r.eligible ? 'active' : 'retired') || !Number.isSafeInteger(r.answer_count) || r.answer_count < 0 ||
      !Number.isSafeInteger(r.skip_count) || r.skip_count < 0) fail();
  }
}
