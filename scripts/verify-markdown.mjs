// Markdown acceptance with public text, a local gateway and a stubbed browser opener.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';

const require = createRequire(import.meta.url);
const packaged = process.argv.includes('--packaged');
const directory = mkdtempSync('/tmp/stomylos-markdown-');
const output = `test-results/markdown-${packaged ? 'packaged' : 'native'}`;
mkdirSync(output, { recursive: true });
const text = readFileSync('tests/fixtures/assistant-markdown.md', 'utf8');
const prefix = text.slice(0, text.indexOf('const reminder') + 40);
const learner = 'Keep **my literal text** and `symbols`.\n한국어 <b>unchanged</b>';
let releaseStream;
const continueStream = new Promise(resolve => { releaseStream = resolve; });
let chatCount = 0;
const mock = await startMockGateway({ chatHandler: async (input, response) => {
  const first = ++chatCount === 1;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = content => response.write(`data: ${JSON.stringify({ model: input.model, provider: 'Public mock', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  chunk(prefix);
  if (first) {
    await continueStream;
    for (let offset = prefix.length; offset < text.length; offset += 37) {
      if (response.destroyed) return;
      chunk(text.slice(offset, offset + 37));
      await new Promise(resolve => setTimeout(resolve, 8));
    }
  }
  response.end(`data: ${JSON.stringify({ model: input.model, provider: 'Public mock', choices: [{ index: 0, delta: {}, finish_reason: first ? 'stop' : 'length' }] })}\n\ndata: [DONE]\n\n`);
} });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint,
  ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
const errors = [], network = [], checks = [];
let app;
const view = page => page.evaluate(async () => {
  const snapshot = await window.stomylos.command('snapshot');
  return window.stomylos.command('loadSession', { sessionId: snapshot.sessions.find(s => s.state !== 'ended').id });
});
async function launch() {
  app = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/linux-unpacked/stomylos') : require('electron'),
    args: packaged ? [] : ['.'], env, chromiumSandbox: true });
  await app.evaluate(({ shell }) => {
    globalThis.markdownOpened = [];
    shell.openExternal = async url => { globalThis.markdownOpened.push(url); };
  });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  return page;
}
async function close(page) {
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await page.evaluate(() => window.stomylos.command('close')); await exited; app = null;
}
async function checkLayout(page, name) {
  const measurements = await page.evaluate(() => {
    const body = document.querySelector('.assistant-markdown');
    const pre = body.querySelector('pre'), table = body.querySelector('.markdown-table');
    return { documentFits: document.documentElement.scrollWidth <= innerWidth,
      mainFits: document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth,
      bodyWidth: body.clientWidth, preWidth: pre.clientWidth, preScroll: pre.scrollWidth,
      tableWidth: table.clientWidth, tableScroll: table.scrollWidth,
      inlineCode: getComputedStyle(body.querySelector('p code')).display,
      paragraphSize: getComputedStyle(body.querySelector('p')).fontSize };
  });
  assert.ok(measurements.documentFits && measurements.mainFits, JSON.stringify(measurements));
  assert.ok(measurements.preWidth <= measurements.bodyWidth && measurements.tableWidth <= measurements.bodyWidth);
  assert.ok(measurements.preScroll > measurements.preWidth, 'Long code scrolls within its own region');
  assert.equal(measurements.inlineCode, 'inline'); assert.equal(measurements.paragraphSize, '16px');
  await page.locator('.assistant-markdown').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/${name}.png` });
  checks.push({ name, measurements });
}
try {
  let page = await launch();
  const button = name => page.getByRole('button', { name, exact: true });
  await button('Start with your own topic').click();
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(learner);
  await page.getByRole('button', { name: /^Send/ }).click();
  await page.locator('.assistant-markdown pre').waitFor();
  await page.getByText('Writing…', { exact: true }).waitFor();
  assert.equal(await page.locator('.bubble.user p').textContent(), learner);
  assert.equal(await page.locator('.bubble.user :is(strong, code, b)').count(), 0);
  await page.screenshot({ path: `${output}/01-streaming.png` });
  releaseStream();
  const assistant = page.locator('.bubble').filter({ has: page.locator('.assistant-markdown') }).first();
  await assistant.getByRole('button', { name: 'Listen', exact: true }).waitFor();
  assert.equal(await assistant.locator('strong').innerText(), 'one quiet moment');
  assert.equal(await assistant.locator('table tbody tr').count(), 2);
  assert.equal(await assistant.locator('img, script, iframe').count(), 0);
  assert.equal(await page.evaluate(() => window.markdownExecuted), undefined);
  assert.equal(await assistant.locator('a').count(), 1);
  const saved = await view(page);
  assert.equal(saved.messages.at(-1).content, text);
  assert.equal(saved.messages.find(m => m.role === 'user').content, learner);
  checks.push('Streamed incomplete fence becomes complete Markdown; learner text stays literal; saved source is byte-identical; no executable HTML or images');

  const url = page.url();
  await assistant.getByRole('link', { name: 'Example website' }).focus(); await page.keyboard.press('Enter');
  assert.deepEqual(await app.evaluate(() => globalThis.markdownOpened), ['https://example.com/reading?topic=pause&day=1']);
  await page.evaluate(() => { window.open('file:///tmp/private.txt', '_blank'); window.open('stomylos://app/private', '_blank'); });
  await page.waitForTimeout(100);
  assert.equal((await app.evaluate(() => globalThis.markdownOpened)).length, 1);
  assert.equal(page.url(), url); assert.equal(app.windows().length, 1);
  checks.push('Keyboard activation dispatches HTTP(S) to the stubbed system browser; local/app schemes and child windows are denied; transcript URL unchanged');

  await assistant.getByRole('button', { name: 'Listen', exact: true }).click();
  await page.waitForFunction(async () => (await window.stomylos.command('speechSnapshot')).items.some(i => i.state === 'ready'));
  assert.equal(mock.requests.find(r => r.input?.startsWith('[long-pause]')).input, '[long-pause]' + text);
  await checkLayout(page, '02-desktop');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 620));
  await button('Show history').click();
  await checkLayout(page, '03-minimum-library');
  await button('Hide history').click();
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Another small step.');
  await page.getByRole('button', { name: /^Send/ }).click();
  await button('Retry reply').waitFor();
  const interrupted = await view(page);
  assert.equal(interrupted.messages.at(-1).content, prefix);
  assert.equal(interrupted.messages.at(-1).delivery, 'interrupted');
  assert.equal(mock.requests.filter(r => r.stream).at(-1).messages.find(m => m.content === text)?.content, text);
  await close(page); page = await launch();
  await button('Retry reply').waitFor();
  assert.equal(await page.locator('.assistant-markdown table').count(), 1);
  assert.equal(await page.locator('.assistant-markdown pre').count(), 2);
  assert.deepEqual((await view(page)).messages, interrupted.messages);
  assert.equal(chatCount, 2);
  checks.push('TTS and the next model request retain raw Markdown; restart preserves completed and interrupted history without redispatch');
  assert.deepEqual(errors, []); assert.deepEqual(network, []);
  await close(page);
  writeFileSync(`${output}/report.json`, JSON.stringify({ status: 'passed', packaged, directory, checks, errors, network, paidRequests: 0 }, null, 2));
  console.log(JSON.stringify({ output, checks, errors, network }));
} finally {
  releaseStream(); await app?.close(); await new Promise(resolve => mock.server.close(resolve));
}
