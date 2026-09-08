// Open a copy of an externally converted public fixture with the packaged app.
import { _electron as electron } from 'playwright-core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const source = process.argv[2]; if (!source) throw new Error('Supply an externally converted public fixture directory');
const root = mkdtempSync(join(tmpdir(), 'stomylos-converted-package-'));
const directory = join(root, 'data/io.github.oukeidos.stomylos'); mkdirSync(directory, { recursive: true });
const original = resolve(source, 'stomylos.sqlite3'); copyFileSync(original, join(directory, 'stomylos.sqlite3'));
const env = { ...process.env, HOME: join(root, 'home'), XDG_DATA_HOME: join(root, 'data') }; mkdirSync(env.HOME);
for (const key of ['STOMYLOS_DATA_DIR', 'STOMYLOS_TEST_ENDPOINT', 'STOMYLOS_LIVE_VERIFY', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key];
const executablePath = resolve('release/linux-unpacked/stomylos'); let app;
const report = { status: 'running', directory, original, checks: [] };
async function launch() {
  app = await electron.launch({ executablePath, env, chromiumSandbox: true });
  const page = await app.firstWindow(); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor(); return page;
}
async function close(page) {
  const stopped = new Promise(resolve => app.process().once('exit', resolve));
  await page.evaluate(() => window.stomylos.command('close')); await stopped; app = null;
}
async function views(page) {
  return page.evaluate(async () => {
    const snapshot = await window.stomylos.command('snapshot');
    if (snapshot.settings.keyPresent || snapshot.settings.development) throw new Error('Expected an offline packaged launch');
    return Promise.all(snapshot.sessions.map(s => window.stomylos.command('loadSession', { sessionId: s.id })));
  });
}
try {
  let page = await launch(); const before = await views(page);
  assert.equal(before.length, 8); assert.ok(before.some(v => v.renewal?.state === 'completed'));
  assert.ok(before.some(v => v.units.length === 2)); await close(page);
  const audit = await promisify(execFile)(executablePath, [resolve('scripts/verify-normal-data.mjs'), directory, original,
    resolve('release/linux-unpacked/resources/app.asar.unpacked/native/advisory-lock.node')], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
  report.continuity = JSON.parse(audit.stdout); assert.equal(report.continuity.status, 'passed');
  assert.equal(Object.keys(report.continuity.counts).length, 12);
  page = await launch(); assert.deepEqual(await views(page), before); await close(page);
  report.checks.push('Externally converted public history accepted by packaged 0.3.0', 'All twelve tables preserve original rows',
    'Saved grammar, generated candidates and current draft survive reopen', 'Zero startup model requests');
  report.status = 'passed'; console.log(JSON.stringify(report, null, 2));
} finally {
  await app?.close().catch(() => undefined); mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/converted-package-report.json', JSON.stringify(report, null, 2));
}
