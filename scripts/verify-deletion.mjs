// Real history menus, confirmation, SQLite deletion and restart using invented data.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const packaged = process.argv.includes('--packaged');
const directory = mkdtempSync(join(tmpdir(), 'stomylos-deletion-ui-'));
const mock = await startMockGateway({ delay: 0 });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint, ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
let application; const errors = []; const checks = [];
const command = (page, name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
async function launch() {
  application = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/linux-unpacked/stomylos') : createRequire(import.meta.url)('electron'), args: packaged ? [] : ['.'], env, chromiumSandbox: true, timeout: 20000 });
  const page = await application.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor(); return page;
}
async function wait(fn) {
  const until = Date.now() + 20000;
  while (Date.now() < until) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error('State did not settle');
}
async function close(page) {
  const exited = new Promise(resolve => application.process().once('exit', resolve));
  await command(page, 'close'); await exited; application = null;
}
try {
  let page = await launch();
  const id = (await command(page, 'snapshot')).unfinished.id;
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: 'Delete chat', exact: true }).getAttribute('aria-disabled'), 'true');
  await page.keyboard.press('Escape');
  await command(page, 'sendMessage', { sessionId: id, text: 'I enjoy visiting quiet museums.', revision: 1 });
  await wait(async () => (await command(page, 'snapshot')).activity.phase === 'idle');
  await command(page, 'endSession', { sessionId: id });
  await wait(async () => { const v = await command(page, 'loadSession', { sessionId: id }); return v.session.analysis_state === 'completed' && v.memory.job?.state === 'completed' && v.renewal?.state === 'completed'; });
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete chat', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this chat?' }); await dialog.waitFor();
  assert.ok((await dialog.innerText()).includes('Shared memory already learned'));
  mkdirSync('test-results', { recursive: true });
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))));
  await page.screenshot({ path: `test-results/deletion-${packaged ? 'packaged' : 'native'}.png` });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await command(page, 'loadSession', { sessionId: id })).session.id, id);
  checks.push('Unfinished deletion disabled; confirmation cancellation preserves history');
  if (!await page.locator('aside').isVisible()) await page.getByRole('button', { name: 'Show history', exact: true }).click();
  await page.locator('.history-row').first().getByRole('button', { name: /^Options for/ }).click();
  await page.getByRole('menuitem', { name: 'Delete chat', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await command(page, 'snapshot')).sessions.some(s => s.id === id), false);
  await page.getByText('No conversation selected.', { exact: false }).waitFor();
  checks.push('History menu deletes the selected chat and handles the empty state');
  await page.getByRole('button', { name: 'Start another chat', exact: true }).click();
  const next = (await command(page, 'snapshot')).unfinished.id;
  await command(page, 'saveDraft', { sessionId: next, text: 'Preserved draft.', revision: 2 });
  // Cross the 40-row history boundary, then delete its last older-page item.
  for (let i = 0; i < 41; i++) {
    const current = (await command(page, 'snapshot')).unfinished?.id ?? await command(page, 'newSession');
    await command(page, 'endSession', { sessionId: current });
  }
  const active = await command(page, 'newSession');
  await page.getByRole('button', { name: 'Older', exact: true }).click();
  await wait(async () => await page.locator('.history-row').count() === 2);
  await page.locator('.history-row').last().getByRole('button', { name: /^Options for/ }).click();
  await page.getByRole('menuitem', { name: 'Delete chat', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete chat', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await wait(async () => await page.locator('.history-row').count() === 1);
  assert.equal((await command(page, 'snapshot')).unfinished.id, active);
  checks.push('Older-page deletion refreshes pagination and preserves unrelated current chat');
  await close(page); page = await launch();
  const snapshot = await command(page, 'snapshot');
  assert.equal(snapshot.sessions.some(s => s.id === id), false); assert.equal(snapshot.unfinished.id, active);
  assert.equal(!!snapshot.activity.deletionCleanupPending, false);
  await close(page); checks.push('Packaged or native restart retains deletion with no pending file cleanup');
  assert.deepEqual(errors, []);
  const report = { status: 'passed', packaged, directory, checks, errors, paidRequests: 0 };
  writeFileSync(`test-results/deletion-${packaged ? 'packaged' : 'native'}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { console.error(error); if (application) { const page = await application.firstWindow(); console.error(await page.locator('body').innerText()); await page.screenshot({ path: 'test-results/deletion-failure.png' }); } throw error; } finally { await application?.close().catch(() => undefined); await new Promise(resolve => mock.server.close(resolve)); }
