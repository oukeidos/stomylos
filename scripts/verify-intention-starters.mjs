// Native renderer/worker/SQLite verification with synthetic, local-only responses.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const packaged = process.argv.includes('--packaged');
const directory = mkdtempSync(join(tmpdir(), 'stomylos-intention-ui-'));
const question = 'What kind of trip would you like to plan?';
let application, memoryCount = 0, releaseMemory, firstIntention = true;
const report = { status: 'running', packaged, directory, realCalls: 0, checks: [], errors: [] };
function respond(response, body, provider, content) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ model: body.model, provider, choices: [{ finish_reason: 'stop', message: { content } }], usage: { cost: 0, total_tokens: 50 } }));
}
const mock = await startMockGateway({ delay: 0,
  memoryHandler: async (body, response) => {
    const packet = JSON.parse(body.messages[1].content), source = packet.session.messages.find(m => m.origin === 'learner').id;
    memoryCount++;
    if (memoryCount === 2) await new Promise(resolve => { releaseMemory = resolve; });
    const operations = memoryCount === 1 ? [{ op: 'add', id: null, category: 'intentions', text: 'Wants to plan a trip.', source_message_ids: [source] }]
      : [{ op: 'delete', id: packet.current_memory.intentions[0].id, category: null, text: null, source_message_ids: [source] }];
    respond(response, body, 'Google AI Studio', JSON.stringify({ operations }));
  },
  intentionHandler: async (body, response) => {
    if (firstIntention) { firstIntention = false; response.writeHead(429, { 'content-type': 'application/json' }); response.end('{}'); return; }
    respond(response, body, 'Mistral', question);
  }
});
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint, ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY']) delete env[key];
const command = (page, name, args) => page.evaluate(([name,args]) => window.stomylos.command(name,args), [name,args]);
const load = (page, id) => command(page, 'loadSession', { sessionId: id });
async function wait(fn, label) { const end = Date.now() + 20000; while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 50)); } throw new Error(label); }
async function launch() {
  application = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/intention-candidate/linux-unpacked/stomylos') : createRequire(import.meta.url)('electron'), args: packaged ? [] : ['.'], env, chromiumSandbox: true });
  const page = await application.firstWindow(); page.on('pageerror', e => report.errors.push(e.message));
  await page.getByRole('textbox', { name: 'Your message' }).waitFor();
  assert.equal(await application.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox')), false);
  return page;
}
async function shutdown(page) {
  const exited = new Promise(resolve => application.process().once('exit', resolve));
  await command(page, 'close'); await exited; application = null;
}
try {
  let page = await launch(), input = page.getByRole('textbox', { name: 'Your message' });
  const first = (await command(page, 'snapshot')).unfinished.id;
  await command(page, 'selectPartner', { sessionId: first, character: 'model_04' });
  await command(page, 'searchMode', { sessionId: first, mode: 'off' });
  await input.fill('I want to plan a trip.'); await input.press('Enter');
  await wait(async () => (await load(page, first)).messages.at(-1)?.origin === 'model' && (await load(page, first)).messages.at(-1)?.delivery === 'complete', 'First reply');
  await page.getByRole('button', { name: 'End chat', exact: true }).click();
  await wait(async () => (await load(page, first)).renewal?.state === 'completed', 'Ordered preparation');
  const calls = mock.requests.filter(b => !b.stream && !b.response_format);
  assert.deepEqual(calls.slice(0,2).map(b => b.model), ['openai/gpt-5.6-luna','mistralai/mistral-small-2603']);
  assert.deepEqual(calls[0].reasoning, { effort: 'none', exclude: true });
  const packet = JSON.parse(calls[2].messages[1].content);
  assert.ok([...packet.active_questions.map(q => q.text), ...packet.queued_candidates].includes(question));
  report.checks.push('Memory commit precedes pinned Luna/Mistral fallback and ordinary starter input contains the accepted question');
  await page.getByRole('button', { name: 'Start another chat' }).click();
  const second = (await command(page, 'snapshot')).unfinished.id;
  await command(page, 'selectPartner', { sessionId: second, character: 'model_04' });
  await command(page, 'searchMode', { sessionId: second, mode: 'off' });
  await input.fill('I have cancelled that trip.'); await input.press('Enter');
  await wait(async () => (await load(page, second)).messages.at(-1)?.origin === 'model' && (await load(page, second)).messages.at(-1)?.delivery === 'complete', 'Second reply');
  await page.getByRole('button', { name: 'End chat', exact: true }).click(); await wait(() => releaseMemory, 'Held memory');
  assert.equal((await load(page, second)).renewal, null);
  await page.getByRole('button', { name: 'Start another chat' }).click();
  const draft = (await command(page, 'snapshot')).unfinished.id;
  for (let n = 0; (await load(page, draft)).session.starter_text !== question && n < 25; n++) await page.getByRole('button', { name: /Another question/ }).click();
  assert.equal((await load(page, draft)).session.starter_text, question);
  await input.fill('Keep these exact draft words.');
  releaseMemory(); releaseMemory = null;
  await wait(async () => (await load(page, draft)).outdatedOpening, 'Stale opening guard');
  await page.getByText('This question is outdated. Choose another question or start with your own message. Your draft is preserved.').waitFor();
  assert.equal(await input.inputValue(), 'Keep these exact draft words.'); assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
  mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: `test-results/intention-${packaged ? 'packaged' : 'native'}-stale.png` });
  await page.getByRole('button', { name: /Another question/ }).click();
  assert.equal(await input.inputValue(), 'Keep these exact draft words.'); await wait(async () => !(await load(page, draft)).outdatedOpening, 'Explicit replacement committed');
  await wait(async () => (await load(page, second)).renewal?.state === 'completed', 'Deletion-only renewal');
  report.checks.push('A new chat is immediate during memory work; source deletion invalidates its unsent opening while preserving draft text; explicit replacement restores send');
  const saved = await load(page, first); await shutdown(page); const count = mock.requests.length;
  page = await launch(); assert.deepEqual(await load(page, first), saved); assert.equal(mock.requests.length, count);
  assert.equal(await page.getByRole('textbox', { name: 'Your message' }).inputValue(), 'Keep these exact draft words.');
  report.checks.push('Restart preserves attempts, historical openings and draft, without automatic network calls');
  await shutdown(page); assert.deepEqual(report.errors, []); report.status = 'passed'; report.requests = count;
  console.log(JSON.stringify(report, null, 2));
} catch (e) { report.errors.push(e.message); throw e; }
finally {
  releaseMemory?.(); await application?.close().catch(() => undefined); mock.server.closeAllConnections(); await new Promise(r => mock.server.close(r));
  mkdirSync('test-results', { recursive: true }); writeFileSync(`test-results/intention-${packaged ? 'packaged' : 'native'}-report.json`, JSON.stringify(report, null, 2));
}
