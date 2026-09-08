// Focused Settings acceptance with synthetic keys and a private Linux keyring.
// The real UI and credential module run together; only this isolated process's
// IPC credential wiring is replaced, leaving production development isolation on.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

if (!process.argv.includes('--private-session')) {
  const root = mkdtempSync('/tmp/stomylos-credential-ui-');
  for (const area of ['data', 'config', 'keyring']) mkdirSync(join(root, area), { mode: 0o700 });
  const result = spawnSync('dbus-run-session', ['--', process.execPath, import.meta.filename, '--private-session', root], {
    stdio: 'inherit', env: { ...process.env, XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config'), GNOME_KEYRING_CONTROL: join(root, 'keyring') }
  });
  process.exit(result.status ?? 1);
}
const root = process.argv.at(-1), output = resolve('test-results/credentials');
assert.ok(root.startsWith('/tmp/stomylos-credential-ui-'));
assert.equal(process.env.XDG_DATA_HOME, join(root, 'data'));
mkdirSync(output, { recursive: true });
const daemon = spawn('gnome-keyring-daemon', ['--foreground', '--unlock', '--components=secrets', '--control-directory', join(root, 'keyring')], { stdio: ['pipe', 'ignore', 'ignore'] });
daemon.stdin.end('isolated-credential-test-password');
const modulePath = join(root, 'credentials.cjs');
await build({ entryPoints: ['src/main/credentials.ts'], outfile: modulePath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const keyFile = join(root, 'api-credentials.json'), envFile = join(root, '.env');
writeFileSync(envFile, 'OPENROUTER_API_KEY=public-ui-legacy-key\n', { mode: 0o600 });
const env = { ...process.env, STOMYLOS_DATA_DIR: join(root, 'app-data') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY', 'STOMYLOS_TEST_ENDPOINT']) delete env[key];
const report = { status: 'running', root, checks: [], errors: [], paidRequests: 0 };
let application, page;
const button = name => page.getByRole('button', { name, exact: true });
const command = (name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
const settle = () => page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))));
const emptyInput = () => page.waitForFunction(() => document.querySelector('.credential-form input')?.value === '');
async function launch(backend = 'gnome-libsecret') {
  application = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.', `--password-store=${backend}`], env, chromiumSandbox: true, timeout: 20000 });
  page = await application.firstWindow(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.errors.push(error.message));
  await button('Settings').waitFor();
  // Verify the unchanged production isolation boundary before test-only wiring.
  await assert.rejects(command('manageKey', { action: 'save', key: 'public-ui-rejected' }), /credential_management_disabled/);
  const isolated = (await command('snapshot')).settings;
  assert.equal(isolated.development, true); assert.equal(isolated.credentials.secureAvailable, false);
  await application.evaluate(async ({ safeStorage, ipcMain, BrowserWindow }, { modulePath, keyFile, envFile }) => {
    const { Credentials } = process.getBuiltinModule('module').createRequire(process.execPath)(modulePath);
    const control = { fail: false, serial: 0, requests: 0 };
    // Never permit provider requests in the test, even if an unintended UI action occurs.
    globalThis.fetch = async () => { control.requests++; throw new Error('provider_request_forbidden'); };
    const secure = {
      isEncryptionAvailable: () => !control.fail && safeStorage.isEncryptionAvailable(),
      getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend(),
      encryptString: value => safeStorage.encryptString(value), decryptString: value => safeStorage.decryptString(value)
    };
    const manager = new Credentials(keyFile, envFile, process.platform, secure, 'personal'); manager.refresh();
    globalThis.credentialTest = { control, manager };
    const original = ipcMain._invokeHandlers.get('stomylos:command');
    const snapshot = async event => {
      const response = await original(event, 'snapshot', undefined);
      response.value.revision += 1000000 + ++control.serial;
      Object.assign(response.value.settings, { development: false, simulation: false, keyPresent: !!manager.currentKey(), keyPath: envFile, credentials: manager.snapshot() });
      return response;
    };
    ipcMain.removeHandler('stomylos:command');
    ipcMain.handle('stomylos:command', async (event, name, args) => {
      if (name === 'snapshot') return snapshot(event);
      if (!['manageKey', 'refreshKey'].includes(name)) return original(event, name, args);
      let result = { ok: true };
      try { if (name === 'manageKey') manager.manage(args); else manager.refresh(); }
      catch (error) { result = { ok: false, error: error.code ?? 'operation_failed' }; }
      const state = await snapshot(event);
      BrowserWindow.getAllWindows()[0].webContents.send('stomylos:event', { type: 'snapshot', snapshot: state.value });
      return result;
    });
  }, { modulePath, keyFile, envFile });
  await command('refreshKey');
  await button('Settings').click(); await page.getByRole('tab', { name: 'Connection & data', exact: true }).click();
}
async function stop() {
  assert.equal(await application.evaluate(() => globalThis.credentialTest.control.requests), 0);
  await application.close(); application = null;
}
async function source(mode) {
  if (!await page.getByLabel('Key source', { exact: true }).isVisible()) await page.getByText('Key source & .env fallback', { exact: true }).click();
  await page.getByLabel('Key source', { exact: true }).selectOption(mode);
}
try {
  await launch();
  assert.equal((await command('snapshot')).settings.credentials.secureAvailable, true, 'Private GNOME keyring must be available');
  const input = () => page.locator('.credential-form input');
  await input().fill('public-ui-secure-key'); await button('Save securely').click();
  await page.getByText('Using: System secure storage', { exact: true }).waitFor(); await emptyInput();
  assert.ok(!readFileSync(keyFile, 'utf8').includes('public-ui-secure-key'));
  report.checks.push('Private GNOME Keyring / real Electron safeStorage encrypts and decrypts synthetic credentials through the Settings UI');
  for (const [width, height] of [[1180, 860], [760, 620]]) {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await source('auto'); await settle();
    await page.locator('.settings-panel:not([hidden])').evaluate(panel => { panel.scrollTop = 0; });
    assert.equal(await page.evaluate(() => { const panel = document.querySelector('.settings-panel:not([hidden])'); return panel.scrollWidth > panel.clientWidth; }), false);
    await page.screenshot({ path: join(output, `${width}-settings.png`) });
  }
  await input().fill('public-ui-unsaved'); await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  await page.getByRole('tab', { name: 'Connection & data', exact: true }).click(); await emptyInput();
  await input().fill('public-ui-unsaved'); await page.keyboard.press('Escape');
  await button('Settings').click(); await emptyInput();
  report.checks.push('Wide/narrow layout has no horizontal overflow; changing tabs and closing Settings clear unsaved secret input');
  await stop(); await launch();
  await page.getByText('Using: System secure storage', { exact: true }).waitFor();
  await input().fill('public-ui-replacement'); await button('Save securely').click(); await page.getByRole('status').filter({ hasText: 'Saved securely' }).waitFor();
  await application.evaluate(() => { globalThis.credentialTest.control.fail = true; });
  await button('Reload key status').click(); await page.getByText('Using: Not available', { exact: true }).waitFor();
  assert.equal((await command('snapshot')).settings.keyPresent, false);
  await source('env'); await page.getByText('Using: .env file', { exact: true }).waitFor();
  await stop(); await launch(); await page.getByText('Using: .env file', { exact: true }).waitFor();
  await source('env'); await button('Import .env key into secure storage').click();
  await page.getByText('Using: System secure storage', { exact: true }).waitFor();
  assert.equal(readFileSync(envFile, 'utf8'), 'OPENROUTER_API_KEY=public-ui-legacy-key\n');
  report.checks.push('Restart preserves secure credentials and explicit env selection; unavailable storage blocks automatic fallback; importing keeps the original env file');
  await button('Delete saved key').click(); await button('Keep key').click();
  assert.equal((await command('snapshot')).settings.keyPresent, true);
  await button('Delete saved key').click(); await button('Confirm delete key').click();
  await page.getByText('Using: Not available', { exact: true }).waitFor();
  await stop(); await launch();
  assert.equal((await command('snapshot')).settings.credentials.mode, 'disabled');
  await stop(); await launch('basic');
  const status = (await command('snapshot')).settings.credentials;
  assert.equal(status.secureAvailable, false); assert.equal(await button('Save securely').isDisabled(), true);
  await assert.rejects(command('manageKey', { action: 'save', key: 'public-ui-denied' }), /secure_storage_unavailable/);
  await source('env'); await page.getByText('Using: .env file', { exact: true }).waitFor();
  report.checks.push('Confirmed deletion remains disabled after restart; actual basic_text backend rejects secure saves while explicit env remains usable');
  assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) {
  report.error = String(error);
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => undefined);
  throw error;
} finally {
  await application?.close().catch(() => undefined); daemon.kill();
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
