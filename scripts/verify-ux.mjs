// Isolated current Settings/navigation acceptance; all injected data is synthetic.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';

const directory = mkdtempSync('/tmp/stomylos-ux-');
const output = 'test-results/ux-simplification'; mkdirSync(output, { recursive: true });
const mock = await startMockGateway({ delay: 5 });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
const report = { status: 'running', directory, paidRequests: 0, checks: [], errors: [], geometry: [] };
let app, page;
const button = name => page.getByRole('button', { name, exact: true });
const tab = name => page.getByRole('tab', { name, exact: true });
const command = (name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
const settle = async () => page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))));
async function size(width, height) {
  await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), [width, height]); await settle();
}
async function capture(name) { await page.mouse.move(2, 2); await settle(); await page.screenshot({ path: `${output}/${name}.png` }); }
async function memoryEvent() { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('stomylos:event', { type: 'memory-changed', characterId: 'shared', revision: 0 })); }

try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.'], env, chromiumSandbox: true, timeout: 20000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', error => report.errors.push(error.message));
  await button('Settings').waitFor(); await page.locator('.composer textarea').waitFor();
  const sessionId = (await command('snapshot')).unfinished.id;
  const draft = 'Keep this exact draft. 한글'; const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
  await composer.fill(draft); await page.getByText('Draft saved', { exact: true }).waitFor();
  await page.evaluate(() => { window.uxComposer = document.querySelector('.composer textarea'); });
  for (const [width, height] of [[1180, 860], [760, 620]]) {
    await size(width, height);
    for (const expanded of [false, true]) {
      if (await button(expanded ? 'Show history' : 'Hide history').count()) await button(expanded ? 'Show history' : 'Hide history').click();
      const bounds = await page.evaluate(() => {
        const names = ['New chat', 'End chat', 'Settings'];
        return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
          actions: names.map(name => { const n = document.querySelector(`button[aria-label="${name}"]`), r = n.getBoundingClientRect(); return { name, x: r.x, y: r.y, width: r.width, height: r.height, inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, restingLabelVisible: n.querySelector('[role=tooltip]') && getComputedStyle(n.querySelector('[role=tooltip]')).visibility === 'visible' }; }) };
      });
      assert.equal(bounds.overflow, false); assert.ok(bounds.actions.every(a => a.inside && a.width >= 36 && a.height >= 36));
      assert.ok(bounds.actions.find(a => a.name === 'New chat').x < bounds.actions.find(a => a.name === 'End chat').x);
      report.geometry.push({ expanded, ...bounds }); await capture(`${width}-${expanded ? 'expanded' : 'collapsed'}`);
    }
    await button('Settings').click();
    for (const name of ['Voice', 'Memory', 'Connection & data']) {
      await tab(name).click(); if (name === 'Memory') await page.locator('.current-memory').waitFor();
      const r = await page.locator('.settings-dialog').boundingBox(); assert.ok(r.width > 510 && r.x >= 0 && r.y >= 0 && r.x + r.width <= width + 1 && r.y + r.height <= height + 1);
      assert.equal(await page.evaluate(() => document.querySelector('.settings-panel:not([hidden])').scrollWidth > document.querySelector('.settings-panel:not([hidden])').clientWidth), false);
      await capture(`${width}-settings-${name.split(' ')[0].toLowerCase()}`);
    }
    assert.equal(await tab('Usage').count(), 0); assert.equal(await button('Done').count(), 0); assert.equal(await button('Help').count(), 0);
    await button('Close settings').click();
    assert.equal(await button('Settings').evaluate(n => n === document.activeElement), true);
    assert.equal(await composer.inputValue(), draft); assert.equal(await page.evaluate(() => window.uxComposer === document.querySelector('.composer textarea')), true);
  }
  await button('New chat').focus();
  assert.equal(await button('New chat').getByRole('tooltip').isVisible(), true);
  await page.keyboard.press('Escape'); assert.equal(await button('New chat').getByRole('tooltip').isVisible(), false);
  await button('Chat options').click();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Conversation details', 'Delete chat']); await page.keyboard.press('Escape');
  await page.locator('[data-history-filter=bookmarked]').click(); await page.getByText('No bookmarked chats yet.', { exact: true }).waitFor();
  assert.equal(await button('Show all chats').count(), 0); await capture('empty-bookmarks');
  await button('New chat').click(); await page.getByRole('dialog', { name: 'Start a new chat?' }).waitFor(); await page.keyboard.press('Escape');
  assert.equal(await composer.inputValue(), draft); assert.equal(await page.locator('[data-history-filter=bookmarked]').getAttribute('aria-pressed'), 'true');
  report.checks.push('Wide/narrow, open/collapsed navigation, directly visible icon actions, tooltips, no duplicate menu routes, empty bookmarks and cancel preserve the same composer');

  await button('Settings').click(); await tab('Voice').click(); await tab('Voice').focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await tab('Memory').getAttribute('aria-selected'), 'true'); await page.locator('.current-memory').waitFor();
  await page.keyboard.press('F8'); assert.equal((await command('asrSnapshot')).records.length, 0);
  await page.keyboard.press('End'); assert.equal(await tab('Connection & data').getAttribute('aria-selected'), 'true');
  await button('Clear saved speech').click(); await button('Keep speech').click();
  assert.equal(mock.requests.length, 0); await button('Close settings').click();
  report.checks.push('Settings keyboard tabs, Escape/focus restoration, F8 exclusion and cancelled audio cleanup make no provider calls');

  // Instrument only this isolated test process. Exercise real renderer read races
  // and errors without adding a test escape hatch to product code.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('stomylos:command');
    globalThis.uxIPC = { original, mode: 'actual', held: [], calls: 0, serial: 1, count: 1 };
    ipcMain.removeHandler('stomylos:command');
    ipcMain.handle('stomylos:command', async (...args) => {
      const state = globalThis.uxIPC;
      if (state.settingFailure && args[1] === 'speechMode') return { ok: false, error: 'speech_preferences_invalid' };
      if (state.keyFailure && args[1] === 'refreshKey') return { ok: false, error: 'key_file_unreadable' };
      if (state.maintenance && args[1] === 'loadSession') {
        const result = await original(...args);
        if (result.ok) {
          result.value.memory.job = { state: 'pending', created_at: new Date().toISOString(), character_id: 'shared' };
          result.value.memory.blockedBy = state.blocked ? 'earlier-public-chat' : null;
          result.value.renewal = { state: 'failed', accepted_count: 0, attempts: [] };
        }
        return result;
      }
      if (state.maintenance && args[1] === 'retryMemory') { state.retryTarget = args[2].sessionId; return { ok: true }; }
      if (args[1] !== 'currentMemory' || state.mode === 'actual') return original(...args);
      state.calls++;
      if (state.mode === 'failure') return { ok: false, error: 'memory_document_hash' };
      const value = { character_id: 'shared', revision: state.serial, traits: Array.from({ length: state.count }, (_, i) => ({ id: `fixture-${i}`, text: state.count === 1 ? `Public memory revision ${state.serial}` : `Public memory ${i + 1}: Enjoys quiet walks, reading, and practicing English in everyday conversations.` })), relationships: [], experiences: [], intentions: [] };
      if (state.mode === 'hold') return new Promise(resolve => state.held.push(() => resolve({ ok: true, value })));
      return { ok: true, value };
    });
  });
  await app.evaluate(() => { globalThis.uxIPC.settingFailure = true; globalThis.uxIPC.keyFailure = true; });
  await button('Settings').click(); await tab('Voice').click(); await page.getByRole('checkbox', { name: 'Automatic speech', exact: true }).click();
  await page.getByText('Speech preferences are unreadable.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Automatic speech', exact: true }).isChecked(), false);
  await tab('Connection & data').click(); await button('Reload key status').click();
  await page.getByText('The key file could not be read.', { exact: false }).waitFor();
  await button('Close settings').click();
  await app.evaluate(() => { globalThis.uxIPC.settingFailure = false; globalThis.uxIPC.keyFailure = false; });
  report.checks.push('Failed preference writes retain the committed checkbox; key reload errors remain distinct from missing credentials');
  await app.evaluate(() => { globalThis.uxIPC.mode = 'failure'; });
  await button('Settings').click(); await tab('Memory').click(); await button('Retry loading memory').waitFor();
  assert.equal(await page.getByText('Nothing recorded.', { exact: true }).count(), 0);
  await app.evaluate(() => { globalThis.uxIPC.mode = 'hold'; }); await button('Retry loading memory').click();
  await app.evaluate(async () => { while (!globalThis.uxIPC.held.length) await new Promise(r => setTimeout(r, 10)); });
  await app.evaluate(() => { globalThis.uxIPC.serial = 2; globalThis.uxIPC.mode = 'value'; }); await memoryEvent();
  await page.getByText('Public memory revision 2', { exact: true }).waitFor();
  await app.evaluate(() => { globalThis.uxIPC.held.splice(0).forEach(release => release()); }); await settle();
  assert.equal(await page.getByText('Public memory revision 1', { exact: true }).count(), 0);
  await app.evaluate(() => { globalThis.uxIPC.mode = 'hold'; globalThis.uxIPC.serial = 3; }); await memoryEvent();
  await app.evaluate(async () => { while (!globalThis.uxIPC.held.length) await new Promise(r => setTimeout(r, 10)); });
  await tab('Voice').click(); await app.evaluate(() => { globalThis.uxIPC.held.splice(0).forEach(release => release()); globalThis.uxIPC.mode = 'actual'; });
  await tab('Memory').click(); await page.locator('.current-memory').waitFor(); assert.equal(await page.getByText('Public memory revision 3', { exact: true }).count(), 0);
  await app.evaluate(() => { globalThis.uxIPC.mode = 'value'; globalThis.uxIPC.count = 60; }); await memoryEvent();
  await page.getByText('Public memory 60:', { exact: false }).waitFor();
  assert.equal(await page.locator('.settings-panel:not([hidden])').evaluate(n => n.scrollHeight > n.clientHeight), true);
  await capture('long-memory');
  await page.locator('.settings-panel:not([hidden])').evaluate(n => { n.scrollTop = n.scrollHeight; });
  assert.ok((await button('Close settings').boundingBox()).y < 100);
  await button('Close settings').click();
  await command('endSession', { sessionId });
  await app.evaluate(({ BrowserWindow }, id) => { globalThis.uxIPC.mode = 'actual'; globalThis.uxIPC.maintenance = true; globalThis.uxIPC.blocked = true; BrowserWindow.getAllWindows()[0].webContents.send('stomylos:event', { type: 'session-changed', sessionId: id, revision: 1000 }); }, sessionId);
  await button('Review updates').waitFor(); assert.equal(await page.locator('.maintenance-summary').count(), 1); await capture('maintenance-blocker');
  await button('Review updates').click(); await button('Open earlier chat').waitFor(); assert.equal(await page.getByRole('button', { name: /^Shared memory/ }).getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }, id) => { globalThis.uxIPC.blocked = false; BrowserWindow.getAllWindows()[0].webContents.send('stomylos:event', { type: 'session-changed', sessionId: id, revision: 1001 }); }, sessionId);
  await page.getByText('Memory update pending · Starter renewal needs attention', { exact: true }).waitFor(); await button('Review updates').click();
  await button('Retry memory update').click(); assert.equal(await app.evaluate(() => globalThis.uxIPC.retryTarget), sessionId);
  await page.getByRole('button', { name: /^Starter renewal/ }).click(); await button('Try starter renewal again').waitFor(); await page.keyboard.press('Escape');
  report.checks.push('Pending memory and starter failure share one summary; blocker/retry routes remain explicit and target the selected chat');
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('stomylos:command'); ipcMain.handle('stomylos:command', globalThis.uxIPC.original); delete globalThis.uxIPC; });
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('stomylos:event', { type: 'session-changed', sessionId: id, revision: 1002 }), sessionId);
  await button('Review updates').waitFor({ state: 'hidden' });
  assert.equal(mock.requests.length, 0);
  report.checks.push('Memory loading/error/retry, event refresh, superseded read and hidden-tab race are verified through the real Settings renderer');

  await button('Chat options').click(); await page.getByRole('menuitem', { name: 'Conversation details', exact: true }).click();
  await page.getByRole('button', { name: /^Shared memory/ }).click(); await button('Open shared memory').click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1); assert.equal(await tab('Memory').getAttribute('aria-selected'), 'true');
  await page.locator('.current-memory').waitFor(); await page.keyboard.press('Escape'); await button('Settings').waitFor();
  await command('deleteSession', { sessionId });
  await page.getByText('No conversation selected. Start a new chat when you are ready.', { exact: true }).waitFor();
  await button('Settings').click(); await tab('Memory').click(); await page.locator('.current-memory').waitFor();
  assert.equal(await button('End chat').count(), 0); assert.equal(mock.requests.length, 0);
  report.checks.push('Conversation details opens current memory without nested dialogs; current memory remains available with no selected or saved conversation');
  assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) {
  report.error = String(error); if (page && !page.isClosed()) { await capture('failure'); console.error(await page.locator('body').innerText()); } throw error;
} finally {
  await app?.close().catch(() => undefined); await new Promise(resolve => mock.server.close(resolve));
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
