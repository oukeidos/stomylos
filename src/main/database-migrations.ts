import step30 from './migrations/030.sql?raw';
import source29 from './migrations/schema-v29.sql?raw';
import step29 from './migrations/029.sql?raw';
import source28 from './migrations/schema-v28.sql?raw';
import step28 from './migrations/028.sql?raw';
import source27 from './migrations/schema-v27.sql?raw';
import { migrate28Data } from './migrations/028-data';
import step27 from './migrations/027.sql?raw';
import source26 from './migrations/schema-v26.sql?raw';
import step26 from './migrations/026.sql?raw';
import source25 from './migrations/schema-v25.sql?raw';
import step25 from './migrations/025.sql?raw';
import step24 from './migrations/024.sql?raw';
import source23 from './migrations/schema-v23.sql?raw';
import { readCurrentCatalog, validateCatalog, updateCatalog, verifyInstalledCatalog, type Catalog } from './catalog-content';
import step23 from './migrations/023.sql?raw';
import step22 from './migrations/022.sql?raw';
import source21 from './migrations/schema-v21.sql?raw';
import { migrate22Data } from './migrations/022-data';
import { createHash } from 'node:crypto';
import { migrate14Data } from './migrations/014-data';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import source13 from './migrations/schema-v13.sql?raw';
import step14 from './migrations/014.sql?raw';
import step15 from './migrations/015.sql?raw';
import step16 from './migrations/016.sql?raw';
import step17 from './migrations/017.sql?raw';
import step18 from './migrations/018.sql?raw';
import source18 from './migrations/schema-v18.sql?raw';
import step19 from './migrations/019.sql?raw';
import { installCatalog19, verifyCatalog19 } from './migrations/019-data';
import source19 from './migrations/schema-v19.sql?raw';
import step20 from './migrations/020.sql?raw';
import step21 from './migrations/021.sql?raw';
import current from './schema.sql?raw';
import { AppFailure } from './errors';

// v0.1.0 ships schema 13. Keep published source schemas and steps immutable.
export const minimumPublicSchema = 13;
export const currentSchema = 30;
export function schemaSignature(db: Database.Database) {
  return db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    .map((r: any) => ({ ...r, sql: r.sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, '') }));
}
export function validateSchema(db: Database.Database, sql: string) {
  const expected = new Database(':memory:');
  try {
    expected.exec(sql);
    if (JSON.stringify(schemaSignature(expected)) !== JSON.stringify(schemaSignature(db))) throw new AppFailure('unsupported_schema_structure');
  } finally { expected.close(); }
}
function integrity(db: Database.Database) {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new AppFailure('migration_integrity_failed');
}
function dataFingerprint(db: Database.Database): string {
  const digest = createHash('sha256'), quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[];
  for (const {name} of tables) {
    const columns = (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as {name:string}[]).map(c=>quote(c.name));
    digest.update(name + '\n');
    for (const row of db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${columns.join(',')}`).iterate()) digest.update(JSON.stringify(row) + '\n');
  }
  return digest.digest('hex');
}
const steps = [{ from: 13, to: 14, sql: step14 }, { from: 14, to: 15, sql: step15 }, { from: 15, to: 16, sql: step16 }, { from: 16, to: 17, sql: step17 }, { from: 17, to: 18, sql: step18 }, { from: 18, to: 19, sql: step19 }, { from: 19, to: 20, sql: step20 }, { from: 20, to: 21, sql: step21 }, { from: 21, to: 22, sql: step22 }, { from: 22, to: 23, sql: step23 }, { from: 23, to: 24, sql: step24 }, { from: 24, to: 25, sql: step25 }, { from: 25, to: 26, sql: step26 }, { from: 26, to: 27, sql: step27 }, { from: 27, to: 28, sql: step28 }, { from: 28, to: 29, sql: step29 }, { from: 29, to: 30, sql: step30 }];
export function inspectMigration(db: Database.Database): number {
  const version = Number(db.pragma('user_version', { simple: true }));
  if (version < minimumPublicSchema || version > currentSchema) throw new AppFailure('unsupported_schema_version');
  validateSchema(db, version === 13 ? source13 : version < 19 ? source18 : version === 19 ? source19 : version < 22 ? source21 : version < 24 ? source23 : version < 26 ? source25 : version === 26 ? source26 : version === 27 ? source27 : version === 28 ? source28 : version === 29 ? source29 : current);
  integrity(db);
  return version;
}
/** Caller holds the application data lock; no normal recovery has run yet. */
export function migrateDatabase(db: Database.Database, directory: string, target: Catalog = readCurrentCatalog()) {
  validateCatalog(target);
  const version = inspectMigration(db);
  const installed = version >= 24 ? verifyInstalledCatalog(db, target.manifest.revision) : null;
  if (version === currentSchema && installed?.revision === target.manifest.revision) { updateCatalog(db, target); return; }
  if (version >= 19 && version < 24) verifyCatalog19(db);
  const backup = join(directory, version === currentSchema && installed
    ? `stomylos.pre-catalog-r${installed.revision}-${installed.source_hash}.sqlite3`
    : `stomylos.pre-migration-v${version}.sqlite3`);
  try {
    const stat = lstatSync(backup);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new AppFailure('migration_backup_invalid');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!existsSync(backup)) {
    try {
      // SQLite creates a consistent standalone snapshot even when source uses WAL.
      db.prepare('VACUUM INTO ?').run(backup);
      chmodSync(backup, 0o600);
    } catch (e) { if (existsSync(backup)) unlinkSync(backup); throw e; }
  }
  const recovery = new Database(backup, { readonly: true, fileMustExist: true });
  try { if (inspectMigration(recovery) !== version || dataFingerprint(recovery) !== dataFingerprint(db)) throw new AppFailure('migration_backup_invalid'); }
  finally { recovery.close(); }
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  db.transaction(() => {
    let next = version;
    for (const step of steps) {
      if (step.from < next) continue;
      if (step.from !== next) throw new AppFailure('migration_path_missing');
      db.exec(step.sql);
      if (step.to === 14) migrate14Data(db);
      if (step.to === 19) installCatalog19(db);
      if (step.to === 22) migrate22Data(db);
      if (step.to === 28) migrate28Data(db);
      db.pragma(`user_version = ${step.to}`);
      next = step.to;
    }
    if (next !== currentSchema) throw new AppFailure('migration_path_missing');
    updateCatalog(db, target);
    validateSchema(db, current); integrity(db); verifyInstalledCatalog(db, target.manifest.revision);
  }).immediate();
}
