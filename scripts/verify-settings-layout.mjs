// Settings disclosure/navigation regression, with synthetic credential IPC and
// cancelled native file dialogs; no normal keyring, data or provider access.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const directory = mkdtempSync(join(tmpdir(), 'stomylos-settings-layout-'));
const output = 'test-results/settings-layout'; mkdirSync(output, { recursive: true });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_TEST_ENDPOINT', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
let app; const errors = [];
try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.'], env, chromiumSandbox: true });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  const button = name => page.getByRole('button', { name, exact: true });
  const tab = name => page.getByRole('tab', { name, exact: true });
  await button('Settings').waitFor();
  await app.evaluate(({ ipcMain, BrowserWindow, dialog }) => {
    const test = globalThis.settingsLayoutTest = { serial: 0, commands: [], requests: 0, dialogs: [], credentials: { source: 'secure', mode: 'auto', saved: true, secureAvailable: true, problem: null } };
    globalThis.fetch = async () => { test.requests++; throw new Error('provider_request_forbidden'); };
    dialog.showSaveDialog = async () => { test.dialogs.push('export'); return { canceled: true }; };
    dialog.showOpenDialog = async () => { test.dialogs.push('restore'); return { canceled: true, filePaths: [] }; };
    const original = ipcMain._invokeHandlers.get('stomylos:command');
    const snapshot = async event => {
      const response = await original(event, 'snapshot', undefined);
      response.value.revision += 1000000 + ++test.serial;
      Object.assign(response.value.settings, { development: false, simulation: false, keyPresent: test.credentials.source !== 'none', credentials: { ...test.credentials } });
      return response;
    };
    ipcMain.removeHandler('stomylos:command');
    ipcMain.handle('stomylos:command', async (event, name, args) => {
      if (name === 'snapshot') return snapshot(event);
      if (!['manageKey', 'refreshKey'].includes(name)) return original(event, name, args);
      test.commands.push({ name, action: args?.action });
      if (args?.action === 'delete') Object.assign(test.credentials, { saved: false, source: 'none', mode: 'disabled' });
      if (args?.action === 'save' || args?.action === 'import') Object.assign(test.credentials, { saved: true, source: 'secure', mode: 'auto' });
      if (args?.action === 'mode') Object.assign(test.credentials, { mode: args.mode, source: args.mode === 'disabled' ? 'none' : args.mode === 'env' ? 'env' : 'secure' });
      BrowserWindow.getAllWindows()[0].webContents.send('stomylos:event', { type: 'snapshot', snapshot: (await snapshot(event)).value });
      return { ok: true };
    });
  });
  await page.evaluate(() => window.stomylos.command('refreshKey'));
  await button('Settings').click(); await tab('Connection & data').click();
  const key = page.locator('.credential-form input');
  assert.equal(await key.isVisible(), false);
  await button('Manage').focus(); await page.keyboard.press('Enter'); await key.waitFor();
  await key.fill('public-settings-sample'); await button('Manage').click();
  assert.equal(await key.inputValue(), ''); assert.equal(await key.isVisible(), false);
  await button('Manage').click(); await key.fill('public-settings-sample'); await page.keyboard.press('Enter');
  await page.getByRole('status').filter({ hasText: 'Saved securely' }).waitFor();
  assert.equal(await key.inputValue(), '');
  await button('Reload key status').click();
  await page.getByText('Key source & .env fallback', { exact: true }).click();
  await page.getByLabel('Key source', { exact: true }).selectOption('env');
  await button('Import .env key into secure storage').click();
  await page.getByRole('status').filter({ hasText: 'original .env file was kept' }).waitFor();
  await key.fill('public-unsaved'); await tab('Voice').click(); await tab('Connection & data').click();
  assert.equal(await key.inputValue(), ''); assert.equal(await key.isVisible(), false);
  for (const width of [1180, 760]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 700), width);
    await page.screenshot({ path: `${output}/data-${width}.png` });
    assert.equal(await page.locator('.settings-panel:not([hidden])').evaluate(n => n.scrollWidth > n.clientWidth), false);
    await button('Manage').click(); await page.screenshot({ path: `${output}/manage-${width}.png` });
    assert.equal(await page.locator('.settings-panel:not([hidden])').evaluate(n => n.scrollWidth > n.clientWidth), false);
    await button('Manage').click();
  }
  await button('Manage').click(); await button('Delete saved key').click(); await button('Keep key').click();
  await button('Delete saved key').click(); await button('Confirm delete key').click();
  await page.getByRole('status').filter({ hasText: 'Saved key deleted' }).waitFor();
  await tab('Voice').click(); await tab('Connection & data').click();
  assert.equal(await key.isVisible(), true, 'Missing key opens management on entry');
  await button('Export backup').click(); await page.getByText('Cancelled.', { exact: true }).waitFor();
  await button('Restore backup').click(); await page.getByText('Cancelled.', { exact: true }).waitFor();
  await page.getByText('What’s included', { exact: true }).click();
  await page.getByText(/Restoring replaces this computer’s history/).waitFor();
  await page.getByText('Storage location', { exact: true }).click();
  await page.getByText(directory, { exact: true }).waitFor();
  await button('Clear saved speech').click(); await button('Keep speech').click();
  await button('Close settings').click();
  assert.equal(await button('Settings').evaluate(n => n === document.activeElement), true);
  const result = await app.evaluate(() => globalThis.settingsLayoutTest);
  assert.deepEqual(result.dialogs, ['export', 'restore']);
  assert.deepEqual(result.commands.filter(c => c.name === 'manageKey').map(c => c.action), ['save', 'mode', 'import', 'delete']);
  assert.equal(result.requests, 0); assert.deepEqual(errors, []);
  writeFileSync(`${output}/report.json`, JSON.stringify({ passed: true, checks: ['manage disclosure and keyboard save', 'secret clearing on collapse/tab change', 'reload/source/import/delete commands', 'missing-key entry', 'wide/narrow collapsed and expanded layout', 'backup export/restore cancellation', 'backup/storage details', 'speech clear cancellation', 'focus return'], providerRequests: result.requests, errors }, null, 2));
  console.log('Settings layout: passed (synthetic credentials, isolated data, no provider calls).');
} finally {
  await app?.close().catch(() => undefined);
  rmSync(directory, { recursive: true, force: true });
}
