// Isolated native acceptance: current selectable contributions, saved identity and search evidence.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';

const packaged = process.argv.includes('--packaged');
const directory = mkdtempSync('/tmp/stomylos-models-native-');
const output = `test-results/models-${packaged ? 'packaged' : 'native'}`;
mkdirSync(output, { recursive: true });
const runtime = JSON.parse(readFileSync('src/main/runtime-config.json', 'utf8'));
const selected = runtime.conversation.characters;
const mock = await startMockGateway({
  searchHandler: async (body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ model: body.model, provider: 'Public mock', choices: [{ delta: { content: '{"search":true}' }, finish_reason: 'stop' }], usage: { cost: 0 } })}\n\ndata: [DONE]\n\n`);
  },
  chatHandler: async (body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const content = 'A public scene: music from the next room and a cup cooling on the table.';
    const delta = { content, ...(body.tools ? { annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.org/public-source', title: 'Public source' } }] } : {}) };
    response.end(`data: ${JSON.stringify({ model: body.model, provider: 'Public mock', choices: [{ delta, finish_reason: 'stop' }], usage: { cost: 0, ...(body.tools ? { server_tool_use_details: { web_search_requests: 1 } } : {}) } })}\n\ndata: [DONE]\n\n`);
  }
});
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint, ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
let app, page;
const errors = [], checks = [], sessions = [];
const cmd = (name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
const button = name => page.getByRole('button', { name, exact: true });
const input = () => page.getByRole('textbox', { name: 'Your message', exact: true });
async function poll(fn) { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Native state did not settle'); }
async function launch() {
  app = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/linux-unpacked/stomylos') : createRequire(import.meta.url)('electron'), args: packaged ? [] : ['.'], env, chromiumSandbox: true });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await button('Partner: Automatic').waitFor();
}
async function close() {
  const ended = new Promise(r => app.process().once('exit', r));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await ended; app = null;
}
try {
  await launch();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 620));
  await input().fill('An exact unsent draft.\n한국어');
  await button('Partner: Automatic').click();
  assert.equal(await page.getByRole('menuitemradio').count(), selected.length + 1);
  assert.deepEqual(await page.getByRole('menuitemradio').locator('strong').allTextContents(), ['Automatic', ...selected.map(partner => partner.label)]);
  await page.keyboard.press('End');
  await poll(() => page.evaluate(label => document.activeElement.textContent.includes(label), selected.at(-1).label));
  const item = await page.getByRole('menuitemradio').last().boundingBox();
  assert.ok(item.y >= 0 && item.y + item.height <= 620);
  await page.locator('.partner-menu').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  await page.screenshot({ path: `${output}/menu-minimum.png` });
  await page.keyboard.press('Home'); await page.keyboard.type('Imagine');
  await poll(() => page.evaluate(() => document.activeElement.textContent.includes('Imagine')));
  await page.keyboard.press('Enter'); await button('Partner: Imagine').waitFor();
  assert.equal(await input().inputValue(), 'An exact unsent draft.\n한국어');
  await button('Partner: Imagine').click(); await page.getByRole('menuitemradio', { name: /^Automatic/ }).click();
  checks.push('Current roster plus Automatic; minimum-size keyboard End/Home/typeahead and visible last row; exact draft survives selection');
  for (const kind of ['starter', 'user']) for (const partner of selected) {
    const snapshot = await cmd('snapshot'); let id = snapshot.unfinished?.id;
    if (!id) id = await cmd('newSession');
    const before = await cmd('loadSession', { sessionId: id });
    await cmd('setOpening', { sessionId: id, operationId: crypto.randomUUID(), expectedRevision: before.session.opening_revision, kind });
    await button('Partner: Automatic').click(); await page.getByRole('menuitemradio', { name: new RegExp('^' + partner.label + '\\b') }).click();
    await button(`Partner: ${partner.label}`).waitFor();
    const mode = kind === 'starter' ? 'auto' : 'off';
    await cmd('searchMode', { sessionId: id, mode });
    const text = `${partner.label}: a public ${kind} invitation. 한국어`;
    await input().fill(text); await page.getByRole('button', { name: /^Send/ }).click();
    await poll(async () => (await cmd('loadSession', { sessionId: id })).messages.at(-1)?.delivery === 'complete' && (await cmd('loadSession', { sessionId: id })).messages.at(-1)?.origin === 'model');
    const view = await cmd('loadSession', { sessionId: id });
    assert.equal(view.session.character, partner.id); assert.equal(view.session.model, partner.model);
    assert.equal(JSON.parse(view.session.chat_config).version, runtime.conversation.version);
    await button(`Partner: ${partner.label}`).waitFor();
    const body = mock.requests.findLast(r => r.stream && r.model === partner.model && !r.response_format);
    assert.deepEqual(body.reasoning, partner.reasoning); assert.equal(!!body.tools, mode === 'auto');
    assert.equal(body.messages.at(-1).content, text);
    assert.equal(body.messages.length, kind === 'starter' ? 4 : 2);
    if (mode === 'auto') {
      await page.locator('.bubble details summary').click();
      await page.getByRole('link', { name: /Public source/ }).waitFor();
    }
    sessions.push({ id, character: partner.id, kind, mode });
    await button('End chat').click();
    await poll(async () => { const v = await cmd('loadSession', { sessionId: id }); return v.session.analysis_state === 'completed' && v.memory.job?.state === 'completed' && v.renewal?.state === 'completed'; });
    await button('New chat').click();
    await button('Partner: Automatic').waitFor();
  }
  const calls = mock.requests.length; await close(); await launch(); assert.equal(mock.requests.length, calls);
  for (const saved of sessions) {
    const view = await cmd('loadSession', { sessionId: saved.id });
    assert.equal(view.session.character, saved.character); assert.equal(view.session.opening_kind, saved.kind);
    assert.equal(view.session.state, 'ended'); assert.equal(view.messages.at(-1).origin, 'model');
  }
  checks.push('All current manual selections in both entries; exact model/reasoning; Auto retrieval evidence/Off omission; stored replies, grammar, memory and renewal; reopen without replay');
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/report.json`, JSON.stringify({ status: 'passed', packaged, directory, checks, sessions, errors, paidRequests: 0 }, null, 2));
  console.log(JSON.stringify({ output, checks, errors }));
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: `${output}/failure.png` }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { await app?.close().catch(() => undefined); await new Promise(r => mock.server.close(r)); }
