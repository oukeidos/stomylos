// Run only for the accepted release, with permission to install and open normal history.
import { _electron as electron } from 'playwright-core';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { extractFile, listPackage } from '@electron/asar';
const exec = promisify(execFile);
const live = JSON.parse(readFileSync('test-results/starter-live-report.json', 'utf8'));
const audit = JSON.parse(readFileSync('test-results/release-audit.json', 'utf8'));
assert.equal(live.status, 'passed'); assert.equal(live.mock, false);
assert.equal(live.calls, 3); assert.equal(live.unrelatedCalls, 0); assert.equal(live.results.length, 3);
assert.ok(live.results.every(result => result.state === 'completed' && result.status === 'succeeded'));
assert.ok(live.knownCostUsd <= 1);
if (audit.version === '0.3.1') {
  // This patch reuses the unchanged starter endpoints' 0.3.0 live evidence;
  // the approved conversation budget and failure paths have a separate offline gate.
  assert.equal(live.appVersion, '0.3.0');
  const patch = JSON.parse(readFileSync('test-results/reply-recovery-report.json', 'utf8'));
  assert.equal(patch.status, 'passed'); assert.equal(patch.version, audit.version);
  assert.equal(patch.maxTokens, 8192); assert.equal(patch.realCalls, 0); assert.equal(patch.mockCalls, 3);
  assert.deepEqual(patch.errors, []);
  for (const file of ['src/main/contracts.ts', 'src/main/runtime-config.json', 'src/main/coordinator.ts', 'src/main/transport.ts', 'src/renderer/src.tsx']) {
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), patch.sourceHashes[file], `Patch source changed: ${file}`);
  }
  for (const file of ['src/main/starter-renewal.ts', 'src/main/starter-prompt.txt', 'src/main/starter-store.ts']) {
    const baseline = await exec('git', ['show', `4830e31:${file}`]);
    assert.equal(readFileSync(file, 'utf8'), baseline.stdout, `Starter baseline changed: ${file}`);
  }
  const packaged = resolve('release/linux-unpacked/resources/app.asar');
  for (const file of listPackage(packaged).filter(path => /^\/out\/.*\.(js|css|html)$/.test(path))) {
    assert.deepEqual(extractFile(packaged, file.slice(1)), readFileSync(file.slice(1)), `Packaged build differs: ${file}`);
  }
} else assert.equal(live.appVersion, audit.version);
assert.equal(createHash('sha256').update(readFileSync(audit.archive)).digest('hex'), audit.sha256);
const installation = join(homedir(), '.local/opt/stomylos', audit.version);
const manifest = join(installation, 'release-manifest.json');
if (existsSync(installation)) {
  assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).sha256, audit.sha256, 'Refusing to replace an existing different installation');
} else {
  mkdirSync(installation, { recursive: true });
  await exec('tar', ['-xzf', audit.archive, '--no-same-owner', '-C', installation]);
  writeFileSync(manifest, JSON.stringify({ version: audit.version, sha256: audit.sha256 }, null, 2));
}
const env = { ...process.env };
for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_DATA_DIR', 'STOMYLOS_TEST_ENDPOINT', 'STOMYLOS_LIVE_VERIFY']) delete env[name];
const dataBase = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), '.local/share');
const data = join(dataBase, 'io.github.oukeidos.stomylos');
const existing = existsSync(join(data, 'stomylos.sqlite3'));
const report = { status: 'checking', installation, archiveSha256: audit.sha256, data, existingHistory: existing, backup: null, continuity: null, pid: null };
let application;
try {
  application = await electron.launch({ executablePath: join(installation, 'stomylos'), env, chromiumSandbox: true, timeout: 20000 });
  const page = await application.firstWindow();
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  const snapshot = await page.evaluate(() => window.stomylos.command('snapshot'));
  assert.equal(snapshot.settings.dataPath, data); assert.equal(snapshot.settings.development, false);
  const launchedProcess = application.process(); const stopped = new Promise(resolve => launchedProcess.once('exit', resolve));
  await page.evaluate(() => window.stomylos.command('close')); await stopped; application = null;
  if (existing) {
    const backup = JSON.parse(readFileSync(join(data, `backups/electron-${audit.version}.json`), 'utf8'));
    const file = join(data, 'backups', backup.file);
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), backup.sha256);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    report.backup = file;
    const checked = await exec(join(installation, 'stomylos'), [resolve('scripts/verify-normal-data.mjs'), data, file, join(installation, 'resources/app.asar.unpacked/native/advisory-lock.node')], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
    report.continuity = JSON.parse(checked.stdout); assert.equal(report.continuity.status, 'passed');
  }
  await exec(join(installation, 'install-desktop.sh'), [], { env });
  const entry = readFileSync(join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), '.local/share'), 'applications/stomylos.desktop'), 'utf8');
  assert.ok(entry.includes(`Exec="${join(installation, 'run.sh')}"`));
  const child = spawn(join(installation, 'run.sh'), [], { env, detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  report.pid = child.pid; child.unref();
  const deadline = Date.now() + 20000;
  for (;;) {
    process.kill(child.pid, 0);
    const windows = await exec('wmctrl', ['-lp']);
    if (windows.stdout.split('\n').some(line => line.trim().split(/\s+/)[2] === String(child.pid))) break;
    if (Date.now() >= deadline) throw new Error('Installed process is still running but its window has not been observed; inspect this PID before retrying');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  report.status = 'passed'; console.log(JSON.stringify(report, null, 2));
} finally {
  await application?.close().catch(() => undefined);
  mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/cutover-report.json', JSON.stringify(report, null, 2));
}
