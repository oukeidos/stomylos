// Focused header actions on disposable data and a local mock provider.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const directory = mkdtempSync('/tmp/stomylos-chat-actions-');
const output = 'test-results/chat-actions'; mkdirSync(output, { recursive: true });
const report = { status: 'running', paidRequests: 0, checks: [], errors: [] };
const mock = await startMockGateway({ delay: 0 });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
let app, page;
const command = (name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
const button = name => page.getByRole('button', { name, exact: true });
async function wait(fn) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Timed out waiting for mock chat'); }
try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.'], env, chromiumSandbox: true });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', error => report.errors.push(error.message));
  await button('Settings').waitFor();
  const id = (await command('snapshot')).unfinished.id;
  assert.equal(await button('Delete chat').count(), 0);
  assert.equal(await button('End chat').count(), 1);
  assert.equal(await button('Chat options').count(), 0);
  await command('selectPartner', { sessionId: id, character: 'model_04' });
  await command('searchMode', { sessionId: id, mode: 'off' });
  await command('sendMessage', { sessionId: id, text: 'I enjoy visiting quiet museums.', revision: 1 });
  await wait(async () => (await command('snapshot')).activity.phase === 'idle' && (await command('loadSession', { sessionId: id })).messages.at(-1).delivery === 'complete');
  await button('End chat').click();
  await button('Delete chat').waitFor();
  await page.locator('.end-processing-dialog').waitFor({ state: 'hidden' });
  assert.equal(await button('End chat').count(), 0);
  assert.equal(await button('Conversation details').count(), 1);
  assert.equal(await button('Processing details').count(), 0);
  await button('Bookmark chat').click(); await button('Remove bookmark').waitFor();
  await button('Conversation details').click();
  await page.getByRole('dialog', { name: 'Conversation details', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  for (const width of [1180, 760]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 720), width);
    assert.equal(await page.locator('.chat-navigation').evaluate(node => node.scrollWidth > node.clientWidth), false);
    await page.screenshot({ path: `${output}/${width}.png` });
  }
  await button('Delete chat').focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Delete this chat?', exact: true });
  await dialog.waitFor(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await command('loadSession', { sessionId: id })).session.id, id);
  await button('Delete chat').click();
  await dialog.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await assert.rejects(command('loadSession', { sessionId: id }));
  report.checks.push('Open chat has End; closed chat has Delete; duplicate detail routes and header menu are absent', 'Bookmark and single details route work; wide/narrow header fits', 'Keyboard Delete opens confirmation; Cancel preserves chat; confirmed deletion removes only the test chat');
  assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.errors.push(error.stack); process.exitCode = 1; }
finally { if (app) await app.close(); mock.server.closeAllConnections(); await new Promise(resolve => mock.server.close(resolve)); writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
