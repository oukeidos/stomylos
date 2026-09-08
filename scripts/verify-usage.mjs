import { spawnSync } from 'node:child_process';
// Focused Settings check: synthetic ledger, no provider or normal-data access.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const require = createRequire(import.meta.url), directory = mkdtempSync(join(tmpdir(), 'stomylos-usage-ui-'));
const output = 'test-results/usage'; mkdirSync(output, { recursive: true });
const mock = await startMockGateway({ delay: 1 });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const errors = []; let app, page;
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], env, chromiumSandbox: true });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
}
async function close() {
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await page.evaluate(() => window.stomylos.command('close')); await exited; app = null;
}
const button = name => page.getByRole('button', { name, exact: true });
const input = () => page.getByLabel('Budget in USD', { exact: true });
async function openUsage() {
  await button('Settings').click(); await page.getByRole('tab', { name: 'Usage & budget', exact: true }).click(); await input().waitFor();
}
async function budget(amount) { await input().fill(amount); await button('Save budget').click(); }
try {
  await launch();
  const initial = await page.evaluate(() => window.stomylos.command('usageSnapshot'));
  assert.equal(initial.requests, 0);
  await close();
  const seeded = spawnSync(require('electron'), ['-e', `
    const Database = require('better-sqlite3'), db = new Database(require('node:path').join(process.argv[1], 'usage.sqlite3'));
    const insert = db.prepare('INSERT INTO charges VALUES(?,?,?,?,?,?)'), at = new Date().toISOString(), month = process.argv[2];
    insert.run('reported', at, month, '0.8', null, null);
    insert.run('estimated', at, month, null, '0.2', 'synthetic');
    insert.run('unknown', at, month, null, null, null); db.close();
  `, directory, initial.month], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr); await launch();
  await openUsage();
  await page.getByText('$0.80 reported + $0.20 estimated', { exact: true }).waitFor();
  await page.getByText('Cost is not yet reported for 1 of 3 requests. This total is incomplete.', { exact: true }).waitFor();
  await budget('1.25'); await page.getByText('Near your monthly budget (80% or more).', { exact: true }).waitFor();
  await page.getByText('Monthly budget saved.', { exact: true }).waitFor();
  await budget('0'); await page.getByText(/Enter a positive USD amount/).waitFor();
  assert.equal((await page.evaluate(() => window.stomylos.command('usageSnapshot'))).budget, '1.25');
  await input().fill('1.00'); await page.keyboard.press('Enter');
  await page.getByText('Monthly budget reached or exceeded.', { exact: true }).waitFor();
  for (const width of [1180, 760]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 860), width);
    assert.equal(await page.locator('.settings-panel:not([hidden])').evaluate(n => n.scrollWidth > n.clientWidth), false);
    await page.screenshot({ path: `${output}/settings-${width}.png` });
  }
  await button('Turn off').click(); await page.getByText('Not set.', { exact: true }).waitFor();
  await budget('2'); await page.getByText('Monthly budget saved.', { exact: true }).waitFor();
  await button('Close settings').click();
  assert.equal(await button('Settings').evaluate(n => document.activeElement === n), true);
  await close(); await launch(); await openUsage();
  assert.equal(await input().inputValue(), '2');
  assert.equal((await page.evaluate(() => window.stomylos.command('usageSnapshot'))).total, '1');
  assert.equal(mock.requests.length, 0); assert.deepEqual(errors, []);
  writeFileSync(`${output}/summary.json`, JSON.stringify({ passed: true, checks: ['reported + estimated + unknown', '80% / 100%', 'invalid edit', 'keyboard save', 'off', 'wide/narrow', 'focus return', 'restart', 'zero provider calls'], errors }, null, 2));
  await close(); console.log('Usage Settings: passed (synthetic data, zero provider calls).');
} finally { if (app) await app.close().catch(() => undefined); await new Promise(resolve => mock.server.close(resolve)); rmSync(directory, { recursive: true, force: true }); }
