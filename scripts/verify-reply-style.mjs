// Focused UI-only acceptance. Fresh temporary data and a loopback mock gateway;
// no messages are sent and no normal history or credentials are used.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';

const directory = mkdtempSync('/tmp/stomylos-reply-style-');
const output = 'test-results/reply-style-preview';
mkdirSync(output, { recursive: true });
const mock = await startMockGateway({ delay: 0 });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
const report = { status: 'running', paidRequests: 0, mockRequests: 0, checks: [], errors: [] };
let app;
try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [resolve(process.env.STOMYLOS_VERIFY_APP ?? '.')], env, chromiumSandbox: true });
  const page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.errors.push(error.message));
  const trigger = page.locator('.reply-style-trigger');
  const menu = page.getByRole('menu', { name: 'Reply style', exact: true });
  const option = name => menu.getByRole('menuitemcheckbox', { name, exact: true });
  const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
  await trigger.waitFor();
  await composer.fill('Keep this draft unchanged. 한글');
  await page.getByText('Draft saved', { exact: true }).waitFor();
  await page.evaluate(() => { window.replyStyleComposer = document.querySelector('.composer textarea'); });
  // Record calls without exposing any product test escape hatch.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('stomylos:command');
    globalThis.replyStyleCommands = [];
    ipcMain.removeHandler('stomylos:command');
    ipcMain.handle('stomylos:command', (...args) => {
      globalThis.replyStyleCommands.push(args[1]);
      return original(...args);
    });
  });

  assert.equal(await trigger.getAttribute('aria-label'), 'Reply style: Default');
  assert.equal(await page.locator('.reply-style-count').count(), 0);
  await trigger.focus(); await page.keyboard.press('ArrowDown');
  await menu.waitFor();
  assert.equal(await option('Easier').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Space');
  assert.equal(await option('Easier').getAttribute('aria-checked'), 'true');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Shorter');
  await page.keyboard.press('Enter');
  assert.equal(await option('Shorter').getAttribute('aria-checked'), 'true');
  await option('Conversational').click();
  assert.equal(await page.locator('.reply-style-count').textContent(), '3');
  assert.equal(await menu.isVisible(), true);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.classList.contains('reply-style-trigger'));
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
  assert.equal(await composer.inputValue(), 'Keep this draft unchanged. 한글');
  assert.equal(await page.evaluate(() => window.replyStyleComposer === document.querySelector('.composer textarea')), true);
  report.checks.push('Keyboard/pointer toggles combine without closing; count, Escape focus return and composer identity/draft are preserved');

  await trigger.click();
  assert.equal(await menu.locator('small, .reply-style-scope').count(), 0);
  await option('Conversational').click();
  for (const [width, height] of [[1180, 860], [760, 620]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await page.waitForFunction(([width, height]) => {
      const box = document.querySelector('.reply-style-menu')?.getBoundingClientRect();
      return innerWidth === width && innerHeight === height && box && box.x >= 0 && box.y >= 0 && box.right <= width && box.bottom <= height;
    }, [width, height]);
    const box = await menu.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.mouse.move(2, 2);
    await page.screenshot({ path: `${output}/${width}-open.png` });
  }
  await menu.getByRole('button', { name: 'Close reply style', exact: true }).click();
  await menu.waitFor({ state: 'hidden' });
  await trigger.click(); await composer.click(); await menu.waitFor({ state: 'hidden' });
  await trigger.click();
  for (const name of ['Easier', 'Shorter']) await option(name).click();
  assert.equal(await trigger.getAttribute('aria-label'), 'Reply style: Default');
  assert.equal(await page.locator('.reply-style-count').count(), 0);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${output}/760-default.png` });
  assert.deepEqual(await app.evaluate(() => globalThis.replyStyleCommands), []);
  assert.equal(mock.requests.length, 0);
  report.checks.push('Wide/narrow popover fits; no helper copy; close/outside dismissal and all-off baseline work; interactions make zero IPC/provider requests');

  const sendSnapshot = async changes => {
    const snapshot = await page.evaluate(() => window.stomylos.command('snapshot'));
    Object.assign(snapshot.settings, changes.settings);
    Object.assign(snapshot.activity, changes.activity);
    await app.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send('stomylos:event', { type: 'snapshot', snapshot }), snapshot);
  };
  await trigger.click(); await option('Easier').click();
  await sendSnapshot({ activity: { storageError: 'Synthetic preview-only check' } });
  await menu.waitFor({ state: 'hidden' });
  assert.equal(await trigger.isDisabled(), true);
  await sendSnapshot({ activity: { storageError: null } });
  await trigger.click();
  assert.equal(await option('Easier').getAttribute('aria-checked'), 'true');
  await sendSnapshot({ settings: { simulation: false, development: false } });
  await trigger.waitFor({ state: 'hidden' });
  await menu.waitFor({ state: 'hidden' });
  report.checks.push('Disabling dismisses the portaled menu; non-simulation snapshot removes the entire control and open menu');

  await page.reload();
  await trigger.waitFor();
  assert.equal(await trigger.getAttribute('aria-label'), 'Reply style: Default');
  assert.equal(await composer.inputValue(), 'Keep this draft unchanged. 한글');
  assert.equal(mock.requests.length, 0);
  assert.deepEqual(report.errors, []);
  report.checks.push('Renderer reload resets only temporary style choices; saved draft survives; no runtime errors');
  report.status = 'passed';
} catch (error) {
  const failedPage = app?.windows()[0];
  if (failedPage) {
    await failedPage.screenshot({ path: `${output}/failure.png` }).catch(() => undefined);
    report.geometry = await failedPage.evaluate(() => ({ width: innerWidth, height: innerHeight,
      menu: document.querySelector('.reply-style-menu')?.getBoundingClientRect().toJSON() })).catch(() => undefined);
  }
  report.status = 'failed'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  report.mockRequests = mock.requests.length;
  await app?.close().catch(() => undefined);
  await new Promise(resolve => mock.server.close(resolve));
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
