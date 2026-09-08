import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, chmod, mkdir, open, readdir, readFile, rename, rm, stat, unlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import schema from './schema.sql?raw';
import { StarterStore } from './starter-store';
import { MemoryStore } from './memory-store';
import { atomicFile } from './speech-store';
import { AppFailure } from './errors';
import type { BackupSummary } from '../shared/backup';

// A gzip stream containing a bounded JSON manifest followed by exact-length file
// bodies. No archive entry can create a directory link, device, or executable.
const magic = Buffer.from('STOMYLOS_BACKUP_1\n');
const maxBytes = 2 * 1024 ** 3, maxManifest = 8 * 1024 ** 2, maxFiles = 100_000;
// usage.sqlite3 is device-local accounting: exporting/restoring chat history must not rewind or transfer it.
const roots = ['stomylos.sqlite3', 'preferences.json', 'speech', 'asr'];
const replaceRoots = [...roots, 'stomylos.sqlite3-journal', 'stomylos.sqlite3-wal', 'stomylos.sqlite3-shm'];
const marker = 'backup-restore.json';
interface Entry { path: string; size: number; sha256: string }
interface Manifest { format: 1; appVersion: string; schemaVersion: number; createdAt: string; files: Entry[] }
interface Journal { version: 1; id: string; state: 'prepared' | 'committed'; present: string[] }
export interface PreparedBackup { directory: string; summary: BackupSummary }
const fail = (code = 'backup_invalid'): never => { throw new AppFailure(code); };
const exists = async (file: string) => { try { await lstat(file); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } };
async function syncDirectory(directory: string) { const fd = await open(directory, 'r'); try { await fd.sync(); } finally { await fd.close(); } }
function allowed(file: string) {
  return file === 'stomylos.sqlite3' || file === 'preferences.json' ||
    /^asr\/[a-f0-9-]{36}\.json$/.test(file) ||
    /^speech\/(?:preview-)?[a-f0-9]{64}\/(?:manifest\.json|[a-f0-9-]{36}\.mp3)$/.test(file);
}
async function regular(file: string) { const s = await lstat(file); if (!s.isFile() || s.isSymbolicLink()) fail(); return s; }
const signature = (db: Database.Database) => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
  .map((r: any) => ({ ...r, sql: r.sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, '') }));
export function inspectBackupDatabase(file: string): number {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const version = db.pragma('user_version', { simple: true });
    if (typeof version === 'number' && version >= 1 && version < 13) fail('external_migration_required');
    if (version !== 13) fail('unsupported_schema_version');
    const expected = new Database(':memory:');
    try { expected.exec(schema); if (JSON.stringify(signature(db)) !== JSON.stringify(signature(expected))) fail('unsupported_schema_structure'); }
    finally { expected.close(); }
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) fail('backup_database_invalid');
    new StarterStore(db).verify(); new MemoryStore(db).load();
    return (db.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n;
  } finally { db.close(); }
}
async function inventory(directory: string): Promise<Entry[]> {
  const files: Entry[] = []; let total = 0;
  async function visit(relative: string) {
    const file = join(directory, relative), s = await lstat(file);
    if (s.isSymbolicLink()) fail();
    if (s.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(`${relative}/${name}`);
    } else {
      // Incomplete cache writes are never part of a restorable snapshot.
      if (relative.endsWith('.part') || relative.endsWith('.tmp')) return;
      if (!allowed(relative) || !s.isFile()) fail();
      total += s.size; if (total > maxBytes || files.length >= maxFiles) fail('backup_too_large');
      const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
      files.push({ path: relative, size: s.size, sha256: hash.digest('hex') });
    }
  }
  for (const root of roots) if (await exists(join(directory, root))) await visit(root);
  if (!files.some(f => f.path === roots[0])) fail();
  return files;
}
function validateManifest(value: any): asserts value is Manifest {
  if (!value || value.format !== 1 || typeof value.appVersion !== 'string' || value.appVersion.length > 100 ||
      !Number.isSafeInteger(value.schemaVersion) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > maxFiles) fail();
  if (value.schemaVersion >= 1 && value.schemaVersion < 13) fail('external_migration_required');
  if (value.schemaVersion !== 13) fail('unsupported_schema_version');
  let total = 0; const names = new Set();
  for (const f of value.files) {
    if (!f || typeof f.path !== 'string' || !allowed(f.path) || names.has(f.path) || !Number.isSafeInteger(f.size) || f.size < 0 ||
        typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) fail();
    names.add(f.path); total += f.size; if (total > maxBytes) fail('backup_too_large');
  }
  if (!names.has('stomylos.sqlite3')) fail();
}
export async function exportBackup(directory: string, destination: string, appVersion: string) {
  const target = resolve(destination), parent = await realpath(dirname(target)), data = await realpath(directory);
  if (parent === data || parent.startsWith(data + sep)) fail('backup_destination_invalid');
  if (await exists(target)) fail('backup_destination_exists');
  for (const sidecar of replaceRoots.slice(4)) if (await exists(join(directory, sidecar))) fail('backup_database_busy');
  const count = inspectBackupDatabase(join(directory, roots[0]));
  const manifest: Manifest = { format: 1, appVersion, schemaVersion: 13, createdAt: new Date().toISOString(), files: await inventory(directory) };
  const json = Buffer.from(JSON.stringify(manifest)); if (json.length > maxManifest) fail('backup_too_large');
  const size = Buffer.alloc(4); size.writeUInt32BE(json.length);
  const temporary = join(parent, `.stomylos-backup-${randomUUID()}.tmp`);
  async function* content() {
    yield magic; yield size; yield json;
    for (const entry of manifest.files) {
      const hash = createHash('sha256'); let length = 0;
      for await (const chunk of createReadStream(join(directory, entry.path))) { hash.update(chunk); length += chunk.length; yield chunk; }
      if (length !== entry.size || hash.digest('hex') !== entry.sha256) fail('backup_source_changed');
    }
  }
  try {
    await pipeline(Readable.from(content()), createGzip(), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    const fd = await open(temporary, 'r'); try { await fd.sync(); } finally { await fd.close(); }
    // Re-read the completed compressed file, including its gzip checksum and DB.
    const checked = await prepareBackup(directory, temporary);
    await rm(checked.directory, { recursive: true });
    // Exclusive link prevents replacing a file created since the save dialog.
    const { link } = await import('node:fs/promises'); await link(temporary, target); await syncDirectory(parent);
    return { path: target, createdAt: manifest.createdAt, appVersion, schemaVersion: 13, conversations: count };
  } finally { await unlink(temporary).catch(() => undefined); }
}
export async function prepareBackup(directory: string, source: string): Promise<PreparedBackup> {
  if ((await regular(source)).size > maxBytes) fail('backup_too_large');
  const stage = join(directory, `.backup-stage-${randomUUID()}`); await mkdir(stage, { mode: 0o700 });
  const input = createReadStream(source), gunzip = createGunzip();
  const pumping = pipeline(input, gunzip); void pumping.catch(() => undefined);
  const iterator = gunzip[Symbol.asyncIterator](); let buffer: Buffer = Buffer.alloc(0);
  async function take(n: number) {
    const pieces: Buffer[] = []; let left = n;
    while (left) {
      if (!buffer.length) { const next = await iterator.next(); if (next.done) fail(); buffer = Buffer.from(next.value); }
      const length = Math.min(left, buffer.length); pieces.push(buffer.subarray(0, length)); buffer = buffer.subarray(length); left -= length;
    }
    return Buffer.concat(pieces, n);
  }
  try {
    if (!(await take(magic.length)).equals(magic)) fail();
    const length = (await take(4)).readUInt32BE(); if (!length || length > maxManifest) fail();
    const manifest: unknown = JSON.parse((await take(length)).toString('utf8')); validateManifest(manifest);
    for (const entry of manifest.files) {
      const file = join(stage, entry.path); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const fd = await open(file, 'wx', 0o600), hash = createHash('sha256');
      try {
        let left = entry.size;
        while (left) { const chunk = await take(Math.min(left, 64 * 1024)); hash.update(chunk); await fd.writeFile(chunk); left -= chunk.length; }
        await fd.sync();
      } finally { await fd.close(); }
      if (hash.digest('hex') !== entry.sha256) fail('backup_checksum_mismatch');
    }
    if (buffer.length || !(await iterator.next()).done) fail(); await pumping;
    const conversations = inspectBackupDatabase(join(stage, roots[0]));
    await atomicFile(join(stage, 'manifest.json'), JSON.stringify(manifest));
    for (const root of ['speech', 'asr']) if (await exists(join(stage, root))) {
      if (root === 'speech') for (const name of await readdir(join(stage, root))) await syncDirectory(join(stage, root, name));
      await syncDirectory(join(stage, root));
    }
    await syncDirectory(stage); await syncDirectory(directory);
    return { directory: stage, summary: { createdAt: manifest.createdAt, appVersion: manifest.appVersion, schemaVersion: 13, conversations } };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  finally { input.destroy(); gunzip.destroy(); await pumping.catch(() => undefined); }
}
async function verifyStage(stage: string) {
  const manifest: unknown = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8')); validateManifest(manifest);
  if (JSON.stringify(await inventory(stage)) !== JSON.stringify(manifest.files)) fail('backup_source_changed');
  inspectBackupDatabase(join(stage, roots[0]));
}
async function finishCommitted(directory: string, journal: Journal) {
  const stage = join(directory, `.restore-${journal.id}`), recovery = join(directory, `restore-recovery-${journal.id}`);
  if (await exists(stage)) { await rename(stage, recovery); await syncDirectory(directory); }
  await unlink(join(directory, marker)); await syncDirectory(directory);
  await rm(join(recovery, 'safety'), { recursive: true, force: true }).catch(() => undefined);
  return recovery;
}
export async function recoverRestore(directory: string) {
  const file = join(directory, marker);
  if (!await exists(file)) {
    // Called under the application lock at startup. These reserved names are
    // disposable extraction/pre-journal work; committed recovery has another name.
    for (const name of await readdir(directory)) if (/^\.(?:backup-stage|restore)-[a-f0-9-]{36}$/.test(name)) {
      const path = join(directory, name), s = await lstat(path);
      if (s.isDirectory() && !s.isSymbolicLink()) await rm(path, { recursive: true });
    }
    return;
  }
  await regular(file); if ((await stat(file)).size > 4096) fail('backup_recovery_required');
  const journal: Journal = JSON.parse(await readFile(file, 'utf8'));
  if (journal.version !== 1 || !/^[a-f0-9-]{36}$/.test(journal.id) || !['prepared', 'committed'].includes(journal.state) ||
      !Array.isArray(journal.present) || journal.present.some(p => !replaceRoots.includes(p)) || new Set(journal.present).size !== journal.present.length) fail('backup_recovery_required');
  if (journal.state === 'committed') return finishCommitted(directory, journal);
  const previous = join(directory, `.restore-${journal.id}`, 'previous');
  if (!(await lstat(previous)).isDirectory()) fail('backup_recovery_required');
  for (const root of replaceRoots) {
    const old = join(previous, root), live = join(directory, root);
    if (await exists(old)) {
      await rm(live, { recursive: true, force: true }); await rename(old, live);
      await syncDirectory(previous); await syncDirectory(directory);
    } else if (!journal.present.includes(root)) { await rm(live, { recursive: true, force: true }); await syncDirectory(directory); }
  }
  await unlink(file); await syncDirectory(directory);
  await rm(join(directory, `.restore-${journal.id}`), { recursive: true, force: true });
}
// Caller holds the same data-directory lock used by the DB for this entire
// operation, and closes all DB/file writers before entry.
export async function installBackup(directory: string, prepared: string, checkpoint: (step: string) => void = () => undefined) {
  if (dirname(prepared) !== directory || !/^\.backup-stage-[a-f0-9-]{36}$/.test(prepared.slice(directory.length + 1))) fail();
  await verifyStage(prepared);
  if (await exists(join(directory, marker))) fail('backup_recovery_required');
  const id = randomUUID(), stage = join(directory, `.restore-${id}`), previous = join(stage, 'previous');
  await mkdir(stage, { mode: 0o700 }); await mkdir(previous, { mode: 0o700 });
  try {
  const present: string[] = [];
  for (const root of replaceRoots) if (await exists(join(directory, root))) {
    const s = await lstat(join(directory, root)); if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) fail(); present.push(root);
  }
  // Verify and durably copy the previous files before changing any live path.
  const { cp } = await import('node:fs/promises');
  await mkdir(join(stage, 'safety'), { mode: 0o700 });
  for (const root of present) await cp(join(directory, root), join(stage, 'safety', root), { recursive: true, dereference: false });
  async function syncTree(path: string): Promise<void> {
    const s = await lstat(path); if (s.isSymbolicLink()) fail();
    if (s.isDirectory()) { await chmod(path, 0o700); for (const child of await readdir(path)) await syncTree(join(path, child)); await syncDirectory(path); }
    else { await chmod(path, 0o600); const fd = await open(path, 'r'); try { await fd.sync(); } finally { await fd.close(); } }
  }
  async function hashes(path: string): Promise<string[]> {
    const result: string[] = [];
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name), s = await lstat(file); if (s.isSymbolicLink()) fail();
      if (s.isDirectory()) result.push(...(await hashes(file)).map(v => `${name}/${v}`));
      else { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); result.push(`${name}:${h.digest('hex')}`); }
    }
    return result;
  }
  // Each supported root is compared separately; credentials and Chromium never
  // enter the safety copy. This also preserves corrupt DB bytes on startup repair.
  for (const root of present) {
    const live = join(directory, root), copy = join(stage, 'safety', root);
    if ((await lstat(live)).isDirectory()) { if (JSON.stringify(await hashes(live)) !== JSON.stringify(await hashes(copy))) fail('backup_source_changed'); }
    else { const digest = async (p: string) => { const h = createHash('sha256'); for await (const b of createReadStream(p)) h.update(b); return h.digest('hex'); }; if (await digest(live) !== await digest(copy)) fail('backup_source_changed'); }
  }
  await syncTree(join(stage, 'safety'));
  await rename(prepared, join(stage, 'incoming')); await syncDirectory(stage); await syncDirectory(directory);
  const journal: Journal = { version: 1, id, state: 'prepared', present };
  await atomicFile(join(directory, marker), JSON.stringify(journal));
  try {
    checkpoint('prepared');
    for (const root of replaceRoots) {
      if (present.includes(root)) { await rename(join(directory, root), join(previous, root)); await syncDirectory(previous); await syncDirectory(directory); }
      checkpoint(`saved:${root}`);
      const incoming = join(stage, 'incoming', root);
      if (await exists(incoming)) { await rename(incoming, join(directory, root)); await syncDirectory(join(stage, 'incoming')); await syncDirectory(directory); }
      checkpoint(`installed:${root}`);
    }
    inspectBackupDatabase(join(directory, roots[0]));
    journal.state = 'committed'; await atomicFile(join(directory, marker), JSON.stringify(journal)); checkpoint('committed');
    return await finishCommitted(directory, journal);
  } catch (error) { await recoverRestore(directory); throw error; }
  } finally {
    if (!await exists(join(directory, marker))) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}
