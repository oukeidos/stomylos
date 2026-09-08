// Native/packaged UI verification using invented text and a local gateway only.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startMockGateway } from './mock-gateway.mjs';
const packaged = process.argv.includes('--packaged');
const directory = mkdtempSync('/tmp/stomylos-genie-ui-');
let mode = 'suggest', release;
const mock = await startMockGateway({ delay: 0, genieHandler: async (input, response) => {
  const packet = JSON.parse(input.messages[1].content);
  const captured = mode;
  if (captured === 'hold') await new Promise(r => { release = r; });
  if (response.destroyed) return;
  const content = captured === 'bad' ? '{"reply":"Broken","suggested_text":true}' : JSON.stringify({
    reply: captured === 'clarify' ? 'Do you mean the question was unexpected?' : captured === 'same' ? 'Your wording already works.' : 'This keeps your meaning.',
    suggested_text: captured === 'clarify' ? null : captured === 'same' ? packet.target_selection?.text ?? packet.draft : 'caught off guard'
  });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ model: input.model, provider: 'OpenAI', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { cost: 0 } }));
} });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint, ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
let app, page; const checks = [], errors = [];
const button = name => page.getByRole('button', { name, exact: true });
const composer = () => page.locator('textarea[aria-label="Your message"]');
const cmd = (name, args) => page.evaluate(([n, a]) => window.stomylos.command(n, a), [name, args]);
const count = () => mock.requests.filter(r => r.response_format?.json_schema?.name === 'genie_expression_v1').length;
async function poll(fn) { const end = Date.now() + 20000; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 30)); } throw new Error('Expected state did not settle'); }
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
async function select(start, end) { await composer().focus(); await composer().evaluate((node, [s, e]) => node.setSelectionRange(s, e), [start, end]); }
async function ready() { await poll(async () => (await cmd('genieSnapshot')).episode?.phase === 'ready'); }
try {
  await launch(); const sessionId = (await cmd('snapshot')).unfinished.id;
  const originalView = await cmd('loadSession', { sessionId });
  const draft = '😀 I felt put on the spot. Later, I felt put on the spot again.\nKeep this line.';
  const start = draft.lastIndexOf('put on the spot'), end = start + 'put on the spot'.length;
  await composer().fill(draft); await select(start, end);
  await composer().dispatchEvent('compositionstart'); await button('Genie').click(); assert.equal(count(), 0); await composer().dispatchEvent('compositionend');
  await select(start, end); await button('Genie').click(); await button('Replace selection').waitFor();
  assert.equal(await composer().getAttribute('readonly'), '');
  const packet = JSON.parse(mock.requests.at(-1).messages[1].content);
  assert.equal(packet.target_selection.start, start - 1); assert.equal(packet.target_selection.text, 'put on the spot');
  assert.deepEqual(packet.main_chat, originalView.messages.map(({ role, content }) => ({ role, content })));
  assert.equal(await page.getByLabel('Tell Genie more', { exact: true }).evaluate(n => document.activeElement === n), true);
  const beforeVoice = await cmd('asrSnapshot');
  await page.keyboard.press('F8');
  const followup = page.getByLabel('Tell Genie more', { exact: true });
  await followup.dispatchEvent('compositionstart'); await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Genie', exact: true }).waitFor();
  await followup.dispatchEvent('compositionend');
  assert.deepEqual(await cmd('asrSnapshot'), beforeVoice);
  checks.push('Genie owns F8; composing Escape does not close Genie or start/cancel dictation');
  await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), true);
  await assert.rejects(cmd('sendMessage', { sessionId, text: draft, revision: 1 }), /genie_busy/);
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/genie-${packaged ? 'packaged' : 'native'}.png` });
  await button('Replace selection').click(); await button('Undo replacement').waitFor();
  assert.equal(await composer().inputValue(), draft.slice(0, start) + 'caught off guard' + draft.slice(end));
  assert.equal(await composer().evaluate(n => n === document.activeElement), true);
  let view = await cmd('loadSession', { sessionId }); assert.deepEqual(view.messages, originalView.messages); assert.equal(view.requests.length, 0);
  await button('Undo replacement').click(); await poll(async () => await composer().inputValue() === draft);
  assert.equal(count(), 1); checks.push('IME guard, Unicode repeated-range capture, focus trap, main IPC exclusion, exact apply/undo and no transcript pollution');

  await composer().fill('This wording works.'); await select(19, 19); mode = 'same';
  const beforeSame=count(); await button('Genie').click(); await poll(async()=>count()===beforeSame+1); await ready(); assert.equal(await button('Use in draft').count(), 0);
  const before = count(); await page.getByLabel('Tell Genie more', { exact: true }).fill('Saved unfinished follow-up.');
  await page.keyboard.press('Escape'); await button('Genie').waitFor();
  await button('Genie').click(); await ready(); assert.equal(count(), before);
  assert.equal(await page.getByLabel('Tell Genie more', { exact: true }).inputValue(), 'Saved unfinished follow-up.');
  await page.reload(); await page.getByRole('dialog', { name: 'Genie' }).waitFor();
  assert.equal(count(), before); assert.equal(await page.getByLabel('Tell Genie more', { exact: true }).inputValue(), 'Saved unfinished follow-up.');
  checks.push('Exact no-change suppression, Escape, matching resume and renderer reload without inference');

  mode = 'clarify'; await page.getByLabel('Tell Genie more', { exact: true }).fill('무슨 뜻인지 /end');
  await button('Ask Genie').click(); await ready(); assert.equal((await cmd('loadSession', { sessionId })).session.state, 'draft');
  assert.equal(mock.requests.at(-1).messages.at(-1).content, '무슨 뜻인지 /end');
  assert.equal(JSON.parse(mock.requests.at(-1).messages.at(-2).content).suggested_text, 'This wording works.');
  mode = 'suggest'; await page.getByLabel('Tell Genie more', { exact: true }).fill('Yes, the question was unexpected.');
  await button('Ask Genie').click(); await button('Use in draft').waitFor();
  mode = 'bad'; await page.getByLabel('Tell Genie more', { exact: true }).fill('Another wording?'); await button('Ask Genie').click(); await button('Retry help').waitFor();
  assert.equal(await button('Use in draft').count(), 0); checks.push('Ordinary Korean follow-ups, actual assistant JSON history, literal /end and invalidation of old candidates');

  mode = 'suggest'; await button('Change target').click();
  const target = page.getByLabel('Select a new target in your original draft');
  await target.focus();
  await target.evaluate(n => n.setSelectionRange(5, 5));
  for (let i = 0; i < 7; i++) await app.evaluate(({ BrowserWindow }) => {
    const web = BrowserWindow.getAllWindows()[0].webContents;
    web.sendInputEvent({ type: 'keyDown', keyCode: 'Right', modifiers: ['shift'] });
    web.sendInputEvent({ type: 'keyUp', keyCode: 'Right', modifiers: ['shift'] });
  });
  assert.deepEqual(await target.evaluate(n => [n.selectionStart, n.selectionEnd]), [5, 12]);
  await button('Help with selection').click(); await button('Replace selection').waitFor();
  assert.equal(JSON.parse(mock.requests.at(-1).messages[1].content).target_selection.text, 'wording');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(720, 640));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.screenshot({ path: `test-results/genie-${packaged ? 'packaged' : 'native'}-narrow.png` });
  const bounds = await page.getByRole('dialog', { name: 'Genie' }).boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
  for (const control of [page.getByLabel('Tell Genie more', { exact: true }), button('Ask Genie')]) {
    const box = await control.boundingBox();
    assert.ok(box.y >= bounds.y && box.y + box.height <= bounds.y + bounds.height - 12, 'Follow-up controls must be fully visible without scrolling at minimum size');
  }
  assert.equal(await page.locator('.genie-columns').evaluate(n => n.scrollHeight > n.clientHeight + 1), false, 'The dialog body must not nest another scroll area around the history');
  checks.push('Explicit selected-target restart, visible narrow follow-up controls, no outer nested scrolling and reduced-motion layout');

  mode = 'hold'; await button('Start over').click(); await poll(() => !!release); const heldCount = count();
  await button('Close Genie').click(); await button('Genie').waitFor(); release(); release = null;
  await button('Genie').click(); await button('Retry help').waitFor(); assert.equal(count(), heldCount);
  mode = 'suggest'; await button('Retry help').click(); await ready();
  await button('Close Genie').click(); assert.equal(await composer().inputValue(), 'This wording works.');
  const beforeClose = count(); await close(); await launch();
  assert.equal(await composer().inputValue(), 'This wording works.'); assert.equal((await cmd('genieSnapshot')).episode, null); assert.equal(count(), beforeClose);
  await button('Start with your own topic').click(); await composer().fill('I want say this better.'); await button('Genie').click(); await ready();
  assert.deepEqual(JSON.parse(mock.requests.at(-1).messages[1].content).main_chat, []);
  await button('Use in draft').click(); await button('Undo replacement').waitFor(); await close(); await launch();
  assert.equal(await composer().inputValue(), 'caught off guard'); assert.equal((await cmd('loadSession', { sessionId })).messages.length, 0);
  checks.push('Explicit cancellation/retry, preserved unsent draft, ephemeral restart, direct-entry context and durable applied draft');
  await button('Record').click(); await poll(async () => (await cmd('asrSnapshot')).progress?.samples >= 16000);
  assert.equal(await button('Genie').isDisabled(), true); await button('Stop and transcribe').click();
  await poll(async () => (await composer().inputValue()).includes('한국어도 말해요.'));
  const voiceText = await composer().inputValue(); await select(voiceText.length, voiceText.length);
  await button('Genie').click(); await ready(); await button('Use in draft').click(); await button('Undo replacement').waitFor();
  const voice = (await cmd('asrSnapshot')).records.find(r => r.inserted && !r.submitted);
  assert.ok(voice); assert.equal(voice.draftBinding.textHash, createHash('sha256').update('caught off guard').digest('hex'));
  assert.equal((await cmd('loadSession', { sessionId })).messages.length, 0);
  await button('Undo replacement').click(); await poll(async () => await composer().inputValue() === voiceText);
  assert.equal((await cmd('asrSnapshot')).records.find(r => r.id === voice.id).draftBinding.textHash, createHash('sha256').update(voiceText).digest('hex'));
  checks.push('Actual fake-microphone ASR exclusion, inserted draft apply/undo provenance and no sending');
  const rawDraft = 'First.\r\nsame\r\nsame';
  await cmd('saveDraft', { sessionId, text: rawDraft, revision: Date.now() * 1000 + 10 });
  await page.reload(); await composer().waitFor();
  const display = rawDraft.replace(/\r\n/g, '\n');
  await poll(async () => await composer().inputValue() === display);
  const selectedStart = display.lastIndexOf('same'); await select(selectedStart, selectedStart + 4);
  await button('Genie').click(); await button('Replace selection').waitFor();
  assert.equal(JSON.parse(mock.requests.at(-1).messages[1].content).target_selection.start, rawDraft.lastIndexOf('same'));
  await button('Replace selection').click(); await button('Undo replacement').waitFor();
  assert.equal((await cmd('loadSession', { sessionId })).session.draft, 'First.\r\nsame\r\ncaught off guard');
  await button('Undo replacement').click(); await poll(async () => (await cmd('loadSession', { sessionId })).session.draft === rawDraft);
  checks.push('Imported CRLF draft selection converts browser offsets and preserves every unselected line-ending byte');
  assert.deepEqual(errors, []); await close();
  const report = { at: new Date().toISOString(), packaged, directory, checks, genieCalls: count(), externalCalls: 0, errors };
  writeFileSync(`test-results/genie-${packaged ? 'packaged' : 'native'}.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: 'test-results/genie-failure.png' }); }
  throw error;
} finally { release?.(); await app?.close().catch(() => undefined); await new Promise(r => mock.server.close(r)); }
