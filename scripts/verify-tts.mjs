import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const require = createRequire(import.meta.url);
const live = process.argv.includes('--live');
const packaged = live || process.argv.includes('--packaged');
const runDirectory = live ? process.argv[process.argv.indexOf('--run-dir') + 1] : undefined;
const gate = live ? await (await import('./tts-live-gate.mjs')).speechGate(runDirectory) : null;
const directory = live ? join(runDirectory, 'app-data') : mkdtempSync(join(tmpdir(), 'stomylos-native-tts-'));
const { server, requests, endpoint } = await startMockGateway({ delay: 1, speechHandler: gate?.handler });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: endpoint, ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) }; delete env.ELECTRON_RUN_AS_NODE;
let application; let page; const errors = []; const report = { directory, checks: [], errors };
const speechCalls = () => requests.filter(r => r.model === 'x-ai/grok-voice-tts-1.0');
async function waitForState(predicate) {
  const until = Date.now() + (live ? 190000 : 30000);
  while (Date.now() < until) {
    if (await page.evaluate(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for speech state');
}
async function launch() {
  application = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/linux-unpacked/stomylos') : require('electron'), args: [...(packaged ? [] : ['.']), ...(!live ? ['--use-fake-device-for-media-stream'] : [])], env, chromiumSandbox: true });
  page = await application.firstWindow(); page.setDefaultTimeout(live ? 190000 : 30000); page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name: 'Listen', exact: true }).first().waitFor();
}
async function close() {
  const exited = new Promise(resolve => application.process().once('exit', resolve));
  await page.evaluate(() => window.stomylos.command('close')); await exited; application = null;
}
try {
  await launch();
  assert.equal(speechCalls().length, 0);
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await page.getByRole('button', { name: 'Pause speech' }).waitFor();
  assert.equal(speechCalls().length, 1); assert.ok(speechCalls()[0].input.startsWith('[long-pause]'));
  if (!live) {
    await page.getByRole('textbox', { name: 'Your message', exact: true }).focus();
    await page.keyboard.press('F8');
    await page.getByRole('button', { name: 'Cancel recording', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Pause speech' }).waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('textarea[aria-label="Your message"]').readOnly);
    assert.equal(speechCalls().length, 1);
    assert.equal(requests.filter(r => r.model === 'microsoft/mai-transcribe-2').length, 0);
    await page.getByRole('button', { name: 'Play speech' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Pause speech' }).count(), 0);
    await page.getByRole('button', { name: 'Play speech' }).click();
    await page.getByRole('button', { name: 'Pause speech' }).waitFor();
    report.checks.push('F8 stops active cached TTS; Esc makes no ASR call; speech resumes only on explicit Play without generation');
  }
  await page.getByRole('button', { name: 'Pause speech' }).click();
  await page.getByRole('slider', { name: 'Speech position' }).fill('1');
  await page.getByRole('button', { name: 'Stop speech' }).click();
  await page.getByRole('button', { name: 'Play speech' }).click();
  await page.getByRole('button', { name: 'Pause speech' }).waitFor(); assert.equal(speechCalls().length, 1);
  report.checks.push('Manual default; cached MP3 playback, pause, seek, stop and replay without new request');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const checkbox = page.getByRole('checkbox', { name: 'Automatic speech' });
  assert.equal(await checkbox.isChecked(), false); await checkbox.click();
  await waitForState(() => window.stomylos.command('speechSnapshot').then(s => s.mode === 'automatic'));
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('textbox', { name: 'Your message' }).fill('I enjoy walking in the morning.');
  await page.getByRole('button', { name: /Send/ }).click();
  await waitForState(() => window.stomylos.command('speechSnapshot').then(s => s.items.filter(i => i.state === 'ready').length === 2));
  await page.locator('.bubble').last().getByRole('button', { name: 'Pause speech' }).waitFor();
  assert.equal(speechCalls().length, 2);
  const state = await page.evaluate(() => window.stomylos.command('speechSnapshot'));
  assert.equal(state.items.filter(i => i.state === 'ready').length, 2);
  const media = await application.evaluate(async ({ net }, id) => {
    const url = `stomylos://app/speech/${id}`;
    const part = await net.fetch(url, { headers: { Range: 'bytes=0-9' } });
    const head = await net.fetch(url, { method: 'HEAD' });
    const invalid = await net.fetch(url, { headers: { Range: 'bytes=999999999999-' } });
    const rejected = await net.fetch('stomylos://app/speech/not-an-audio-id');
    return { status: part.status, bytes: (await part.arrayBuffer()).byteLength, range: part.headers.get('content-range'), head: head.status, headBytes: (await head.arrayBuffer()).byteLength, invalid: invalid.status, rejected: rejected.status };
  }, state.items.find(i => i.state === 'ready').audioId);
  assert.equal(media.status, 206); assert.equal(media.bytes, 10); assert.ok(media.range.startsWith('bytes 0-9/'));
  assert.equal(media.head, 200); assert.equal(media.headBytes, 0); assert.equal(media.invalid, 416); assert.equal(media.rejected, 404);
  report.checks.push('Custom protocol validates media identity and handles GET/HEAD, valid ranges and invalid ranges');

  const snapshot = await page.evaluate(() => window.stomylos.command('snapshot'));
  const view = await page.evaluate(id => window.stomylos.command('loadSession', { sessionId: id }), snapshot.unfinished.id);
  assert.equal(view.messages.some(m => m.content.startsWith('[long-pause]')), false);
  report.checks.push('Automatic opt-in generates one completed reply; stored text has no application prefix');
  await page.getByRole('button', { name: 'Stop speech' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Automatic speech' }).click();
  await waitForState(() => window.stomylos.command('speechSnapshot').then(s => s.mode === 'manual'));
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('textbox', { name: 'Your message' }).fill('The trees are pleasant.');
  await page.getByRole('button', { name: /Send/ }).click();
  await waitForState(async () => { const app = await window.stomylos.command('snapshot'); const view = await window.stomylos.command('loadSession', { sessionId: app.unfinished.id }); return view.messages.length === 5 && view.messages.at(-1).delivery === 'complete'; });
  await page.locator('.bubble').last().getByRole('button', { name: 'Listen', exact: true }).waitFor();
  assert.equal(speechCalls().length, 2);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Automatic speech' }).click();
  await waitForState(() => window.stomylos.command('speechSnapshot').then(s => s.mode === 'automatic'));
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(speechCalls().length, 2);
  mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/tts-native.png' });
  await close(); await launch();
  assert.equal(speechCalls().length, 2); assert.equal((await page.evaluate(() => window.stomylos.command('speechSnapshot'))).mode, 'automatic');
  await page.getByRole('button', { name: 'Play speech' }).first().click();
  await page.getByRole('button', { name: 'Pause speech' }).waitFor(); assert.equal(speechCalls().length, 2);
  report.checks.push('Mode persists; restart does not backfill or replay; cached replay survives restart');
  if (!live) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Connection & data', exact: true }).click();
  await page.getByRole('button', { name: 'Clear saved speech', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm clear speech' }).click();
  await waitForState(() => window.stomylos.command('speechSnapshot').then(s => s.cacheBytes === 0));
  assert.equal(speechCalls().length, 2); report.checks.push('Explicit clear removes cached audio without network or transcript deletion');
  }
  assert.deepEqual(errors, []); await close(); report.status = 'passed';
} finally {
  await application?.close().catch(() => undefined); await new Promise(resolve => server.close(resolve)); await gate?.finish();
  mkdirSync('test-results', { recursive: true }); writeFileSync(live ? 'test-results/tts-live-report.json' : packaged ? 'test-results/tts-package-report.json' : 'test-results/tts-native-report.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
