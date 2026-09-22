import { closeNative } from './native-lifecycle.mjs';
// Focused native acceptance with disposable data and a gated local mock update.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';

const directory = mkdtempSync('/tmp/stomylos-memory-history-');
const output = 'test-results/memory-history'; mkdirSync(output, { recursive: true });
let releaseUpdate, updateNumber = 0, app, page;
const gate = new Promise(resolve => { releaseUpdate = resolve; });
const report = { status: 'running', directory, paidRequests: 0, checks: [], errors: [] };
const mock = await startMockGateway({ delay: 0, memoryHandler: async (body, response) => {
  const add=++updateNumber===1 ? ['Prefers quiet museums.','Visits museums with a friend.'] : ['Visited a quiet museum.','Enjoys astronomy.'];
  if (updateNumber === 2) await gate;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ model: body.model, provider: 'Google AI Studio', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({add}) } }], usage: { cost: 0 } }));
} });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
const command = (name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
const button = name => page.getByRole('button', { name, exact: true });
async function wait(fn, label) {
  const until = Date.now() + 15000;
  while (Date.now() < until) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(label);
}
async function begin(text) {
  const snapshot = await command('snapshot'), id = snapshot.unfinished?.id ?? await command('newSession');
  await command('selectPartner', { sessionId: id, character: 'model_03' });
  await command('searchMode', { sessionId: id, mode: 'off' });
  await command('sendMessage', { sessionId: id, text, revision: 1 });
  await wait(async () => (await command('loadSession', { sessionId: id })).messages.at(-1).delivery === 'complete' && (await command('snapshot')).activity.phase === 'idle', 'Reply did not finish');
  return id;
}
try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.'], env, chromiumSandbox: true, timeout: 20000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', error => report.errors.push(error.message));
  await button('Settings').waitFor();
  const first = await begin('I prefer quiet museums and visit them with a friend.');
  await command('endSession', { sessionId: first });
  await wait(async () => (await command('loadSession', { sessionId: first })).memory.addJobs?.every(job=>job.state==='completed'), 'First history did not complete');
  const second = await begin('I visited a quiet museum. Forget the friend detail. I enjoy astronomy.');
  await command('endSession', { sessionId: second });
  await wait(async () => (await command('loadSession', { sessionId: second })).memory.job?.state === 'running', 'Second update did not start');
  const modal = page.locator('.end-processing-dialog');
  await modal.waitFor();
  await modal.locator('.end-stage-state.running').first().waitFor();
  assert.equal(await modal.getByRole('heading').evaluate(node => node === document.activeElement), true);
  assert.equal(await modal.getByRole('img',{name:'Working',exact:true}).count(),1);
  assert.equal(await page.locator('.app').evaluate(node => node.inert), true);
  assert.equal(await page.locator('.new-chat').isDisabled(), true);
  await page.keyboard.press('Escape'); assert.equal(await modal.isVisible(), true);
  await page.mouse.click(8, 100); assert.equal(await modal.isVisible(), true);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await modal.evaluate(node => node.contains(document.activeElement)), true);
  }
  assert.equal(await modal.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
  for (const [width, height] of [[1180, 860], [760, 620]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    assert.equal(await modal.evaluate(node => node.scrollWidth > node.clientWidth), false);
    await page.screenshot({ path: `${output}/processing-${width}.png` });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await modal.locator('.end-spinner').first().evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  report.checks.push('Automatic live modal blocks background and New chat; Escape/outside click cannot dismiss; keyboard stays inside; wide/narrow layout and reduced motion pass');
  releaseUpdate();
  await modal.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.app').evaluate(node => node.inert), false);
  assert.equal(await button('New chat').isEnabled(), true);
  if (await button('Show history').count()) await button('Show history').click();
  const snapshot = await command('snapshot');
  await page.locator('.history-item').nth(snapshot.sessions.findIndex(session => session.id === second)).click();
  await button('Conversation details').click();
  await page.getByRole('button', { name: /^Shared memory/ }).click();
  await button('Changes from this chat').click();
  await page.getByRole('heading',{name:'Session memory · completed'}).waitFor();
  const changes=page.locator('.memory-changes');
  assert.match(await changes.innerText(),/Visited a quiet museum\./);assert.match(await changes.innerText(),/Enjoys astronomy\./);
  report.checks.push('Completion unlocks the app and shows persisted session additions with source history');
  for (const [width, height] of [[1180, 860], [760, 620]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(animation => animation.finished.catch(() => {}))));
    assert.equal(await page.locator('.memory-changes').evaluate(node => node.scrollWidth > node.clientWidth), false);
    await page.screenshot({ path: `${output}/${width}.png` });
  }
  await button('Changes from this chat').focus(); await page.keyboard.press('Enter');
  assert.equal(await button('Changes from this chat').getAttribute('aria-expanded'), 'false');
  await page.keyboard.press('Enter'); assert.equal(await button('Changes from this chat').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: 'Conversation details' }).waitFor({ state: 'hidden' });
  report.checks.push('Wide/narrow layouts have no horizontal overflow; keyboard toggles history and Escape closes details');
  assert.deepEqual(report.errors, []);
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await closeNative(app); await exited; app = null;
  report.status = 'passed';
} finally {
  releaseUpdate(); if (app) await app.close(); mock.server.close();
  writeFileSync(`${output}/result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
