import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { exportBackup, prepareBackup, installBackup, recoverRestore } from '../src/main/backup';
import { lockDirectory } from '../src/main/storage';
import { validateCommand } from '../src/main/ipc';

let root: string, source: string, target: string;
const native = resolve('native/advisory-lock.node');
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'stomylos-backup-test-')); source = join(root, 'source'); target = join(root, 'target'); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function seed(directory: string, text: string) {
  const store = new Store(directory, native);
  try { const session = store.createSession(); store.saveDraft(session.id, text); return session.id; }
  finally { store.close(); }
}
function bytes(directory: string) { return readFileSync(join(directory, 'stomylos.sqlite3')); }
function manifestFile(file: string, change: (m: any, body: Buffer) => Buffer | void) {
  const data = gunzipSync(readFileSync(file)), offset = Buffer.byteLength('STOMYLOS_BACKUP_1\n');
  const length = data.readUInt32BE(offset), manifest = JSON.parse(data.subarray(offset + 4, offset + 4 + length).toString());
  const body = data.subarray(offset + 4 + length), modified = change(manifest, body) ?? body;
  const json = Buffer.from(JSON.stringify(manifest)), size = Buffer.alloc(4); size.writeUInt32BE(json.length);
  writeFileSync(file, gzipSync(Buffer.concat([data.subarray(0, offset), size, json, modified])));
}
async function archive() { seed(source, 'Backed up draft — exact text.'); const file = join(root, 'test.stomylos-backup'); await exportBackup(source, file, '0.22.0'); return file; }

it('round-trips byte-identical DB, audio, ASR and preferences while excluding keys, browser data and partial files', async () => {
  seed(source, 'Exact draft\nwith unicode 한글');
  const asset = join('speech', 'a'.repeat(64)), id = randomUUID();
  mkdirSync(join(source, asset), { recursive: true }); mkdirSync(join(source, 'asr'));
  writeFileSync(join(source, asset, 'manifest.json'), '{}'); writeFileSync(join(source, asset, `${id}.mp3`), Buffer.from([1, 2, 3]));
  writeFileSync(join(source, asset, `${randomUUID()}.part`), 'partial');
  writeFileSync(join(source, 'asr', `${id}.json`), '{}'); writeFileSync(join(source, 'preferences.json'), '{"version":2}');
  writeFileSync(join(source, 'api-credentials.json'), 'must-not-export'); mkdirSync(join(source, 'chromium')); writeFileSync(join(source, 'chromium', 'Preferences'), 'must-not-export');
  const original = bytes(source), file = join(root, 'backup.stomylos-backup');
  await exportBackup(source, file, '0.22.0'); expect(bytes(source)).toEqual(original);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const raw = gunzipSync(readFileSync(file)); expect(raw.includes(Buffer.from('must-not-export'))).toBe(false);
  seed(target, 'Newer local draft'); const old = bytes(target);
  writeFileSync(join(target, 'api-credentials.json'), 'keep-local-key'); mkdirSync(join(target, 'chromium')); writeFileSync(join(target, 'chromium', 'Preferences'), 'keep-ui');
  const prepared = await prepareBackup(target, file); expect(prepared.summary.conversations).toBe(1);
  const recovery = await installBackup(target, prepared.directory);
  expect(bytes(target)).toEqual(original); expect(bytes(join(recovery, 'previous'))).toEqual(old);
  expect(readFileSync(join(target, asset, `${id}.mp3`))).toEqual(Buffer.from([1, 2, 3]));
  expect(readFileSync(join(target, 'api-credentials.json'), 'utf8')).toBe('keep-local-key');
  expect(readFileSync(join(target, 'chromium', 'Preferences'), 'utf8')).toBe('keep-ui');
  expect(readdirSync(join(target, asset))).toHaveLength(2);
  expect(readFileSync(join(target, 'preferences.json'), 'utf8')).toBe('{"version":2}');
  expect(existsSync(join(target, 'backup-restore.json'))).toBe(false);
  const reopened = new Store(target, native); expect(reopened.unfinished()).not.toBeNull(); reopened.close();
}, 30_000);


it('refuses overwrite, live-directory destinations, symlinks and busy SQLite sidecars', async () => {
  const file = await archive(), saved = readFileSync(file);
  await expect(exportBackup(source, file, '0.22.0')).rejects.toThrow('backup_destination_exists'); expect(readFileSync(file)).toEqual(saved);
  await expect(exportBackup(source, join(source, 'bad.backup'), '0.22.0')).rejects.toThrow('backup_destination_invalid');
  symlinkSync(source, join(root, 'alias'));
  await expect(exportBackup(source, join(root, 'alias', 'bad.backup'), '0.22.0')).rejects.toThrow('backup_destination_invalid');
  symlinkSync(file, join(root, 'linked.backup')); await expect(prepareBackup(source, join(root, 'linked.backup'))).rejects.toThrow('backup_invalid');
  writeFileSync(join(source, 'stomylos.sqlite3-journal'), 'busy');
  await expect(exportBackup(source, join(root, 'busy.backup'), '0.22.0')).rejects.toThrow('backup_database_busy');
});

it.each(['checksum', 'truncated', 'traversal', 'duplicate', 'oversized', 'extra'])('rejects %s archives without touching live data or retaining extracted data', async mode => {
  const file = await archive(); seed(target, 'Keep this'); const original = bytes(target);
  if (mode === 'truncated') writeFileSync(file, readFileSync(file).subarray(0, 80));
  else manifestFile(file, (m, body) => {
    if (mode === 'checksum') m.files[0].sha256 = '0'.repeat(64);
    if (mode === 'traversal') m.files[0].path = '../outside';
    if (mode === 'duplicate') m.files.push(m.files[0]);
    if (mode === 'oversized') m.files[0].size = 3 * 1024 ** 3;
    if (mode === 'extra') return Buffer.concat([body, Buffer.from('trailing')]);
  });
  await expect(prepareBackup(target, file)).rejects.toThrow();
  expect(bytes(target)).toEqual(original); expect(readdirSync(target).some(n => n.startsWith('.backup-stage-'))).toBe(false);
});

it.each([12, 13, 15, 20, 21])('refuses a mislabeled schema v%i before installation', async version => {
  const file = await archive(); seed(target, 'Keep target');
  const changed = join(root, 'changed.sqlite3'); writeFileSync(changed, bytes(source));
  const db = new Database(changed); db.pragma(`user_version = ${version}`); db.close(); const replacement = readFileSync(changed);
  manifestFile(file, m => { m.files[0].size = replacement.length; m.files[0].sha256 = createHash('sha256').update(replacement).digest('hex'); return replacement; });
  await expect(prepareBackup(target, file)).rejects.toThrow(version === 12 ? 'external_migration_required' : 'unsupported_schema_structure');
});

it('rejects a changed prepared copy and preserves existing DB on pre-replacement failure', async () => {
  const file = await archive(); seed(target, 'Keep target'); const original = bytes(target);
  const prepared = await prepareBackup(target, file); writeFileSync(join(prepared.directory, 'stomylos.sqlite3'), 'changed');
  await expect(installBackup(target, prepared.directory)).rejects.toThrow('backup_source_changed');
  expect(bytes(target)).toEqual(original);
});

it.each(['prepared', 'saved:stomylos.sqlite3', 'installed:stomylos.sqlite3', 'installed:preferences.json', 'installed:asr'])('rolls back failure at %s including optional-file removal', async step => {
  const file = await archive(); seed(target, 'Keep local'); const original = bytes(target);
  writeFileSync(join(target, 'preferences.json'), 'previous preference');
  const prepared = await prepareBackup(target, file);
  await expect(installBackup(target, prepared.directory, current => { if (current === step) throw new Error('ENOSPC simulation'); })).rejects.toThrow('ENOSPC simulation');
  expect(bytes(target)).toEqual(original); expect(readFileSync(join(target, 'preferences.json'), 'utf8')).toBe('previous preference');
  await recoverRestore(target); expect(bytes(target)).toEqual(original);
});

it.each(['installed:stomylos.sqlite3', 'committed'])('recovers an actual terminated installer at %s before opening the database', async step => {
  const file = await archive(); seed(target, 'Keep local'); const original = bytes(target), replacement = bytes(source);
  const prepared = await prepareBackup(target, file), module = join(root, 'backup.cjs');
  await build({ entryPoints: ['src/main/backup.ts'], outfile: module, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], loader: { '.sql': 'text' }, logLevel: 'silent',
    plugins: [{ name: 'raw-json', setup(build) {
      build.onLoad({ filter: /\.json$/ }, args => args.suffix === '?raw' ? { contents: readFileSync(args.path, 'utf8'), loader: 'text' } : undefined);
    } }] });
  // esbuild's raw query resolves the SQL file with its text loader.
  const child = join(root, 'crash.cjs');
  writeFileSync(child, `const {installBackup}=require(${JSON.stringify(module)}); installBackup(process.argv[2],process.argv[3],s=>{if(s===process.argv[4])process.exit(77)}).catch(e=>{console.error(e);process.exit(1)});`);
  const result = spawnSync(process.execPath, [child, target, prepared.directory, step], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') }, encoding: 'utf8' });
  if (result.status !== 77) throw new Error(result.stderr || `Unexpected child status ${result.status}`); expect(result.status).toBe(77); expect(existsSync(join(target, 'backup-restore.json'))).toBe(true);
  await recoverRestore(target); await recoverRestore(target);
  expect(bytes(target)).toEqual(step === 'committed' ? replacement : original);
  if (step === 'committed') { const recovery = readdirSync(target).find(n => n.startsWith('restore-recovery-'))!; expect(bytes(join(target, recovery, 'previous'))).toEqual(original); }
});

it('keeps the shared directory lock when an externally locked Store closes for restore', () => {
  mkdirSync(source); const unlock = lockDirectory(source, native);
  try {
    const store = new Store(source, native, undefined, undefined, true); store.close();
    expect(() => new Store(source, native)).toThrow('database_already_open');
  } finally { unlock(); }
  const store = new Store(source, native); store.close();
});

it('exposes only argument-free backup IPC commands, never renderer-chosen paths', () => {
  for (const name of ['backupExport', 'backupRestore']) { expect(() => validateCommand(name, undefined)).not.toThrow(); expect(() => validateCommand(name, { path: '/tmp/anything' })).toThrow('invalid_command'); }
});

it('restores over a corrupt database without losing its exact bytes or sidecars', async () => {
  const file = await archive(); mkdirSync(target);
  writeFileSync(join(target, 'stomylos.sqlite3'), 'corrupt original');
  writeFileSync(join(target, 'stomylos.sqlite3-journal'), 'original journal');
  const prepared = await prepareBackup(target, file), recovery = await installBackup(target, prepared.directory);
  expect(bytes(target)).toEqual(bytes(source));
  expect(readFileSync(join(recovery, 'previous', 'stomylos.sqlite3'), 'utf8')).toBe('corrupt original');
  expect(readFileSync(join(recovery, 'previous', 'stomylos.sqlite3-journal'), 'utf8')).toBe('original journal');
  expect(existsSync(join(target, 'stomylos.sqlite3-journal'))).toBe(false);
});

it('removes interrupted staging on startup but retains committed recovery and unrelated folders', async () => {
  const file = await archive(); seed(target, 'Keep current');
  const prepared = await prepareBackup(target, file);
  const abandoned = join(target, `.restore-${randomUUID()}`), preserved = join(target, `restore-recovery-${randomUUID()}`), unrelated = join(target, '.restore-not-ours');
  for (const path of [abandoned, preserved, unrelated]) { mkdirSync(path); writeFileSync(join(path, 'keep'), 'test'); }
  const original = bytes(target); await recoverRestore(target);
  expect(existsSync(prepared.directory)).toBe(false); expect(existsSync(abandoned)).toBe(false);
  expect(existsSync(preserved)).toBe(true); expect(existsSync(unrelated)).toBe(true); expect(bytes(target)).toEqual(original);
});

it('rejects a same-version schema change and foreign-key corruption with valid file checksums', async () => {
  const original = await archive(); seed(target, 'Keep current'); const saved = bytes(target);
  for (const mode of ['schema', 'foreign-key']) {
    const file = join(root, `${mode}.backup`); writeFileSync(file, readFileSync(original));
    const dbFile = join(root, `${mode}.sqlite3`); writeFileSync(dbFile, bytes(source));
    const db = new Database(dbFile);
    if (mode === 'schema') db.exec('CREATE TABLE extra_table(id INTEGER)');
    else { db.pragma('foreign_keys = OFF'); db.prepare('INSERT INTO session_bookmarks(session_id) VALUES(?)').run('missing-session'); }
    db.close(); const replacement = readFileSync(dbFile);
    manifestFile(file, m => { m.files[0].size = replacement.length; m.files[0].sha256 = createHash('sha256').update(replacement).digest('hex'); return replacement; });
    await expect(prepareBackup(target, file)).rejects.toThrow(mode === 'schema' ? 'unsupported_schema_structure' : 'backup_database_invalid');
    expect(bytes(target)).toEqual(saved);
  }
});
