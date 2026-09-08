// Standalone, explicitly invoked v7 -> v8 conversion. Never imported by the app.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { openSync, closeSync, constants, copyFileSync, readFileSync, writeFileSync, writeSync, mkdirSync, existsSync, lstatSync, chmodSync, fsyncSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
// Archived copies use their frozen schemas and an explicitly supplied dependency runtime.
const root = process.env.STOMYLOS_CONVERTER_RUNTIME ?? resolve(scriptDirectory, '..');
const require = createRequire(join(root, 'package.json')), Database = require('better-sqlite3');
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const canonical = value => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? { integer: v.toString() } : v);
const quote = name => '"' + name.replaceAll('"', '""') + '"';
export function signature(db) {
  return db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    .map(row => ({ ...row, sql: row.sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, '') }));
}
function rows(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  return Object.fromEntries(names.map(name => [name, db.prepare('SELECT rowid,* FROM ' + quote(name) + ' ORDER BY rowid').raw().safeIntegers().all()]));
}
function check(db, expected, version) {
  if (db.pragma('user_version', { simple: true }) !== version || canonical(signature(db)) !== canonical(signature(expected))) throw new Error('incompatible_schema');
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) throw new Error('invalid_integrity');
}
function sync(file) { const fd = openSync(file, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function convertSearch(file, options = {}) {
  if (!isAbsolute(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('invalid_source_path');
  const directory = dirname(file), native = options.nativePath ?? join(root, 'native/advisory-lock.node');
  const lock = openSync(join(directory, 'stomylos.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let source, target, expectedOld, expectedNew, manifest, archive;
  try {
    require(native).lock(lock);
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(file + suffix) && lstatSync(file + suffix).size) throw new Error('unclean_sidecar');
    const frozen = existsSync(join(scriptDirectory, 'schema-v7.sql'));
    const oldSchema = readFileSync(frozen ? join(scriptDirectory, 'schema-v7.sql') : join(root, 'tests/fixtures/schema-v7-before-search.sql'), 'utf8');
    const newSchema = readFileSync(frozen ? join(scriptDirectory, 'schema-v8.sql') : join(root, 'tests/fixtures/schema-v8-before-shared-memory.sql'), 'utf8');
    if (!newSchema.startsWith(oldSchema)) throw new Error('schema_not_append_only');
    expectedOld = new Database(':memory:'); expectedOld.exec(oldSchema);
    expectedNew = new Database(':memory:'); expectedNew.exec(newSchema);
    const originalHash = digest(file), originalStat = lstatSync(file);
    if (options.expectedSourceHash && originalHash !== options.expectedSourceHash) throw new Error('source_changed_since_acceptance');
    source = new Database(file, { readonly: true, fileMustExist: true }); check(source, expectedOld, 7);
    if (source.pragma('journal_mode', { simple: true }) !== 'delete') throw new Error('unexpected_journal_mode');
    const originalRows = rows(source); source.close(); source = null;
    const backups = join(directory, 'backups');
    if (existsSync(backups) && lstatSync(backups).isSymbolicLink()) throw new Error('invalid_backup_path');
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    archive = join(backups, 'search-v8-' + randomUUID()); mkdirSync(archive, { mode: 0o700 });
    const backup = join(archive, 'before-v7.sqlite3'), converted = join(archive, 'verified-v8.sqlite3');
    copyFileSync(file, backup, constants.COPYFILE_EXCL); chmodSync(backup, 0o600); sync(backup);
    if (digest(backup) !== originalHash || digest(file) !== originalHash) throw new Error('source_changed');
    copyFileSync(backup, converted, constants.COPYFILE_EXCL); chmodSync(converted, 0o600);
    target = new Database(converted); target.pragma('foreign_keys=ON'); target.pragma('synchronous=FULL');
    target.transaction(() => { target.exec(newSchema.slice(oldSchema.length)); target.pragma('user_version=8'); })();
    check(target, expectedNew, 8);
    const convertedRows = rows(target);
    for (const [name, before] of Object.entries(originalRows)) if (canonical(before) !== canonical(name === 'sessions' ? convertedRows[name].map(row => row.slice(0, -1)) : convertedRows[name])) throw new Error('original_rows_changed:' + name);
    for (const name of ['search_turns', 'search_router_attempts', 'chat_search_context']) if (convertedRows[name].length) throw new Error('unexpected_backfill');
    if (target.prepare("SELECT COUNT(*) AS n FROM sessions WHERE search_mode!='off'").get().n) throw new Error('invalid_search_default');
    target.close(); target = null; sync(converted);
    writeFileSync(join(archive, 'schema-v7.sql'), oldSchema, { mode: 0o600, flag: 'wx', flush: true });
    writeFileSync(join(archive, 'schema-v8.sql'), newSchema, { mode: 0o600, flag: 'wx', flush: true });
    copyFileSync(fileURLToPath(import.meta.url), join(archive, 'convert-search.mjs'), constants.COPYFILE_EXCL);
    manifest = { status: 'prepared', source_version: 7, target_version: 8, source: file, archive,
      source_sha256: originalHash, target_sha256: digest(converted),
      counts: Object.fromEntries(Object.entries(originalRows).map(([name, data]) => [name, data.length])),
      schemas: { v7: digest(join(archive, 'schema-v7.sql')), v8: digest(join(archive, 'schema-v8.sql')) } };
    writeFileSync(join(archive, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx', flush: true }); sync(archive);
    if (options.prepareOnly) return manifest;
    options.beforeReplace?.();
    const current = lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== originalStat.dev || current.ino !== originalStat.ino || digest(file) !== originalHash) throw new Error('source_changed');
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(file + suffix) && lstatSync(file + suffix).size) throw new Error('unclean_sidecar');
    const staged = join(directory, '.search-v8-' + randomUUID() + '.sqlite3');
    copyFileSync(converted, staged, constants.COPYFILE_EXCL); chmodSync(staged, 0o600); sync(staged);
    (options.replace ?? renameSync)(staged, file); sync(directory);
    manifest.status = 'converted';
    writeFileSync(join(archive, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flush: true }); sync(archive);
    return manifest;
  } finally {
    source?.close(); target?.close(); expectedOld?.close(); expectedNew?.close(); closeSync(lock);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const args = process.argv.slice(3), options = {};
  while (args.length) {
    const flag = args.shift();
    if (flag === '--prepare-only') options.prepareOnly = true;
    else if (flag === '--expected-source-sha256' && /^[a-f0-9]{64}$/.test(args[0] ?? '')) options.expectedSourceHash = args.shift();
    else throw new Error('Unknown or incomplete converter option');
  }
  if (!file) throw new Error('Usage: ELECTRON_RUN_AS_NODE=1 electron scripts/convert-search.mjs /absolute/path/stomylos.sqlite3 [--prepare-only] [--expected-source-sha256 HASH]');
  writeSync(1, JSON.stringify(convertSearch(file, options), null, 2) + '\n');
}
