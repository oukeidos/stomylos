// Current functional smoke. Motion/soak acceptance is change-sensitive, not part of this command.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';

const executable = createRequire(import.meta.url)('electron');
const packaged = process.argv.includes('--packaged');
const directory = mkdtempSync('/tmp/stomylos-functional-');
const output = resolve(`test-results/functional-${packaged ? 'packaged' : 'native'}`);
mkdirSync(output, { recursive: true });
const seed = spawnSync(executable, ['scripts/seed-ui.mjs', directory, '--history'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8'
});
if (seed.status !== 0) throw new Error(seed.stderr || seed.stdout);
const mock = await startMockGateway({ repeat: 2, delay: 8 });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint,
  ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
let app, page;
const errors = [], checks = [];
const report = { status: 'running', directory, packaged, errors, checks, paidRequests: 0 };
const button = name => page.getByRole('button', { name, exact: true });
const cmd = (name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
async function launch() {
  app = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/linux-unpacked/stomylos') : executable,
    args: packaged ? [] : ['.'], env, chromiumSandbox: true, timeout: 20000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.composer textarea').waitFor();
}
async function close() {
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await exited; app = null;
}
async function settled(fn) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Functional state did not settle');
}
try {
  await launch();
  assert.deepEqual(await app.evaluate(({ app, BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { noSandbox: app.commandLine.hasSwitch('no-sandbox'), sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
  }), { noSandbox: false, sandbox: true, contextIsolation: true, nodeIntegration: false });
  const snapshot = await cmd('snapshot'), id = snapshot.unfinished.id;
  assert.equal(await page.locator('aside').isVisible(), false);
  await button('Show history').click(); await button('Older').click();
  await settled(async () => await page.locator('.history-item').count() === 23);
  await page.locator('.history-item').last().click(); await button('Return to current chat').click();
  await button('Newer').click(); await settled(async () => await page.locator('.history-item').count() === 40);
  await button('Partner: Automatic').click(); await page.keyboard.press('End');
  await settled(() => page.evaluate(label => document.activeElement.textContent.includes(label), snapshot.characters.at(-1).label));
  await page.keyboard.type('Explain');
  await settled(() => page.evaluate(() => document.activeElement.querySelector('strong')?.textContent === 'Explain'));
  await page.keyboard.press('Enter'); await button('Partner: Explain').waitFor();
  const input = page.getByRole('textbox', { name: 'Your message', exact: true });
  const text = '  I enjoy quiet mornings.\n한글 draft retained.  ';
  await input.fill(text); await page.getByText('Draft saved', { exact: true }).waitFor();
  await input.dispatchEvent('compositionstart'); await input.press('Enter');
  assert.equal(mock.requests.length, 0, 'IME composition cannot Send');
  await input.dispatchEvent('compositionend'); await input.fill(text);
  await page.getByRole('button', { name: /^Send/ }).click();
  await page.getByText('Writing…', { exact: true }).waitFor();
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  const selected = await page.locator('.bubble.user p').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString();
  });
  assert.equal(selected, text); await page.keyboard.press('Control+c');
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), text);
  await page.getByText('Writing…', { exact: true }).waitFor({ state: 'hidden' });
  await button('Partner: Explain').click();
  assert.equal(await page.getByRole('menuitemradio').count(), snapshot.characters.length + 1);
  await page.keyboard.press('Escape');
  checks.push('History paging/reopen, current roster keyboard selection, exact IME/text/clipboard, stream focus and retained active selector');
  await page.getByRole('button', { name: 'What small part of your day would you like to keep?' }).first().click();
  await page.getByRole('button', { name: /Analysis details/ }).click();
  await page.getByRole('checkbox', { name: 'Only show suggested changes' }).uncheck();
  assert.equal(await page.locator('.analysis-unit').count(), 24);
  await button('Return to current chat').click(); await button('End chat').click();
  await settled(async () => {
    const view = await cmd('loadSession', { sessionId: id });
    return view.session.analysis_state === 'completed' && view.renewal?.state === 'completed' && view.memory.job?.state === 'completed';
  });
  const stored = await cmd('loadSession', { sessionId: id });
  assert.equal(stored.messages.find(m => m.origin === 'learner').content, text);
  assert.equal(stored.units.length, 1); assert.equal(stored.session.character, 'model_03');
  assert.equal(stored.renewal.accepted_count, 2);
  assert.equal(await page.locator('header .current-partner').innerText(), 'Explain');
  const calls = mock.requests.length;
  assert.equal(calls, 6, 'One route, search, reply, grammar, memory and renewal request');
  await close(); await launch();
  assert.deepEqual(await cmd('loadSession', { sessionId: id }), stored);
  assert.equal(mock.requests.length, calls, 'Restart cannot dispatch background work');
  checks.push('Historical full analysis, independent end jobs, exact stored source and restart without replay');
  assert.deepEqual(errors, []); await close(); report.status = 'passed'; report.requests = calls;
  console.log(JSON.stringify(report));
} catch (error) {
  report.status = 'failed'; report.failure = String(error);
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => undefined);
  throw error;
} finally {
  await app?.close().catch(() => undefined); await new Promise(resolve => mock.server.close(resolve));
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
