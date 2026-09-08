// Real Electron/worker/SQLite/UI with an invented, deterministic memory gateway.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const packaged = process.argv.includes('--packaged');
const directory = mkdtempSync(join(tmpdir(), 'stomylos-memory-native-'));
let failNext = false, application; const errors = [], completed = [];
const report = { status: 'checking', directory, packaged, realCalls: 0, errors, checks: [] };
const mock = await startMockGateway({ delay: 0,
  memoryHandler: async (body, response) => {
    if (failNext) { failNext = false; response.writeHead(429, { 'content-type': 'application/json' }); response.end('{"error":{"code":429,"message":"Public memory failure fixture"}}'); return; }
    const packet = JSON.parse(body.messages[1].content), user = packet.session.messages.find(m => m.origin === 'learner');
    const op = (kind, id, category, text) => ({ op: kind, id, category, text, source_message_ids: [user.id] });
    let operations = [];
    if (user.content.startsWith('My sister Hana')) operations = [op('add', null, 'relationships', 'Hana is the user\'s sister.'), op('add', null, 'traits', 'Prefers low-maintenance plants.'), op('add', null, 'intentions', 'Plans to buy mint.'), op('add', null, 'intentions', 'Promised Hana a photo of the basil.')];
    else if (user.content.startsWith('I am learning astronomy')) operations = [op('add', null, 'traits', 'Learns best with diagrams.'), op('add', null, 'relationships', 'Leo is a friend who owns a telescope.'), op('add', null, 'intentions', 'Plans to observe Saturn with Leo on September 12, 2026.')];
    else if (user.content.startsWith('Hana is my cousin')) {
      for (const category of ['traits', 'relationships', 'experiences', 'intentions']) for (const item of packet.current_memory[category]) {
        if (item.text.includes('sister')) operations.push(op('update', item.id, category, item.text.replace('sister', 'cousin')));
        else if (item.text.includes('buy mint')) operations.push(op('update', item.id, 'experiences', 'Decided not to buy mint because it spreads too much.'));
        else if (item.text.includes('Promised')) operations.push(op('update', item.id, 'experiences', 'Sent cousin Hana the basil photo.'));
      }
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model: body.model, provider: 'Google AI Studio', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ operations }), refusal: false } }], usage: { cost: 0 } }));
  },
  chatHandler: async (body, response) => {
    const system = body.messages[0].content;
    const text = body.messages.at(-1).content.startsWith('Please recall') ? 'Saved context received: ' + system.split('<conversation_memory>')[1].split('</conversation_memory>')[0].trim() : 'Thank you for sharing this update.';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  }
});
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint,
  ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
async function launch() {
  application = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/linux-unpacked/stomylos') : createRequire(import.meta.url)('electron'), args: packaged ? [] : ['.'], env, chromiumSandbox: true, timeout: 20000 });
  const page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await application.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox')), false);
  return page;
}
const command = (page, name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
async function wait(fn, message) { const until = Date.now() + 20000; while (Date.now() < until) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 50)); } throw new Error(message); }
const load = (page, id) => command(page, 'loadSession', { sessionId: id });
async function begin(page, partner, text) {
  const snapshot = await command(page, 'snapshot'); const id = snapshot.unfinished?.id ?? await command(page, 'newSession');
  await command(page, 'selectPartner', { sessionId: id, character: partner });
  await command(page, 'sendMessage', { sessionId: id, text, revision: 1 });
  await wait(async () => (await load(page, id)).messages.at(-1).delivery === 'complete' && (await command(page, 'snapshot')).activity.phase === 'idle', 'Reply did not complete');
  return id;
}
async function end(page, id, state = 'completed') {
  await command(page, 'endSession', { sessionId: id });
  const view = await wait(async () => { const v = await load(page, id); return v.memory.job?.state === state && v; }, 'Memory did not reach ' + state);
  return view;
}
async function close(page) {
  const child = application.process(), exited = new Promise(r => child.once('exit', r));
  await command(page, 'close'); await exited; application = null;
}
async function details(page, id) {
  if (!await page.locator('aside').isVisible()) await page.getByRole('button', { name: 'Show history', exact: true }).click();
  await page.locator(`.history-item[aria-current="page"]`).waitFor();
  const selected = await command(page, 'loadSession', { sessionId: id });
  // Use the real history row to select the target before exercising its controls.
  const rows = await command(page, 'snapshot'); const index = rows.sessions.findIndex(s => s.id === id);
  await page.locator('.history-item').nth(index).click();
  await page.getByRole('button', { name: 'Conversation details', exact: true }).click();
  await page.getByRole('button', { name: /^Shared memory/ }).click(); return selected;
}
try {
  let page = await launch();
  const a1 = await begin(page, 'model_04', 'My sister Hana gave me basil. I prefer low-maintenance plants, plan to buy mint, and promised Hana a photo.');
  await end(page, a1);
  const b1 = await begin(page, 'model_03', 'I am learning astronomy with my friend Leo and his telescope. We will observe Saturn on September 12, 2026. I learn best with diagrams.');
  await end(page, b1);
  const a2 = await begin(page, 'model_05', 'Hana is my cousin, not my sister. I decided not to buy mint because it spreads too much. I sent Hana the basil photo.');
  const revised = await end(page, a2);
  assert.equal(revised.memory.current.revision, 3); assert.equal(revised.memory.current.intentions.length, 1);
  assert.match(JSON.stringify(revised.memory.current), /cousin/); assert.doesNotMatch(JSON.stringify(revised.memory.current), /sister/);
  assert.match(JSON.stringify(revised.memory.current), /Decided not to buy mint/);
  const bSaved = (await load(page, b1)).memory.current; assert.deepEqual(bSaved, revised.memory.current);
  await details(page, b1); await page.getByRole('button', { name: 'Saved for future chats', exact: true }).click();
  await page.getByText('Decided not to buy mint because it spreads too much.', { exact: true }).waitFor();
  await page.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))); });
  await page.getByText('Decided not to buy mint because it spreads too much.', { exact: true }).scrollIntoViewIfNeeded();
  mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: `test-results/memory-${packaged ? 'packaged' : 'native'}.png` });
  await page.keyboard.press('Escape'); report.checks.push('Three connected updates, corrected/canceled/completed facts, shared across characters and visible saved lists');
  const before = mock.requests.length; await close(page); page = await launch();
  assert.equal(mock.requests.length, before, 'No requests on restart');
  assert.deepEqual((await load(page, a2)).memory.current, revised.memory.current);
  assert.deepEqual((await load(page, b1)).memory.current, bSaved);
  const recall = await begin(page, 'model_07', 'Please recall my plant decisions.');
  const recalled = await load(page, recall);
  assert.deepEqual(recalled.memory.snapshot, revised.memory.current);
  assert.match(recalled.messages.at(-1).content, /Decided not to buy mint/);
  assert.match(recalled.messages.at(-1).content, /Leo/); assert.match(recalled.messages.at(-1).content, /Saturn/);
  failNext = true; await end(page, recall, 'failed');
  const attempts = (await load(page, recall)).memory.attempts.length;
  await details(page, recall); await page.getByRole('button', { name: 'Retry memory update', exact: true }).click();
  await wait(async () => (await load(page, recall)).memory.job.state === 'completed', 'Explicit retry did not complete');
  assert.equal((await load(page, recall)).memory.attempts.length, attempts + 1);
  await page.keyboard.press('Escape');
  const skip = await begin(page, 'model_04', 'A separate update to skip.'); failNext = true; await end(page, skip, 'failed');
  await details(page, skip); await page.getByRole('button', { name: 'Skip this memory update', exact: true }).click();
  await wait(async () => (await load(page, skip)).memory.job.state === 'skipped', 'Skip not saved');
  report.checks.push('SQLite close/reopen, no startup inference, full correct snapshot injection, explicit UI retry and skip');
  assert.deepEqual(errors, []); await close(page);
  report.requests = mock.requests.length;
  report.memoryRequests = mock.requests.filter(b => b.response_format?.json_schema?.name === 'stomylos_memory_delta_v1').length;
  report.status = 'passed';
  console.log(JSON.stringify(report, null, 2));
} finally {
  await application?.close().catch(() => undefined); await new Promise(r => mock.server.close(r));
  mkdirSync('test-results', { recursive: true }); writeFileSync(`test-results/memory-${packaged ? 'packaged' : 'native'}-report.json`, JSON.stringify(report, null, 2));
}
