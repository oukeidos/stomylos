import { _electron as electron } from 'playwright-core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const exec = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'stomylos-source-launch-'));
const desktop = join(root, 'Desktop with spaces'), data = join(root, 'data'), config = join(root, 'config');
for (const folder of [desktop, data, config]) mkdirSync(folder, { recursive: true });
writeFileSync(join(config, 'user-dirs.dirs'), `XDG_DESKTOP_DIR="${desktop}"\n`);
const env = { ...process.env, XDG_DATA_HOME: data, XDG_CONFIG_HOME: config };
for (const name of Object.keys(env)) if (name.startsWith('STOMYLOS_') || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'].includes(name)) delete env[name];
const launcher = resolve('run.sh');
const checks = [], errors = [];
const report = { status: 'running', checks, errors, paidRequests: 0 };
let app;
async function open() {
  app = await electron.launch({ executablePath: launcher, args: [], cwd: tmpdir(), env, chromiumSandbox: true, timeout: 20000 });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.composer textarea').waitFor();
  return page;
}
async function close() {
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await exited; app = undefined;
}
try {
  await exec(resolve('install-desktop.sh'), [], { env, cwd: tmpdir() });
  const entries = [join(data, 'applications/stomylos.desktop'), join(desktop, 'stomylos.desktop')];
  for (const entry of entries) {
    const content = readFileSync(entry, 'utf8');
    assert.ok(content.includes(`Exec="${launcher}"`));
    assert.ok(content.includes(`TryExec=${launcher}`));
    assert.ok(content.includes(`Icon=${resolve('assets/icon.png')}`));
    assert.equal(statSync(entry).mode & 0o777, 0o755);
    await exec('desktop-file-validate', [entry]);
  }
  const menu = readFileSync(entries[0]);
  const unrelated = '[Desktop Entry]\nType=Application\nName=Unrelated\nExec=true\n';
  writeFileSync(entries[1], unrelated);
  await assert.rejects(exec(resolve('install-desktop.sh'), [], { env, cwd: tmpdir() }));
  assert.deepEqual(readFileSync(entries[0]), menu);
  assert.equal(readFileSync(entries[1], 'utf8'), unrelated);
  checks.push('Actual source desktop/menu installer, isolated XDG paths with spaces, unrelated entry protection');

  let page = await open();
  assert.deepEqual(await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], prefs = window.webContents.getLastWebPreferences();
    return { packaged: app.isPackaged, url: window.webContents.getURL(), sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, noSandbox: app.commandLine.hasSwitch('no-sandbox') };
  }), { packaged: false, url: 'stomylos://app/', sandbox: true, contextIsolation: true, nodeIntegration: false, noSandbox: false });
  const snapshot = await page.evaluate(() => window.stomylos.command('snapshot'));
  assert.equal(snapshot.settings.development, false);
  assert.equal(snapshot.settings.simulation, false);
  assert.equal(snapshot.settings.dataPath, join(data, 'io.github.oukeidos.stomylos'));
  const draft = 'Source launch preserves this offline draft.';
  await page.locator('.composer textarea').fill(draft);
  await page.getByText('Draft saved', { exact: true }).waitFor();
  await close();
  page = await open();
  assert.equal(await page.locator('.composer textarea').inputValue(), draft);
  const reopened = await page.evaluate(() => window.stomylos.command('snapshot'));
  assert.equal(reopened.unfinished.id, snapshot.unfinished.id);
  await close();
  checks.push('Actual run.sh opens built source from another cwd with normal-mode isolated XDG data and Chromium sandbox');
  checks.push('Offline draft survives clean close and reopen; no Send or provider operation invoked');
  assert.deepEqual(errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = String(error); throw error;
} finally {
  await app?.close().catch(() => undefined);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/source-launch.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'passed') rmSync(root, { recursive: true, force: true });
}
