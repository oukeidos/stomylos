// Native dual-entry acceptance with invented text, fake microphone and local mock responses.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const packaged = process.argv.includes('--packaged');
const directory = mkdtempSync('/tmp/stomylos-opening-ui-');
let releaseASR;
const mock = await startMockGateway({ delay: 0, asrHandler: async (_input, response) => {
  await new Promise(resolve => { releaseASR = resolve; });
  response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ text: 'I enjoys quiet mornings.' }));
} });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint, ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
let app, page; const checks = [], errors = [];
const cmd = (name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
const button = name => page.getByRole('button', { name, exact: true });
const composer = () => page.getByRole('textbox', { name: 'Your message', exact: true });
async function poll(fn) { const end = Date.now() + 20000; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Expected state did not settle'); }
async function launch() {
  app = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/linux-unpacked/stomylos') : createRequire(import.meta.url)('electron'),
    args: [...(packaged ? [] : ['.']), '--use-fake-device-for-media-stream'], env, chromiumSandbox: true });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await button('Settings').waitFor();
}
async function close() {
  const exited = new Promise(r => app.process().once('exit', r));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await exited; app = null;
}
const view = async () => { const snapshot = await cmd('snapshot'); return cmd('loadSession', { sessionId: snapshot.unfinished.id }); };
try {
  await launch(); const original = await view(); const draft = '  A quiet thought.\n한국어  ';
  assert.equal(original.session.opening_kind, 'starter');
  await composer().fill(draft); await composer().dispatchEvent('compositionstart');
  assert.equal(await button('Start with your own topic').isDisabled(), true);
  await composer().dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  assert.equal(mock.requests.length, 0); await composer().dispatchEvent('compositionend');
  const starterControl = await button('Start with your own topic').boundingBox();
  await button('Start with your own topic').click(); await button('Show a starter question').waitFor();
  const directControl = await button('Show a starter question').boundingBox();
  assert.ok(Math.abs(starterControl.y - directControl.y) < 2, 'Entry switch must stay at the same height in both modes');
  assert.equal(await composer().inputValue(), draft); assert.equal(await composer().evaluate(e => e === document.activeElement), true);
  assert.equal((await view()).messages.length, 0); assert.equal((await view()).session.id, original.session.id);
  await button('Show a starter question').click(); await button('Start with your own topic').waitFor();
  assert.deepEqual((await view()).messages, original.messages); assert.equal(mock.requests.length, 0);
  checks.push('Same native composer/session, exact draft, IME guard, focus and exact question restoration');
  await button('Listen').click();
  await poll(async () => (await cmd('speechSnapshot')).items.some(i => i.state === 'ready'));
  const calls = mock.requests.length;
  await button('Start with your own topic').click(); await button('Show a starter question').waitFor();
  await button('Show a starter question').click(); await button('Play speech').click();
  assert.equal(mock.requests.length, calls); checks.push('Starter audio cache survives parking/restoration without another generation');
  await button('Start with your own topic').click();
  await button('Record').click();
  await poll(async () => { const s = await cmd('asrSnapshot'); return s.progress?.samples >= 16000; });
  assert.equal(await button('Show a starter question').isDisabled(), true);
  await button('Stop and transcribe').click(); await poll(() => !!releaseASR);
  assert.equal(await button('Show a starter question').isDisabled(), true); releaseASR();
  await poll(async () => (await composer().inputValue()).includes('I enjoys quiet mornings.'));
  const recognized = await composer().inputValue();
  await button('Show a starter question').click(); await button('Start with your own topic').click();
  assert.equal(await composer().inputValue(), recognized);
  await composer().fill('Edited voice opening.'); const beforeRestart = mock.requests.length;
  await close(); await launch(); assert.equal(mock.requests.length, beforeRestart);
  await poll(async () => (await composer().inputValue()) === 'Edited voice opening.');
  assert.equal((await view()).session.opening_kind, 'user');
  checks.push('Recording/transcription guard; edited voice draft survives switches and native close/reopen with no upload');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 620));
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/opening-${packaged ? 'packaged' : 'native'}.png` });
  const bounds = await composer().boundingBox(); assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 620);
  await page.getByRole('button', { name: /^Send/ }).click();
  await poll(async () => { const v = await view(); return v.messages.at(-1)?.origin === 'model' && v.messages.at(-1).delivery === 'complete'; });
  let current = await view(); const user = current.messages[0];
  assert.equal(user.sequence, 0); assert.equal(user.content, 'Edited voice opening.'); assert.equal(user.origin, 'learner');
  assert.equal(await button('Show a starter question').count(), 0);
  const routing = mock.requests.find(r => r.response_format?.json_schema?.name === 'stomylos_character_scores_v4');
  assert.deepEqual(JSON.parse(routing.messages[1].content), { opening_kind: 'user', first_message: user.content });
  const body = mock.requests.find(r => r.stream === true && !r.response_format); assert.equal(body.messages.length, 2); assert.equal(body.messages[1].content, user.content);
  const records = readdirSync(join(directory, 'asr')).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(directory, 'asr', n))));
  assert.equal(records.find(r => r.submitted)?.submitted.messageId, user.id);
  checks.push('Direct first-send sequence zero, exact router/chat packet, hidden entry action and voice source binding');
  await button('End chat').click();
  await poll(async () => { current = await cmd('loadSession', { sessionId: current.session.id }); return current.session.analysis_state === 'completed' && current.renewal?.state === 'completed' && current.memory.job?.state === 'completed'; });
  assert.equal(current.units[0].source_message_id, user.id);
  const renewal = mock.requests.find(r => !r.response_format && r.messages && !r.stream);
  const packet = JSON.parse(renewal.messages[1].content); assert.equal(packet.session_context.starter_question, null); assert.equal(packet.just_used_question_id, null);
  const nextId = await cmd('newSession'); const next = await cmd('loadSession', { sessionId: nextId });
  assert.equal(next.session.opening_kind, 'user'); assert.equal(next.messages.length, 0);
  assert.equal((await cmd('snapshot')).sessions.find(s => s.id === current.session.id).title, user.content);
  checks.push('Direct end completes grammar, memory and question generation; first-message title and saved new-session preference');
  await close(); await launch(); assert.equal((await view()).session.id, nextId); await close();
  assert.deepEqual(errors, []);
  const report = { status: 'passed', packaged, directory, checks, errors, paidRequests: 0 };
  writeFileSync(`test-results/opening-${packaged ? 'packaged' : 'native'}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  if (page && !page.isClosed()) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: 'test-results/opening-failure.png' }); }
  throw error;
} finally { releaseASR?.(); await app?.close().catch(() => undefined); await new Promise(r => mock.server.close(r)); }
