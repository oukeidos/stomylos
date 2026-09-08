// Scoped memory verification and external v2-to-v3 cutover; never makes paid calls.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const external = '/tmp/stomylos-memory-conversion-20260905';
const stage = process.argv[2]; assert.ok(['verify', 'verify-ui', 'diagnose-lock', 'cutover'].includes(stage), 'Choose verify, verify-ui, diagnose-lock or cutover');
const env = { ...process.env, STOMYLOS_NODE_HEADERS: process.env.STOMYLOS_NODE_HEADERS || '/tmp/node-v24.13.0/include/node' };
for (const key of ['STOMYLOS_LIVE_DIR', 'STOMYLOS_STARTER_VERIFY_DIR', 'STOMYLOS_MEMORY_CONTINUITY_DIR', 'STOMYLOS_CONTINUITY_DIR']) delete env[key];
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(directory, e.name)) : [join(directory, e.name)]);
const sources = () => Object.fromEntries([...walk('src'), ...walk('out'), 'package.json', 'package-lock.json', 'release/linux-unpacked/resources/app.asar'].map(p => [p, digest(p)]));
async function run(command, args, extra = {}, capture = false) {
  const child = spawn(command, args, { env: { ...env, ...extra }, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  let output = ''; if (capture) child.stdout.on('data', data => output += data);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  if (code !== 0) throw new Error(command + ' failed with exit ' + code + (capture && output ? ': ' + output.trim() : ''));
  return output;
}
mkdirSync('test-results', { recursive: true });
if (stage === 'diagnose-lock') {
  const locks = JSON.parse(await run('lslocks', ['--json', '-o', 'PID,COMMAND,PATH'], {}, true));
  console.log(JSON.stringify((locks.locks ?? []).filter(lock => /stomylos|electron|python/i.test((lock.path ?? '') + ' ' + (lock.command ?? '')))));
} else if (stage === 'verify-ui') {
  await run('node', ['scripts/verify-memory.mjs', '--packaged']);
} else if (stage === 'verify') {
  await run('python3', ['-m', 'unittest', 'discover', '-s', external, '-p', 'test_*.py']);
  const fixture = (await run('python3', [external + '/prepare_fixture.py', resolve('.')], {}, true)).trim();
  await run('node', ['scripts/test.mjs', '--check', 'memory-continuity'], { STOMYLOS_MEMORY_CONTINUITY_DIR: fixture });
  await run('npm', ['run', 'test:all']);
  await run('npm', ['run', 'package']);
  await run('node', ['scripts/verify-memory.mjs']);
  await run('node', ['scripts/verify-memory.mjs', '--packaged']);
  await run('node', ['scripts/verify-package.mjs', '--source-launcher']);
  await run('node', ['scripts/verify-memory-open.mjs', join(fixture, 'converted')]);
  const report = { status: 'passed', at: new Date().toISOString(), sourceHashes: sources(), fixture,
    checks: ['External converter failure/lock tests', 'Every v2 row preserved in v3', 'Offline suite', 'Build and package', 'Native and packaged memory UI/restart/retry/skip', 'Actual source launcher', 'Converted-copy packaged reopen'], paidRequests: 0 };
  writeFileSync('test-results/memory-release-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} else {
  const verified = JSON.parse(readFileSync('test-results/memory-release-report.json', 'utf8'));
  assert.equal(verified.status, 'passed'); assert.deepEqual(sources(), verified.sourceHashes, 'Candidate changed since verification');
  const base = process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : join(process.env.HOME, '.local/share');
  const directory = join(base, 'io.github.oukeidos.stomylos');
  assert.ok(existsSync(join(directory, 'stomylos.sqlite3')), 'Existing normal database required for cutover');
  const prepared = JSON.parse(await run('python3', [external + '/convert.py', '--directory', directory, '--check-only'], {}, true));
  const staged = mkdtempSync('/tmp/stomylos-memory-normal-copy-');
  copyFileSync(join(prepared.archive, 'verified-v3.sqlite3'), join(staged, 'stomylos.sqlite3'));
  await run('node', ['scripts/verify-memory-open.mjs', staged]);
  assert.equal(digest(join(directory, 'stomylos.sqlite3')), prepared.source_sha256, 'Normal history changed during copy acceptance');
  const converted = JSON.parse(await run('python3', [external + '/convert.py', '--directory', directory, '--apply', '--expected-source-sha256', prepared.source_sha256], {}, true));
  const report = { status: 'converted', directory, stagedPackageCheck: staged, conversion: converted, sourceHashes: verified.sourceHashes, paidRequests: 0 };
  writeFileSync('test-results/memory-cutover-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify({ status: report.status, directory, archive: converted.archive, unchangedTableRows: converted.unchanged_table_rows }));
}
