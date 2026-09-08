// Focused native backup acceptance. Only OS file/confirmation dialogs and relaunch
// are scripted; all backup IPC, workers, files and restart recovery are real.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = mkdtempSync('/tmp/stomylos-backup-ui-'), directory = join(root, 'data');
const output = resolve('test-results/backup'); mkdirSync(output, { recursive: true });
const file = join(root, 'user.stomylos-backup'), invalid = join(root, 'invalid.stomylos-backup'); writeFileSync(invalid, 'invalid backup');
const env = { ...process.env, STOMYLOS_DATA_DIR: directory };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_TEST_ENDPOINT', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
const report = { status: 'running', checks: [], errors: [], paidRequests: 0 };
let application, page;
const button = name => page.getByRole('button', { name, exact: true });
const command = (name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
async function launch() {
  application = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.'], env, chromiumSandbox: true, timeout: 20000 });
  page = await application.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.errors.push(error.message));
  await button('Settings').waitFor();
  await application.evaluate(({ dialog, app, ipcMain, BrowserWindow }, { file, invalid }) => {
    globalThis.backupTest = { file, invalid, chosen: file, cancel: false, confirm: false, prompts: [], requests: 0, failDraft: false, releases: [] };
    const original = ipcMain._invokeHandlers.get('stomylos:command');
    ipcMain.removeHandler('stomylos:command');
    ipcMain.handle('stomylos:command', async (event, name, args) => {
      if (name !== 'saveDraft' || !globalThis.backupTest.failDraft) return original(event, name, args);
      const result = await original(event, 'snapshot', undefined);
      result.value.revision++; result.value.activity.storageError = 'operation_failed';
      BrowserWindow.getAllWindows()[0].webContents.send('stomylos:event', { type: 'snapshot', snapshot: result.value });
      return new Promise(resolve => globalThis.backupTest.releases.push(async () => resolve(await original(event, name, args))));
    });
    globalThis.fetch = async () => { globalThis.backupTest.requests++; throw new Error('provider_request_forbidden'); };
    dialog.showSaveDialog = async () => ({ canceled: globalThis.backupTest.cancel, filePath: file });
    dialog.showOpenDialog = async () => ({ canceled: globalThis.backupTest.cancel, filePaths: [globalThis.backupTest.chosen] });
    dialog.showMessageBox = async options => { globalThis.backupTest.prompts.push(options); return { response: options.title === 'Restore backup?' && globalThis.backupTest.confirm ? 1 : 0 }; };
    // The test explicitly relaunches the same isolated data directory after exit.
    app.relaunch = () => {};
  }, { file, invalid });
}
async function dataSettings() { await button('Settings').click(); await page.getByRole('tab', { name: 'Connection & data', exact: true }).click(); }
async function flags(values) { await application.evaluate((_, values) => Object.assign(globalThis.backupTest, values), values); }
try {
  await launch();
  const id = (await command('snapshot')).unfinished.id, original = 'Back up this exact draft. 한글', newer = 'Newer local draft preserved for recovery.';
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(original);
  await dataSettings();
  for (const [width, height] of [[1180, 860], [760, 620]]) {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await button('Export backup').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, `settings-${width}.png`) });
    const fits = await page.locator('.settings-dialog').evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth);
    assert.ok(fits, `Settings fits at ${width}`);
  }
  await button('Export backup').focus(); await page.keyboard.press('Enter');
  await page.getByText('Backup saved and verified.', { exact: true }).waitFor(); assert.ok(existsSync(file));
  assert.equal((await command('loadSession', { sessionId: id })).session.draft, original);
  report.checks.push('Keyboard export, exact draft flush, wide/narrow layout and verified archive');
  await button('Export backup').click(); await page.getByRole('alert').filter({ hasText: 'Choose a new filename' }).waitFor();
  report.checks.push('Existing backup is never overwritten');
  await button('Close settings').click(); await flags({ failDraft: true });
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Draft awaiting save recovery.');
  await dataSettings(); await button('Export backup').click();
  await page.getByRole('alert').filter({ hasText: 'Save your latest changes' }).waitFor();
  assert.equal(await button('Export backup').isEnabled(), true); await button('Close settings').click();
  await application.evaluate(async () => { globalThis.backupTest.failDraft = false; await Promise.all(globalThis.backupTest.releases.splice(0).map(release => release())); });
  await command('refreshKey');
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(original);
  await dataSettings();
  report.checks.push('Draft persistence failure releases the backup UI so save recovery remains accessible');
  await flags({ cancel: true }); await button('Restore backup').click(); await page.getByText('Cancelled.', { exact: true }).waitFor();
  await flags({ cancel: false, chosen: invalid }); await button('Restore backup').click(); await page.getByRole('alert').filter({ hasText: 'could not finish' }).waitFor();
  assert.equal((await command('loadSession', { sessionId: id })).session.draft, original);
  await flags({ chosen: file, confirm: false }); await button('Restore backup').click(); await page.getByText('Cancelled.', { exact: true }).waitFor();
  assert.equal((await command('loadSession', { sessionId: id })).session.draft, original);
  report.checks.push('File cancellation, invalid backup and final confirmation cancellation preserve data');
  await button('Close settings').click();
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(newer);
  await dataSettings(); await flags({ confirm: true });
  const closed = application.waitForEvent('close'); await button('Restore backup').click(); await closed; application = null;
  await launch();
  assert.equal((await command('loadSession', { sessionId: id })).session.draft, original);
  const recovery = readdirSync(directory).find(name => name.startsWith('restore-recovery-')); assert.ok(recovery);
  const previous = await application.evaluate((_, { file, module }) => {
    const Database = process.getBuiltinModule('module').createRequire(process.execPath)(module);
    const db = new Database(file, { readonly: true }); try { return db.prepare('SELECT draft FROM sessions LIMIT 1').get().draft; } finally { db.close(); }
  }, { file: join(directory, recovery, 'previous', 'stomylos.sqlite3'), module: resolve('node_modules/better-sqlite3') });
  assert.equal(previous, newer);
  assert.equal(await application.evaluate(() => globalThis.backupTest.requests), 0);
  report.checks.push('Confirmed restore exits, reopens the exact backed-up draft, and retains the newer draft in recovery');
  await command('close'); await application.close(); application = null;
  // Startup failure is handled before a renderer exists. Patch only the native
  // dialogs while the initial recovery/DB workers are still starting.
  writeFileSync(join(directory, 'stomylos.sqlite3'), 'corrupt history');
  application = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.'], env, chromiumSandbox: true, timeout: 20000 });
  const recovered = application.waitForEvent('close', { timeout: 20000 });
  await application.evaluate(({ dialog, app }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    dialog.showMessageBox = async options => ({ response: ['Stomylos could not start', 'Restore backup?'].includes(options.title) ? 1 : 0 });
    app.relaunch = () => {};
  }, file);
  await recovered; application = null;
  await launch();
  assert.equal((await command('loadSession', { sessionId: id })).session.draft, original);
  const recoveries = readdirSync(directory).filter(name => name.startsWith('restore-recovery-'));
  assert.ok(recoveries.some(name => readFileSync(join(directory, name, 'previous', 'stomylos.sqlite3')).equals(Buffer.from('corrupt history'))));
  report.checks.push('Startup-error restore reopens the backup and preserves the corrupt original bytes');
  await command('close'); await application.close(); application = null;
  assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = String(error.stack ?? error); process.exitCode = 1; }
finally { if (application) await application.close().catch(() => undefined); writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); if (report.status === 'passed') rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify(report, null, 2));
