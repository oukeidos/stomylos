// Focused native exit faults, isolated history and local mock; never normal data.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const require = createRequire(import.meta.url), directory = mkdtempSync('/tmp/stomylos-exit-');
const output = 'test-results/exit-recovery'; mkdirSync(output, { recursive: true });
const mock = await startMockGateway({ delay: 5 });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
let app, page; const report = { directory, checks: [], errors: [] };
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], env, chromiumSandbox: true, timeout: 20000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000);
  page.on('pageerror', e => report.errors.push(e.message));
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
}
async function fault(mode) {
  await app.evaluate(({ app }, mode) => {
    const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
    const { Worker } = require('node:worker_threads'); const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (value, ...args) {
      if (mode === 'save' && value.method === 'saveDraft') { queueMicrotask(() => this.emit('message', { id: value.id, error: 'operation_failed' })); return; }
      if (mode === 'hang-close' && value.method === 'close') return;
      return original.call(this, value, ...args);
    };
  }, mode);
}

try {
  await launch();
  const id = await page.evaluate(async () => (await window.stomylos.command('snapshot', undefined)).unfinished.id);
  await page.evaluate(id => window.stomylos.command('saveDraft', { sessionId: id, text: 'Saved baseline', revision: 10 }), id);
  await fault('save');
  await page.locator('.composer textarea').fill('Unsaved exit recovery text');
  // Ensure a queued save error without depending on debounce timing.
  await page.evaluate(id => { void window.stomylos.command('saveDraft', { sessionId: id, text: 'Unsaved exit recovery text', revision: 11 }); }, id);
  await page.getByRole('button', { name: 'Exit options', exact: true }).waitFor();
  // The main-owned dialog is separate from the blocked Settings renderer.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const firstDialog = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let exitPage = await firstDialog; await exitPage.getByRole('button', { name: 'Go back', exact: true }).waitFor();
  assert.equal(await exitPage.locator('footer button').count(), 2);
  assert.equal(await exitPage.getByText('Retry saving and close', { exact: true }).count(), 0);
  const stayed = exitPage.waitForEvent('close'); await exitPage.keyboard.press('Escape').catch(() => {}); await stayed;
  report.checks.push('Two-choice exit window appears above Settings; Escape goes back');
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'password'; input.value = 'SECRET_MUST_NOT_COPY'; document.body.append(input); });
  const secondDialog = app.waitForEvent('window');
  await page.evaluate(() => window.stomylos.command('exitOptions', undefined));
  exitPage = await secondDialog;
  await exitPage.getByRole('button', { name: 'Copy unsaved text', exact: true }).click();
  await exitPage.getByRole('status').filter({ hasText: /^Copied$/ }).waitFor();
  const copied = await app.evaluate(async ({ clipboard }) => await clipboard.readText());
  assert.ok(copied.includes('Unsaved exit recovery text')); assert.ok(!copied.includes('SECRET_MUST_NOT_COPY'));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2);
  await exitPage.screenshot({ path: output + '/copied.png' });
  report.checks.push('Copy updates inline in the same window and excludes credential fields');
  const closed = app.waitForEvent('close');
  await exitPage.getByRole('button', { name: 'Exit without saving', exact: true }).click().catch(() => {}); await closed;
  report.checks.push('Explicit exit terminates without shell kill');
  await launch();
  const data = await app.evaluate(({ app }, [directory, id]) => {
    const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
    const db = new (require('better-sqlite3'))(directory + '/stomylos.sqlite3', { readonly: true });
    const data = { draft: db.prepare('SELECT draft FROM sessions WHERE id=?').get(id).draft, integrity: db.pragma('integrity_check', { simple: true }) }; db.close(); return data;
  }, [directory, id]);
  assert.deepEqual(data, { draft: 'Saved baseline', integrity: 'ok' });
  report.checks.push('Reopen acquires lock and preserves committed history with SQLite integrity');
  await fault('hang-close');
  // Normal close needs no loss confirmation once preparation succeeds; even a hung
  // worker close must finish via the bounded main exit deadline.
  const finalClosed = app.waitForEvent('close'), started = Date.now();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await finalClosed; const elapsed = Date.now() - started; assert.ok(elapsed < 7000); assert.ok(elapsed >= 1900);
  report.checks.push(`Hung worker close terminated in ${elapsed}ms`);
  assert.equal(mock.requests.length, 0); assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error); console.error(error); throw error; }
finally {
  try { await app?.evaluate(({ app }) => app.exit(1)); } catch {}
  await new Promise(resolve => mock.server.close(resolve));
  writeFileSync(output + '/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
