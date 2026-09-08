import { createHash } from 'node:crypto';
import { migrate14Data } from './migrations/014-data';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import source13 from './migrations/schema-v13.sql?raw';
import step14 from './migrations/014.sql?raw';
import current from './schema.sql?raw';
import { AppFailure } from './errors';

// v0.1.0 ships schema 13. Keep published source schemas and steps immutable.
export const minimumPublicSchema = 13;
export const currentSchema = 14;
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
const steps = [{ from: 13, to: 14, sql: step14 }];
export function inspectMigration(db: Database.Database): number {
  const version = Number(db.pragma('user_version', { simple: true }));
  if (version < minimumPublicSchema || version > currentSchema) throw new AppFailure('unsupported_schema_version');
  validateSchema(db, version === 13 ? source13 : current);
  integrity(db);
  return version;
}
/** Caller holds the application data lock; no normal recovery has run yet. */
export function migrateDatabase(db: Database.Database, directory: string) {
  const version = inspectMigration(db);
  if (version === currentSchema) return;
  const backup = join(directory, `stomylos.pre-migration-v${version}.sqlite3`);
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
      db.pragma(`user_version = ${step.to}`);
      next = step.to;
    }
    if (next !== currentSchema) throw new AppFailure('migration_path_missing');
    validateSchema(db, current); integrity(db);
  }).immediate();
}
