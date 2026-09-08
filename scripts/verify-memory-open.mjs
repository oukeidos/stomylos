// Isolated packaged read/reopen gate for an externally converted copy.
import { _electron as electron } from 'playwright-core';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const directory = process.argv[2];
assert.ok(directory?.startsWith('/tmp/'), 'Only an isolated temporary copy may be opened by this gate');
const env = { ...process.env, STOMYLOS_DATA_DIR: directory };
for (const key of ['ELECTRON_RUN_AS_NODE', 'STOMYLOS_TEST_ENDPOINT', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
let app; const errors = []; let first;
try {
  for (let pass = 0; pass < 2; pass++) {
    app = await electron.launch({ executablePath: resolve('release/linux-unpacked/stomylos'), env, chromiumSandbox: true, timeout: 20000 });
    const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const snapshot = await page.evaluate(() => window.stomylos.command('snapshot'));
    assert.equal(snapshot.settings.keyPresent, false); assert.equal(snapshot.settings.dataPath, directory);
    const id = snapshot.unfinished.id;
    const view = await page.evaluate(id => window.stomylos.command('loadSession', { sessionId: id }), id);
    if (!first) first = view; else assert.deepEqual(view, first);
    const exited = new Promise(r => app.process().once('exit', r)); await page.evaluate(() => window.stomylos.command('close')); await exited; app = null;
  }
  assert.deepEqual(errors, []);
  const report = { status: 'passed', directory, version: JSON.parse(readFileSync('package.json', 'utf8')).version, keyPresent: false, restartPreserved: true, errors };
  writeFileSync(directory + '/package-open.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await app?.close().catch(() => undefined); }
