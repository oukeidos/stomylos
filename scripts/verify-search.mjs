// Native/package search acceptance with synthetic text and a loopback-only gateway.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';

const require = createRequire(import.meta.url), packaged = process.argv.includes('--packaged');
const directory = mkdtempSync('/tmp/stomylos-search-native-');
const output = resolve(`test-results/search-${packaged ? 'packaged' : 'native'}`); mkdirSync(output, { recursive: true });
const errors = [], browserNetwork = [], checks = [], gateBodies = [], chatBodies = [];
let interrupted = false;
const frame = (model, delta, finish = null, extra = {}) => `data: ${JSON.stringify({ model, provider: 'Public mock', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
const mock = await startMockGateway({
  searchHandler: async (body, response) => {
    gateBodies.push(body); const pair = JSON.parse(body.messages[1].content);
    if (pair.current_user.includes('fallback') && body.model === 'openai/gpt-oss-120b') { response.writeHead(503); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frame(body.model, { content: JSON.stringify({ search: !pair.current_user.includes('language help') }) }, 'stop', { usage: { prompt_tokens: 150, completion_tokens: 5, cost: 0.00001 } }) + 'data: [DONE]\n\n');
  },
  chatHandler: async (body, response) => {
    chatBodies.push(body); const user = body.messages.at(-1).content;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame(body.model, { content: body.tools ? 'A short searched reply.' : 'A short ordinary reply.' }));
    await new Promise(r => setTimeout(r, 450)); if (response.destroyed) return;
    const cutoff = user.includes('interrupt once') && !interrupted; if (cutoff) interrupted = true;
    if (body.tools) response.write(frame(body.model, { annotations: [{ type: 'url_citation', url_citation: {
      url: 'https://example.org/public-source', title: 'Public source', start_index: 0, end_index: 0, content: 'A page excerpt excluded from the UI.'
    } }, { type: 'url_citation', url_citation: { url: 'javascript:alert(1)', title: 'Unsafe source' } }] }));
    response.end(frame(body.model, {}, cutoff ? 'length' : 'stop', { usage: { prompt_tokens: 900, completion_tokens: 25, cost: 0.003,
      cost_details: { upstream_inference_cost: 0.002, upstream_inference_prompt_cost: 0.0018, upstream_inference_completions_cost: 0.0002 },
      ...(body.tools ? { server_tool_use_details: { web_search_requests: 1 } } : {}) } }) + 'data: [DONE]\n\n');
  }
});
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint,
  ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
let app;
async function launch() {
  app = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/linux-unpacked/stomylos') : require('electron'),
    args: packaged ? [] : ['.'], env, chromiumSandbox: true, timeout: 20000 });
  await app.evaluate(({ shell }) => { globalThis.searchOpened = []; shell.openExternal = async url => { globalThis.searchOpened.push(url); }; });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) browserNetwork.push(request.url()); });
  await page.getByRole('button', { name: /^Web search:/ }).waitFor(); return page;
}
const command = (page, name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
async function view(page) { const snapshot = await command(page, 'snapshot'); return command(page, 'loadSession', { sessionId: snapshot.unfinished.id }); }
async function close(page) { const exit = new Promise(r => app.process().once('exit', r)); await command(page, 'close'); await exit; app = null; }
async function resolved(page, text, incomplete = false) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const snapshot = await command(page, 'snapshot'), v = await view(page);
    if (snapshot.activity.phase === 'idle' && v.messages.findLast(m => m.role === 'user')?.content === text &&
      v.messages.at(-1)?.role === 'assistant' && v.messages.at(-1)?.delivery === (incomplete ? 'interrupted' : 'complete')) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Reply did not resolve: ' + text);
}
async function send(page, text, incomplete = false) {
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await resolved(page, text, incomplete);
}
try {
  let page = await launch();
  assert.equal(await page.getByRole('button', { name: 'Web search: Auto', exact: true }).getAttribute('aria-pressed'), 'true');
  const beforeToggle = mock.requests.length;
  await page.getByRole('button', { name: 'Web search: Auto', exact: true }).click();
  await page.getByRole('button', { name: 'Web search: Off', exact: true }).waitFor();
  assert.equal(mock.requests.length, beforeToggle); await close(page); page = await launch();
  assert.equal(await page.getByRole('button', { name: 'Web search: Off', exact: true }).getAttribute('aria-pressed'), 'false');
  checks.push('Per-chat Off persists through restart; toggling sends no request');
  await page.getByRole('button', { name: 'Web search: Off', exact: true }).click();
  await page.getByRole('button', { name: 'Start with your own topic', exact: true }).click();
  const roster = (await command(page, 'snapshot')).characters;
  for (const partner of roster) {
    const current = await view(page);
    assert.equal(current.session.search_mode, 'auto');
    await command(page, 'selectPartner', { sessionId: current.session.id, character: partner.id });
    const gates = gateBodies.length;
    await send(page, `Please do a public lookup for ${partner.id}.`);
    const after = await view(page); assert.equal(after.session.model, partner.model);
    assert.equal(gateBodies.length, gates + 1); assert.equal(chatBodies.at(-1).model, partner.model);
    assert.equal(chatBodies.at(-1).tools[0].type, 'openrouter:web_search');
    assert.equal(await page.getByText('Web searched', { exact: true }).count(), 1);
    await page.locator('.search-sources summary').click();
    await page.getByRole('link', { name: 'Public source', exact: true }).click();
    assert.ok((await app.evaluate(() => globalThis.searchOpened)).includes('https://example.org/public-source'));
    assert.equal(await page.getByText('Unsafe source', { exact: true }).count(), 0);
    assert.equal(await page.getByText('A page excerpt excluded from the UI.', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Web search: Auto', exact: true }).click();
    await send(page, `Another public lookup while Off for ${partner.id}.`);
    assert.equal(gateBodies.length, gates + 1); assert.equal(chatBodies.at(-1).tools, undefined);
    assert.equal(chatBodies.at(-1).max_tool_calls, undefined); assert.equal(chatBodies.at(-1).plugins, undefined);
    checks.push(`${partner.id}: Auto searches and Off skips gating/retrieval, same ${partner.model}`);
    await page.screenshot({ path: `${output}/${partner.id}.png` });
    await command(page, 'endSession', { sessionId: current.session.id });
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('button', { name: 'Web search: Auto', exact: true }).waitFor();
  }
  await send(page, 'Some language help, please.'); assert.equal(chatBodies.at(-1).tools, undefined);
  await send(page, 'Please do a fallback public lookup.');
  assert.equal(gateBodies.at(-1).model, 'ibm-granite/granite-4.2-8b'); assert.ok(chatBodies.at(-1).tools);
  const beforeRetry = gateBodies.length;
  await send(page, 'Please do a public lookup and interrupt once.', true);
  assert.equal(await page.getByRole('button', { name: 'Web search: Auto', exact: true }).isDisabled(), true);
  const savedBody = structuredClone(chatBodies.at(-1));
  await page.getByRole('button', { name: 'Retry reply', exact: true }).click();
  await resolved(page, 'Please do a public lookup and interrupt once.');
  assert.equal(gateBodies.length, beforeRetry + 1); assert.deepEqual(chatBodies.at(-1), savedBody);
  assert.equal(await page.getByRole('button', { name: 'Web search: Auto', exact: true }).isEnabled(), true);
  checks.push('Negative gate, fallback and interrupted retry preserve the selected mode and request');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(650, 800));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${output}/narrow.png` });
  await close(page); page = await launch();
  assert.ok(await page.getByText('Web searched', { exact: true }).count() > 0);
  assert.equal(browserNetwork.length, 0); assert.deepEqual(errors, []);
  checks.push('Sources survive restart; renderer performs no web retrieval; narrow layout fits');
  await close(page);
  writeFileSync(`${output}/report.json`, JSON.stringify({ passed: true, directory, checks, errors, browserNetwork, gateRequests: gateBodies.length, conversationRequests: chatBodies.length }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
} catch (error) {
  const page = app ? await app.firstWindow().catch(() => null) : null;
  if (page) await page.screenshot({ path: `${output}/failure.png` }).catch(() => undefined);
  writeFileSync(`${output}/failure.json`, JSON.stringify({ error: String(error), checks, errors, body: page ? await page.locator('body').innerText().catch(() => '') : '', requests: mock.requests }, null, 2));
  throw error;
} finally { if (app) await app.close(); mock.server.closeAllConnections(); await new Promise(r => mock.server.close(r)); }
