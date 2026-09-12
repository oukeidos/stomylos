// Focused history preview acceptance using disposable data and local mock inference.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const directory = mkdtempSync('/tmp/stomylos-history-preview-');
const output = 'test-results/history-preview'; mkdirSync(output, { recursive: true });
const mock = await startMockGateway({ delay: 0 });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
const report = { status: 'running', paidRequests: 0, checks: [], errors: [] };
let app, page;
const command = (name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
const button = name => page.getByRole('button', { name, exact: true });
const subtitle = () => page.locator('.history-item[aria-current="page"] .history-meta small');
async function wait(fn) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Timed out waiting for history'); }
try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.'], env, chromiumSandbox: true });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', error => report.errors.push(error.message));
  await button('Settings').waitFor();
  const snapshot = await command('snapshot');
  const id = snapshot.unfinished.id;
  await command('setMemoryPreference', { enabled: false, revision: snapshot.settings.memory.revision });
  if (!await page.locator('#conversation-sidebar').isVisible()) await button('Show history').click();
  await wait(async () => await subtitle().textContent() === 'New chat');
  await command('selectPartner', { sessionId: id, character: 'model_04' });
  await command('searchMode', { sessionId: id, mode: 'off' });
  const text = 'Last input\n안녕 👋 <b>literal</b> ' + 'unbroken'.repeat(90);
  await command('sendMessage', { sessionId: id, text, revision: 1 });
  await wait(async () => (await command('snapshot')).activity.phase === 'idle' && (await command('loadSession', { sessionId: id })).messages.at(-1).delivery === 'complete');
  await wait(async () => await subtitle().textContent() === 'In progress');
  await button('End chat').click();
  await button('Delete chat').waitFor();
  await page.locator('.end-processing-dialog').waitFor({ state: 'hidden' });
  const normalized = text.replace(/\s+/gu, ' ').trim();
  await wait(async () => await subtitle().textContent() === normalized);
  assert.equal(await subtitle().locator('b').count(), 0);
  assert.equal((await command('snapshot')).sessions.find(s => s.id === id).lastUserInput, text);
  await button('Bookmark chat').click(); await button('Remove bookmark').waitFor();
  const filterSwitch = page.getByRole('switch', { name: 'Show bookmarked chats only' });
  assert.equal(await page.locator('.history-filters').count(), 0);
  await filterSwitch.focus(); await page.keyboard.press('Space');
  assert.equal(await filterSwitch.getAttribute('aria-checked'), 'true');
  await wait(async () => await subtitle().textContent() === normalized);
  assert.equal((await command('listSessions', { offset: 0, filter: 'bookmarked' })).sessions[0].lastUserInput, text);
  await button('Reports').click();
  await wait(async () => await filterSwitch.count() === 0);
  await button('Chats').click();
  assert.equal(await filterSwitch.getAttribute('aria-checked'), 'true');
  await wait(async () => await subtitle().textContent() === normalized);
  await button('Remove bookmark').click();
  await page.getByText('No bookmarked chats yet.', { exact: true }).waitFor();
  await filterSwitch.focus(); await page.keyboard.press('Enter');
  assert.equal(await filterSwitch.getAttribute('aria-checked'), 'false');
  await wait(async () => await subtitle().textContent() === normalized);
  for (const width of [1180, 760]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 720), width);
    const switchLayout = await filterSwitch.evaluate(node => {
      const tabs = node.closest('.library-tabs'), reports = tabs.querySelector('.learning-nav');
      const a = node.getBoundingClientRect(), b = reports.getBoundingClientRect(), c = tabs.getBoundingClientRect();
      return { sameRow: Math.abs(a.top - b.top) < 1, separated: a.left >= b.right, fits: a.right <= c.right, noOverflow: tabs.scrollWidth <= tabs.clientWidth };
    });
    assert.deepEqual(switchLayout, { sameRow: true, separated: true, fits: true, noOverflow: true });
    const layout = await subtitle().evaluate(node => {
      const row = node.closest('.history-row'), date = row.querySelector('time'), menu = row.querySelector('.history-more');
      const rect = element => element.getBoundingClientRect();
      return { clipped: node.scrollWidth > node.clientWidth, ellipsis: getComputedStyle(node).textOverflow,
        nowrap: getComputedStyle(node).whiteSpace, dateVisible: rect(date).width > 0 && rect(date).right <= rect(menu).left,
        noOverflow: row.scrollWidth <= row.clientWidth, focusable: node.tabIndex >= 0 };
    });
    assert.deepEqual(layout, { clipped: true, ellipsis: 'ellipsis', nowrap: 'nowrap', dateVisible: true, noOverflow: true, focusable: false });
    await page.screenshot({ path: `${output}/${width}.png` });
  }
  report.checks.push('Draft → active → ended subtitle refresh', 'Snapshot and filtered IPC retain exact source input', 'Bookmark switch: Space/Enter, Reports hide/Chats retain, empty bookmarks and All recovery, single toolbar row', 'Literal multiline Korean/emoji and long text, ellipsis, date/menu visibility, no added tab stop at 1180 and 760 widths');
  assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.errors.push(error.stack); process.exitCode = 1; }
finally { if (app) await app.close(); mock.server.closeAllConnections(); await new Promise(resolve => mock.server.close(resolve)); writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
