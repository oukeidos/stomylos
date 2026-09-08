// Read-only UI actions through the actual source-tree launcher and normal data.
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const accepted = JSON.parse(readFileSync('test-results/pattern-copy-acceptance.json', 'utf8'));
const cutover = JSON.parse(readFileSync('test-results/pattern-cutover-report.json', 'utf8'));
const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'STOMYLOS_DATA_DIR', 'STOMYLOS_TEST_ENDPOINT', 'STOMYLOS_PACKAGED_TEST', 'STOMYLOS_LIVE_VERIFY', 'ELECTRON_RENDERER_URL']) delete env[key];
const passes = [], errors = []; let app;
try {
  for (let pass = 0; pass < 2; pass++) {
    app = await electron.launch({ executablePath: resolve('run.sh'), env, chromiumSandbox: true, timeout: 20000 });
    const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const state = await page.evaluate(async () => {
      const snapshot = await window.stomylos.command('snapshot');
      const views = [];
      for (let offset = 0;; offset += 40) {
        const list = await window.stomylos.command('listSessions', { offset });
        for (const session of list.sessions) views.push(await window.stomylos.command('loadSession', { sessionId: session.id }));
        if (!list.hasMore) break;
      }
      return { views, settings: snapshot.settings, preview: await window.stomylos.command('patternPreview'), reports: await window.stomylos.command('patternList', { offset: 0 }) };
    });
    assert.equal(state.settings.appVersion, '0.12.0'); assert.equal(state.settings.development, false); assert.equal(state.settings.simulation, false);
    assert.equal(state.settings.dataPath + '/stomylos.sqlite3', cutover.source);
    const viewHash = createHash('sha256').update(JSON.stringify(state.views)).digest('hex');
    assert.equal(viewHash, accepted.passes[0].view_sha256);
    assert.equal(state.reports.reports.length, 0); assert.equal(state.preview.scope.count, 4);
    await page.getByRole('button', { name: 'Learning', exact: true }).click();
    await page.getByRole('heading', { name: 'Recent conversations', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Create report', exact: true }).isDisabled(), true);
    passes.push({ version: state.settings.appVersion, normalData: true, keyPresent: state.settings.keyPresent, sessions: state.views.length, view_sha256: viewHash, eligible: 4, blocked: state.preview.blocked });
    const exited = new Promise(r => app.process().once('exit', r));
    await page.evaluate(() => window.stomylos.command('close')); await exited; app = null;
  }
  assert.deepEqual(errors, []);
  const report = { status: 'passed', launcher: resolve('run.sh'), passes, errors, inferenceActions: 0 };
  writeFileSync('test-results/pattern-normal-launcher.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally { if (app) await app.evaluate(({ app }) => app.exit()); }
