// Explicit normal-data rehearsal/cutover; no provider calls or credentials.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, copyFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const mode = process.argv[2]; assert.ok(['prepare', 'cutover'].includes(mode));
const root = resolve('.'), require = createRequire(import.meta.url);
const base = process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : join(process.env.HOME, '.local/share');
const source = join(base, 'io.github.oukeidos.stomylos/stomylos.sqlite3');
const reportPath = 'test-results/time-normal-prepared.json';
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const hashes = () => Object.fromEntries([...walk('src'), ...walk('out'), ...walk('scripts'), ...walk('tests'), 'package.json', 'package-lock.json', 'README.md', 'native/advisory-lock.node', 'release/linux-unpacked/resources/app.asar'].map(f => [f, digest(f)]));
async function run(command, args, extra = {}, capture = false) {
  const child = spawn(command, args, { env: { ...process.env, ...extra }, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  let output = ''; if (capture) child.stdout.on('data', data => output += data);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  if (code !== 0) throw new Error('Acceptance command failed: ' + command + ' ' + args.join(' '));
  return output;
}
assert.ok(existsSync(source), 'Normal database must already exist');
if (mode === 'prepare') {
  for (const name of ['time-native-report', 'time-packaged-report', 'time-mixed-packaged-report', 'memory-packaged-report']) assert.equal(JSON.parse(readFileSync('test-results/' + name + '.json')).status, 'passed');
  const sourceHashes = hashes();
  const prepared = JSON.parse(await run(require('electron'), ['scripts/convert-time.mjs', source, '--prepare-only'], { ELECTRON_RUN_AS_NODE: '1' }, true));
  const staged = mkdtempSync('/tmp/stomylos-time-normal-copy-');
  copyFileSync(join(prepared.archive, 'verified-v6.sqlite3'), join(staged, 'stomylos.sqlite3'));
  await run('node', ['scripts/verify-memory-open.mjs', staged]);
  assert.equal(digest(source), prepared.source_sha256, 'Normal history changed during rehearsal');
  assert.deepEqual(hashes(), sourceHashes, 'Candidate changed during rehearsal');
  const rollback = '/tmp/stomylos-before-time-0.10.0.tar';
  assert.ok(existsSync(rollback), 'Preserved previous bundle required');
  copyFileSync(rollback, join(prepared.archive, 'before-0.10.0-bundle.tar'));
  const report = { status: 'prepared', source, prepared, staged, sourceHashes, rollback_sha256: digest(rollback), paidRequests: 0 };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  copyFileSync(reportPath, join(prepared.archive, 'copy-acceptance.json'));
  console.log(JSON.stringify({ status: report.status, archive: prepared.archive, staged, source_sha256: prepared.source_sha256 }));
} else {
  const prepared = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.source, source);
  assert.deepEqual(hashes(), prepared.sourceHashes, 'Candidate changed since copy acceptance');
  const result = JSON.parse(await run(require('electron'), ['scripts/convert-time.mjs', source, '--expected-source-sha256', prepared.prepared.source_sha256], { ELECTRON_RUN_AS_NODE: '1' }, true));
  const report = { status: 'converted', source, conversion: result, rehearsalArchive: prepared.prepared.archive, staged: prepared.staged, sourceHashes: prepared.sourceHashes, paidRequests: 0 };
  assert.equal(digest(source), result.target_sha256);
  writeFileSync('test-results/time-cutover-report.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  copyFileSync('test-results/time-cutover-report.json', join(result.archive, 'cutover-acceptance.json'));
  console.log(JSON.stringify({ status: report.status, archive: result.archive, preservedRows: Object.values(result.counts).reduce((a, b) => a + b, 0), paidRequests: 0 }));
}
