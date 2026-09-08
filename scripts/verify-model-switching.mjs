// Native and packaged acceptance with synthetic dialogue and local HTTP only.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const require = createRequire(import.meta.url), packaged = process.argv.includes('--packaged');
const directory = mkdtempSync(join(tmpdir(), 'stomylos-partner-ui-'));
const output = `test-results/model-switching-${packaged ? 'packaged' : 'native'}`; mkdirSync(output, { recursive: true }); mkdirSync('test-results/ux-simplification', { recursive: true });
let routerFails = false, chatFails = false;
const chats = [], routes = [];
const delay = ms => new Promise(done => setTimeout(done, ms));
const mock = await startMockGateway({ routerHandler: async (input, response) => {
  routes.push(input); await delay(350);
  if (routerFails) { response.writeHead(503); response.end('Public router failure'); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ model: input.model, provider: 'OpenAI', choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify(Object.fromEntries(input.response_format.json_schema.schema.required.map(id => [id, id === 'model_03' ? 2 : 1])))
  } }], usage: { cost: 0 } }));
}, chatHandler: async (input, response) => {
  chats.push(input); response.writeHead(200, { 'content-type': 'text/event-stream' });
  const content = 'An ordinary reply continues the conversation about familiar places.\n\n'.repeat(16);
  response.write(`data: ${JSON.stringify({ model: input.model, provider: 'Public mock', choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
  await delay(450);
  response.end(`data: ${JSON.stringify({ model: input.model, provider: 'Public mock', choices: [{ delta: {}, finish_reason: chatFails ? 'length' : 'stop' }], usage: { total_tokens: 100, cost: 0 } })}\n\ndata: [DONE]\n\n`);
} });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint, ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const name of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY']) delete env[name];
let app, page, sessionId;
const report = { status: 'running', packaged, directory, checks: [], errors: [], paidRequests: 0 };
const cmd = (name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
const button = name => page.getByRole('button', { name, exact: true });
const view = () => cmd('loadSession', { sessionId });
async function wait(fn) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await delay(35); } throw new Error('Partner state did not settle'); }
const idle = () => wait(async () => (await cmd('snapshot')).activity.phase === 'idle');
async function launch() {
  app = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/model-switch-candidate/linux-unpacked/stomylos') : require('electron'), args: packaged ? [] : ['.'], env, chromiumSandbox: true, timeout: 20000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => report.errors.push(e.message));
  await button('Settings').waitFor(); await page.locator('.composer textarea').waitFor(); sessionId = (await cmd('snapshot')).unfinished.id;
}
async function close() { const exited = new Promise(done => app.process().once('exit', done)); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await exited; app = null; }
async function choose(id, keyboard = false) {
  const saved = JSON.parse((await view()).session.chat_config), label = id === null ? 'Automatic' : saved.characters.find(c => c.id === id).label;
  await page.locator('.partner').click();
  const option = page.getByRole('menuitemradio').filter({ has: page.locator('strong', { hasText: new RegExp('^' + label + '$') }) });
  if (keyboard) { await option.focus(); await page.keyboard.press('Enter'); } else await option.click();
  await wait(async () => (await view()).partner.pending?.choice === id);
  await page.getByText('Next reply', { exact: true }).waitFor();
}
async function send(text) {
  await page.locator('.composer textarea').fill(text); await button('Send').click();
  await wait(async () => (await cmd('snapshot')).activity.phase !== 'idle');
  assert.equal(await page.locator('.partner').isDisabled(), true); await idle();
}
try {
  await launch();
  await send('I enjoy returning to familiar places.');
  const first = await view(), original = first.partner.currentCharacter, originalModel = first.partner.currentModel;
  const selected = JSON.parse(first.session.chat_config).characters.find(c => c.id !== original);
  await page.locator('.composer textarea').fill('A preserved draft\n한글 and punctuation.');
  await page.locator('main').hover(); await page.mouse.wheel(0, -100000); await button('Go to latest message').waitFor();
  const top = await page.locator('main').evaluate(n => n.scrollTop);
  await choose(selected.id, true);
  await page.locator('[role="menu"]').waitFor({ state: 'hidden' });
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))));
  await page.screenshot({ path: 'test-results/ux-simplification/pending-partner.png' });
  assert.equal(chats.length, 1); assert.equal(routes.length, 1);
  assert.equal(await page.locator('.composer textarea').inputValue(), 'A preserved draft\n한글 and punctuation.');
  assert.ok(Math.abs(await page.locator('main').evaluate(n => n.scrollTop) - top) <= 2);
  await page.locator('.bookmark-toggle').click(); await wait(async () => (await view()).bookmarked);
  await send('What makes a familiar place feel different?');
  assert.equal(await page.locator('.partner-pending').count(), 0);
  assert.equal(chats[1].model, selected.model);
  assert.deepEqual(chats[1].messages.slice(1, chats[0].messages.length), chats[0].messages.slice(1));
  assert.deepEqual((await view()).memory.snapshot, first.memory.snapshot);
  assert.deepEqual((await view()).messages.slice(0, first.messages.length), first.messages);
  assert.equal((await view()).session.character, original);
  assert.equal(await page.locator('main article[aria-label="Partner"]').count(), 2);
  report.checks.push('Keyboard selection preserves draft, reader position, first reply, frozen memory and bookmarks; next Send uses the selected target with ordinary history and generic assistant labels');

  await choose(null); await close(); const before = mock.requests.length; await launch();
  assert.equal(mock.requests.length, before); assert.equal((await view()).partner.pending.choice, null);
  await send('Actually, I want to understand why this happens.');
  assert.equal(chats[2].model, originalModel); assert.notEqual(chats[2].model, selected.model); assert.equal(routes.length, 2);
  const packet = JSON.parse(routes[1].messages[1].content);
  assert.equal(packet.filter(m => m.role === 'user').length, 3);
  assert.equal(packet.at(-1).content, 'Actually, I want to understand why this happens.');
  assert.equal((await view()).partner.pending, null);
  report.checks.push('Pending Auto survives restart without dispatch, uses the three recent user turns and excludes the effective model');

  await choose(null); routerFails = true; await send('Let us consider another angle.');
  await button('Retry selection').waitFor(); assert.equal(chats.length, 3);
  await page.getByText('Selection incomplete', { exact: true }).waitFor();
  const failed = (await view()).requests.filter(r => r.role === 'router').at(-1);
  await close(); await launch(); await button('Retry selection').waitFor(); assert.equal(chats.length, 3);
  routerFails = false; await button('Retry selection').click(); await wait(async () => chats.length === 4); await idle();
  assert.notEqual(chats[3].model, originalModel);
  const retry = (await view()).requests.filter(r => r.role === 'router').at(-1);
  assert.equal(retry.parent_id, failed.id); assert.equal(retry.config, failed.config);
  report.checks.push('Failed Auto and restart send no chat; explicit Retry selection retains frozen source/config and still excludes the old model');

  chatFails = true; await send('I would like to continue this thought.'); await button('Retry reply').waitFor();
  const failedBody = chats.at(-1); await choose(original);
  await button('Retry reply').click(); await wait(async () => chats.length === 6); await idle();
  assert.deepEqual(chats[5], failedBody); await button('Use selected partner').waitFor();
  chatFails = false; await button('Use selected partner').click(); await wait(async () => chats.length === 7); await idle();
  assert.equal(chats[6].model, originalModel); assert.notEqual(chats[6].model, failedBody.model);
  const final = await view(); assert.equal(final.messages.filter(m => m.origin === 'learner').length, 5);
  assert.equal(final.bookmarked, true); assert.equal(final.partner.pending, null);
  assert.ok(final.requests.filter(r => r.role === 'chat' && r.status === 'failed').every(r => r.response_content));
  report.checks.push('Original Retry retains exact wire body despite pending selection; explicit replacement creates no duplicate learner bubble and retains failed partial attempts');

  await button('Conversation details').click();
  await page.getByRole('button', { name: /^Request details/ }).click();
  assert.ok(await page.getByText(`Requested: ${selected.model}`, { exact: false }).count());
  assert.ok(await page.getByText('Partner reselection', { exact: true }).count());
  await page.keyboard.press('Escape');
  report.checks.push('Conversation details distinguish requested models and reselection attempts');
  await page.locator('.composer textarea').fill('A final unsent draft.'); await close(); const stopped = mock.requests.length; await launch();
  assert.equal(mock.requests.length, stopped); assert.equal(await page.locator('.composer textarea').inputValue(), 'A final unsent draft.');
  assert.equal((await view()).partner.currentModel, originalModel);
  await button('End chat').click(); await page.locator('.ended-footer').waitFor();
  await wait(async () => (await view()).session.analysis_state === 'completed' && (await view()).memory.job.state === 'completed');
  const ended = await view(); assert.equal(ended.units.length, 5);
  assert.deepEqual(ended.units.map(u => u.source_message_id), ended.messages.filter(m => m.origin === 'learner').map(m => m.id));
  assert.equal(await page.locator('.partner').count(), 0);
  report.checks.push('Restart preserves effective target and unsent draft; End creates exactly five grammar sources once and removes partner editing');
  await button('New chat').click(); await page.locator('.composer textarea').waitFor(); sessionId = (await cmd('snapshot')).unfinished.id;
  if ((await view()).session.opening_kind === 'starter') await button('Start with your own topic').click();
  await send('A direct opening about something new.'); await choose('model_01'); await send('Continue my own topic.');
  assert.equal(chats.at(-1).model, selected.model);
  report.checks.push('Direct entry also supports next-Send switching through the ordinary conversation flow');
  assert.deepEqual(report.errors, []); await close(); report.status = 'passed';
  report.chatCalls = chats.length; report.routerCalls = routes.length;
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  report.status = 'failed'; report.failure = String(error); writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2));
  if (page && !page.isClosed()) { await page.screenshot({ path: `${output}/failure.png` }); console.error(await page.locator('body').innerText()); }
  app?.process().kill('SIGTERM'); throw error;
} finally { await app?.close().catch(() => undefined); await new Promise(done => mock.server.close(done)); }
