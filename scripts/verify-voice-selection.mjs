// Bounded isolated Settings/player check. No provider calls or normal data.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'stomylos-voice-selection-'));
const output = 'test-results/voice-selection'; mkdirSync(output, { recursive: true });
const controlsOnly = process.argv.includes('--preview-controls-only');
const mock = await startMockGateway({ delay: 1, ...(controlsOnly ? { speechHandler: async (_input, response) => {
  await new Promise(resolve => setTimeout(resolve, 700));
  if (response.destroyed) return;
  response.writeHead(200, { 'content-type': 'audio/mpeg' });
  response.end(readFileSync(new URL('../tests/fixtures/speech-tone.mp3', import.meta.url)));
} } : {}) });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
let app, page;
const errors = [], checks = [];
const calls = () => mock.requests.filter(r => r.model === 'x-ai/grok-voice-tts-1.0');
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], env, chromiumSandbox: true });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Listen', exact: true }).first().waitFor();
}
async function close() {
  if (!app) return;
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await page.evaluate(() => window.stomylos.command('close')); await exited; app = null;
}
async function settings() { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Voice', exact: true }).click(); }
async function voice(id) {
  await page.getByRole('combobox', { name: 'Voice', exact: true }).selectOption(id);
  await waitState(async id => (await window.stomylos.command('speechSnapshot')).voice === id, id);
  await page.waitForFunction(() => !document.querySelector('#speech-voice').disabled);
}
async function waitState(predicate, arg) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, arg)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Voice state did not settle');
}
async function previewReady() {
  await page.getByRole('button', { name: 'Play voice sample', exact: true }).click();
  await waitState(async () => (await window.stomylos.command('speechSnapshot')).preview?.state === 'ready');
}
try {
  await launch(); await settings();
  if (controlsOnly) {
    const row = page.locator('.voice-selection');
    const play = () => page.getByRole('button', { name: 'Play voice sample', exact: true });
    const cancel = () => page.getByRole('button', { name: 'Cancel preview generation', exact: true });
    const stop = () => page.getByRole('button', { name: 'Stop voice sample', exact: true });
    assert.equal(await row.locator('button').count(), 1);
    assert.equal(await row.locator('button').innerText(), '');
    await play().focus(); await page.keyboard.press('Enter');
    await cancel().waitFor(); assert.equal(await cancel().isEnabled(), true);
    await cancel().click();
    await page.getByRole('button', { name: 'Retry voice sample', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Retry voice sample', exact: true }).click();
    await stop().waitFor(); assert.equal(await row.locator('button').count(), 1);
    assert.equal(await stop().evaluate(e => e === document.activeElement), true);
    await page.keyboard.press('Space'); await play().waitFor();
    const generated = calls().length;
    await play().click(); await stop().waitFor(); await play().waitFor();
    assert.equal(calls().length, generated);
    checks.push('One icon-only control: keyboard play, enabled generation cancel, explicit retry, stop, natural end and cached replay');
    for (const width of [1180, 760]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 860), width);
      await page.screenshot({ path: `${output}/preview-control-${width}.png` });
      assert.equal(await page.locator('.settings-panel:not([hidden])').evaluate(n => n.scrollWidth > n.clientWidth), false);
    }
    checks.push('Icon beside selector fits wide/narrow Settings');
  } else if (process.argv.includes('--layout-only')) {
    for (const width of [1180, 760]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 860), width);
      await page.screenshot({ path: `${output}/voice-settings-${width}.png` });
      assert.equal(await page.locator('.settings-panel:not([hidden])').evaluate(n => n.scrollWidth > n.clientWidth), false);
    }
    checks.push('Voice selector layout at 1180 and 760 pixels, no panel overflow');
  } else {
  assert.deepEqual(await page.getByRole('combobox', { name: 'Voice', exact: true }).locator('option').allTextContents(), ['Ara', 'Eve', 'Leo', 'Rex', 'Sal']);
  assert.equal(await page.getByRole('combobox', { name: 'Voice', exact: true }).inputValue(), 'ara');
  await voice('eve'); assert.equal(calls().length, 0);
  const before = await page.evaluate(async () => { const a = await window.stomylos.command('snapshot'); return (await window.stomylos.command('loadSession', { sessionId: a.unfinished.id })).messages; });
  await previewReady(); assert.equal(calls().length, 1); assert.equal(calls()[0].voice, 'eve');
  assert.equal(calls()[0].input, "[long-pause]Hi! I'm here to help you practice English. What would you like to talk about today?");
  await page.getByRole('button', { name: 'Stop voice sample', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop voice sample', exact: true }).click();
  await previewReady(); assert.equal(calls().length, 1);
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  await page.getByRole('tab', { name: 'Voice', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Stop voice sample', exact: true }).count(), 0);
  const after = await page.evaluate(async () => { const a = await window.stomylos.command('snapshot'); return (await window.stomylos.command('loadSession', { sessionId: a.unfinished.id })).messages; });
  assert.deepEqual(after, before);
  checks.push('Five choices, selection without synthesis, Eve preview, cached replay, tab cancellation, unchanged transcript');
  await page.getByRole('combobox', { name: 'Voice', exact: true }).focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => !document.querySelector('#speech-voice').disabled);
  await voice('sal'); await previewReady(); assert.equal(calls().length, 2);
  await page.screenshot({ path: `${output}/voice-settings.png` });
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).evaluate(e => document.activeElement === e), true);
  await page.getByRole('button', { name: 'Listen', exact: true }).first().click();
  await waitState(async () => (await window.stomylos.command('speechSnapshot')).items.some(i => i.state === 'ready'));
  assert.equal(calls().length, 3); assert.equal(calls()[2].voice, 'sal');
  checks.push('Keyboard selection, close/focus restoration and reply Listen uses Sal');
  await close(); await launch(); assert.equal(calls().length, 3); await settings();
  assert.equal(await page.getByRole('combobox', { name: 'Voice', exact: true }).inputValue(), 'sal');
  await previewReady(); assert.equal(calls().length, 3);
  await voice('eve'); await previewReady(); assert.equal(calls().length, 3);
  checks.push('Restart keeps Sal without automatic work; Sal and Eve preview caches survive');
  await page.getByRole('tab', { name: 'Connection & data', exact: true }).click();
  await page.getByRole('button', { name: 'Clear saved speech', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm clear speech', exact: true }).click();
  await waitState(async () => (await window.stomylos.command('speechSnapshot')).cacheBytes === 0);
  checks.push('Clear saved speech removes reply and preview variants');
  }
  assert.deepEqual(errors, []);
} finally {
  await close().catch(() => app?.close()); await new Promise(resolve => mock.server.close(resolve));
  writeFileSync(`${output}/${controlsOnly ? 'preview-controls-report' : process.argv.includes('--layout-only') ? 'layout-report' : 'report'}.json`, JSON.stringify({ directory, checks, errors, speechRequests: calls().length }, null, 2));
}
console.log(JSON.stringify({ checks, errors, speechRequests: calls().length }, null, 2));
