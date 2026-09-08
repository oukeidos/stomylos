// Scoped release acceptance and external v3/v4-to-v5 cutover; no paid model calls.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const external = '/tmp/stomylos-opening-conversion-20260905';
const stage = process.argv[2]; assert.ok(['verify', 'cutover'].includes(stage), 'Choose verify or cutover');
const env = { ...process.env, STOMYLOS_NODE_HEADERS: process.env.STOMYLOS_NODE_HEADERS || '/tmp/node-v24.13.0/include/node' };
for (const key of ['STOMYLOS_LIVE_DIR', 'STOMYLOS_STARTER_VERIFY_DIR', 'STOMYLOS_MEMORY_CONTINUITY_DIR', 'STOMYLOS_CONTINUITY_DIR', 'STOMYLOS_OPENING_CONVERTER']) delete env[key];
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(directory, e.name)) : [join(directory, e.name)]);
const sources = () => Object.fromEntries([...walk('src'), ...walk('out'), ...walk('scripts'), ...walk('tests'), 'vitest.config.ts', 'README.md', 'package.json', 'package-lock.json', 'native/advisory-lock.node', 'release/linux-unpacked/resources/app.asar', ...['convert.py', 'schema-v3.sql', 'schema-v4.sql', 'schema-v5.sql', 'test_convert.py', 'freeze_source.py'].map(n => join(external, n))].map(p => [p, digest(p)]));
async function run(command, args, extra = {}, capture = false) {
  console.log(JSON.stringify({ stage: [command, ...args], at: new Date().toISOString() }));
  const child = spawn(command, args, { env: { ...env, ...extra }, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  let output = ''; if (capture) child.stdout.on('data', data => output += data);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  if (code !== 0) throw new Error(command + ' failed with exit ' + code + (capture ? ': ' + output.trim() : ''));
  return output;
}
mkdirSync('test-results', { recursive: true });
if (stage === 'verify') {
  await run('python3', ['-m', 'unittest', 'discover', '-s', external, '-p', 'test_*.py']);
  await run('node', ['scripts/test.mjs', '--check', 'opening-continuity'], { STOMYLOS_OPENING_CONVERTER: external });
  await run('npm', ['run', 'test:all']);
  await run('npm', ['run', 'package']);
  await run('node', ['scripts/verify-opening.mjs', '--packaged']);
  await run('node', ['scripts/verify-asr.mjs', '--packaged']);
  await run('node', ['scripts/verify-deletion.mjs', '--packaged']);
  await run('node', ['scripts/verify-package.mjs', '--source-launcher']);
  const continuity = JSON.parse(readFileSync('test-results/opening-continuity.json', 'utf8'));
  assert.equal(continuity.status, 'passed'); assert.equal(continuity.fixtures.length, 4);
  for (const fixture of continuity.fixtures) await run('node', ['scripts/verify-memory-open.mjs', fixture]);
  const report = { status: 'passed', at: new Date().toISOString(), sourceHashes: sources(), continuity,
    checks: ['External v3/v4 conversion and source preservation', 'Legacy draft/active/ended/interrupted requests and pending/failed/blocked jobs with explicit retries', 'Complete offline suite', 'Build and package', 'Packaged dual entry/text/voice/TTS/IME/restart', 'Packaged ASR regression', 'Packaged deletion regression', 'Actual source launcher', 'Four converted fixture copies opened twice without credentials'], paidRequests: 0 };
  writeFileSync('test-results/opening-release-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: 'passed', report: 'test-results/opening-release-report.json' }));
} else {
  const verified = JSON.parse(readFileSync('test-results/opening-release-report.json', 'utf8'));
  assert.equal(verified.status, 'passed'); assert.deepEqual(sources(), verified.sourceHashes, 'Candidate changed since verification');
  const base = process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : join(process.env.HOME, '.local/share');
  const directory = join(base, 'io.github.oukeidos.stomylos');
  assert.ok(existsSync(join(directory, 'stomylos.sqlite3')), 'Existing normal database required');
  const prepared = JSON.parse(await run('python3', [external + '/convert.py', '--directory', directory, '--check-only'], {}, true));
  const staged = mkdtempSync('/tmp/stomylos-opening-normal-copy-');
  copyFileSync(join(prepared.archive, 'verified-v5.sqlite3'), join(staged, 'stomylos.sqlite3'));
  await run('node', ['scripts/verify-memory-open.mjs', staged]);
  assert.equal(digest(join(directory, 'stomylos.sqlite3')), prepared.source_sha256, 'Normal history changed during acceptance');
  assert.deepEqual(sources(), verified.sourceHashes, 'Candidate changed during acceptance');
  const converted = JSON.parse(await run('python3', [external + '/convert.py', '--directory', directory, '--apply', '--expected-source-sha256', prepared.source_sha256], {}, true));
  const report = { status: 'converted', directory, stagedPackageCheck: staged, conversion: converted, sourceHashes: verified.sourceHashes, paidRequests: 0 };
  writeFileSync('test-results/opening-cutover-report.json', JSON.stringify(report, null, 2));
  copyFileSync('test-results/opening-release-report.json', join(converted.archive, 'release-acceptance.json'));
  copyFileSync('test-results/opening-cutover-report.json', join(converted.archive, 'cutover-acceptance.json'));
  console.log(JSON.stringify({ status: report.status, directory, archive: converted.archive, unchangedTableRows: converted.unchanged_table_rows }));
}
