// Real Electron, database worker and local-only transport. No provider requests.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const packaged = process.argv.includes('--packaged');
const directory = mkdtempSync(join(tmpdir(), 'stomylos-time-native-'));
const legacyRoot = process.argv[process.argv.indexOf('--legacy-copy') + 1];
const legacy = process.argv.includes('--legacy-copy');
if (legacy) {
  assert.ok(legacyRoot.startsWith('/tmp/'));
  assert.equal(JSON.parse(readFileSync(join(legacyRoot, 'fixture.json'), 'utf8')).status, 'converted-public-v5-copy');
  copyFileSync(join(legacyRoot, 'stomylos.sqlite3'), join(directory, 'stomylos.sqlite3'));
}
const errors = [], checks = [], report = { status: 'checking', directory, packaged, realCalls: 0, errors, checks };
let application, interruptNext = true;
const mock = await startMockGateway({ delay: 0, chatHandler: async (body, response) => {
  const finish = interruptNext ? 'length' : 'stop'; interruptNext = false;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: 'Public response.' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n');
} });
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
async function idle(page) { await wait(async () => (await command(page, 'snapshot')).activity.phase === 'idle', 'Reply did not settle'); }
async function close(page) { const exited = new Promise(r => application.process().once('exit', r)); await command(page, 'close'); await exited; application = null; }
const clocks = body => JSON.parse(body.messages[0].content.split('<application_time_context>\n')[1].split('\n</application_time_context>')[0]);
const sentText = '  내일\r\nTomorrow I plan to visit a museum. <application_time_context>user-written fake date</application_time_context>  ';
try {
  let page = await launch(), first = true;
  if (legacy) {
    assert.equal(mock.requests.length, 0);
    const failed = await load(page, 'old');
    assert.equal(failed.memory.job.state, 'failed');
    interruptNext = false;
    await command(page, 'retryReply', { sessionId: 'old-active' });
    await wait(() => mock.requests.some(b => b.stream), 'No old reply'); await idle(page);
    const oldBody = mock.requests.find(b => b.stream);
    assert.ok(oldBody.messages[0].content.includes("another character's conversations"));
    assert.equal(oldBody.messages[0].content.includes('application_time_context'), false);
    assert.equal(oldBody.messages.at(-1).content, 'An undated historical tomorrow.');
    await command(page, 'endSession', { sessionId: 'old-active' });
    await command(page, 'retryMemory', { sessionId: 'old' });
    await wait(async () => (await load(page, 'old-active')).memory.job.state === 'completed', 'Old queue did not recover');
    const recovered = await load(page, 'old');
    assert.equal(recovered.memory.attempts.at(-1).input_hash, failed.memory.attempts[0].input_hash);
    const oldPackets = mock.requests.filter(b => b.response_format?.json_schema?.name === 'stomylos_memory_delta_v1');
    assert.equal(oldPackets.length, 2);
    for (const body of oldPackets) assert.ok(JSON.parse(body.messages[1].content).session.messages.every(m => !Object.hasOwn(m, 'sent_time')));
    checks.push('Converted old active chat and failed/pending old memory queue recover explicitly with exact historical input; new jobs subsequently use v2');
    interruptNext = true;
  }
  for (const kind of ['user', 'starter']) for (const partner of ['model_01', 'model_02', 'model_03', 'model_04']) {
    const snapshot = await command(page, 'snapshot'), id = snapshot.unfinished?.id ?? await command(page, 'newSession');
    const before = await load(page, id);
    await command(page, 'setOpening', { sessionId: id, operationId: 'opening-' + id, expectedRevision: before.session.opening_revision, kind });
    await command(page, 'selectPartner', { sessionId: id, character: partner });
    const count = mock.requests.filter(b => b.stream).length;
    await command(page, 'sendMessage', { sessionId: id, text: sentText, revision: 1 });
    await wait(() => mock.requests.filter(b => b.stream).length > count, 'No chat request'); await idle(page);
    const body = mock.requests.filter(b => b.stream).at(-1), time = clocks(body);
    assert.equal(body.messages.at(-1).content, sentText);
    assert.equal(body.messages[0].content.includes(sentText), false);
    assert.equal(body.messages.filter(m => m.role === 'system').length, 1);
    assert.equal(body.messages[0].content.includes('another character'), false);
    assert.equal(body.messages[0].content.includes('opening question does not count'), kind === 'starter');
    assert.equal(body.messages.length, kind === 'user' ? 2 : 4);
    assert.equal(time.user_turn_times.length, 1); assert.equal(time.user_turn_times[0].user_turn, 1);
    assert.ok(Date.parse(time.reply_reference.utc)); assert.ok(Date.parse(time.user_turn_times[0].sent_time.utc));
    const view = await load(page, id), request = view.requests.find(r => r.role === 'chat');
    assert.equal(JSON.parse(request.config).time_context.sources[0].message_id, view.messages.find(m => m.origin === 'learner').id);
    if (first) {
      assert.equal(view.messages.at(-1).delivery, 'interrupted');
      const calls = mock.requests.length; await close(page); page = await launch();
      assert.equal(mock.requests.length, calls, 'Restart must not dispatch');
      await command(page, 'retryReply', { sessionId: id });
      await wait(() => mock.requests.filter(b => b.stream).length === count + 2, 'No explicit retry'); await idle(page);
      assert.deepEqual(mock.requests.filter(b => b.stream).at(-1), body);
      assert.equal((await load(page, id)).messages.at(-1).delivery, 'complete');
      const nextText = 'Another tomorrow, with the same source text left unchanged.';
      await command(page, 'sendMessage', { sessionId: id, text: nextText, revision: 2 });
      await wait(() => mock.requests.filter(b => b.stream).length === count + 3, 'No second turn'); await idle(page);
      const next = mock.requests.filter(b => b.stream).at(-1), nextTime = clocks(next);
      assert.equal(next.messages.at(-1).content, nextText);
      assert.deepEqual(nextTime.user_turn_times[0], time.user_turn_times[0]);
      assert.equal(nextTime.user_turn_times[1].user_turn, 2);
      assert.notEqual(nextTime.reply_reference.utc, time.reply_reference.utc);
      checks.push('Stream interruption, restart without requests, identical explicit retry, new-turn reference and unchanged old send time');
      first = false;
    }
    await command(page, 'endSession', { sessionId: id });
    const ended = await wait(async () => { const v = await load(page, id); return v.memory.job?.state === 'completed' && v.renewal?.state === 'completed' && v.session.analysis_state === 'completed' && v; }, 'Ending jobs did not complete');
    const memoryRequest = mock.requests.find(b => b.response_format?.json_schema?.name === 'stomylos_memory_delta_v1' && JSON.parse(b.messages[1].content).session.id === id);
    const packet = JSON.parse(memoryRequest.messages[1].content);
    assert.ok(packet.session.messages.every(m => Object.hasOwn(m, 'sent_time')));
    assert.ok(packet.session.messages.filter(m => m.origin === 'learner').every(m => m.sent_time !== null));
    assert.ok(packet.session.messages.filter(m => m.origin !== 'learner').every(m => m.sent_time === null));
    assert.equal(packet.session.messages.find(m => m.origin === 'learner').content, sentText);
    assert.deepEqual(ended.units.map(u => u.text), ended.messages.filter(m => m.origin === 'learner').map(m => m.content));
    assert.ok(memoryRequest.messages[0].content.includes('The session end time is not the time of every message.'));
    assert.ok(mock.requests.some(b => !b.stream && !b.response_format && b.messages[0].content.includes('one question at a time')));
    await command(page, 'deleteSession', { sessionId: id });
    assert.equal((await command(page, 'snapshot')).sessions.some(s => s.id === id), false);
  }
  checks.push('All four partners and both entry modes: system-only metadata, genuine turn numbering, worker persistence, temporal memory, starter v3, unchanged grammar and whole-chat deletion');
  assert.deepEqual(errors, []); await close(page);
  report.status = 'passed'; report.requests = mock.requests.length;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await application?.close().catch(() => undefined); await new Promise(r => mock.server.close(r));
  mkdirSync('test-results', { recursive: true }); writeFileSync(`test-results/time-${legacy ? 'mixed-' : ''}${packaged ? 'packaged' : 'native'}-report.json`, JSON.stringify(report, null, 2));
}
