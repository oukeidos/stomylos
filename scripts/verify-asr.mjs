import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const require = createRequire(import.meta.url);
const packaged = process.argv.includes('--packaged');
const directory = mkdtempSync(join(tmpdir(), 'stomylos-native-asr-'));
let holdTranscription = false, releaseTranscription;
let responseText = 'Um, I goes walking. 한국어도 말해요.', responseStatus = 200;
const { server, requests, endpoint } = await startMockGateway({ delay: 1, asrHandler: async (_input, response) => {
  if (holdTranscription) await new Promise(resolve => { releaseTranscription = resolve; });
  response.writeHead(responseStatus, { 'content-type': 'application/json', 'x-generation-id': 'public-asr-mock' });
  response.end(JSON.stringify({ text: responseText, usage: { cost: 0 } }));
} });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: endpoint,
  ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) }; delete env.ELECTRON_RUN_AS_NODE;
const report = { directory, packaged, checks: [], errors: [], inputEvents: [] };
let application, page;
const asrCalls = () => requests.filter(r => r.model === 'microsoft/mai-transcribe-2');
const snapshot = () => page.evaluate(() => window.stomylos.command('asrSnapshot'));
async function launch() {
  application = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/linux-unpacked/stomylos') : require('electron'),
    args: [...(packaged ? [] : ['.']), '--use-fake-device-for-media-stream'], env, chromiumSandbox: true });
  page = await application.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', e => report.errors.push(e.message));
  await page.exposeFunction('recordInputEvent', event => report.inputEvents.push(event));
  await page.evaluate(() => {
    window.originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    for (const type of ['beforeinput', 'input', 'compositionstart', 'compositionend']) document.addEventListener(type, event => {
      if (event.target?.matches('textarea[aria-label="Your message"]')) void window.recordInputEvent({ type, trusted: event.isTrusted,
        inputType: event.inputType, data: event.data, value: event.target.value, at: Date.now() });
    });
  });
  await page.getByRole('button', { name: 'Record', exact: true }).waitFor();
}
async function close() {
  const exited = new Promise(done => application.process().once('exit', done));
  await page.evaluate(() => window.stomylos.command('close')); await exited; application = null;
}
async function poll(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(done => setTimeout(done, 100)); }
  throw new Error('Authoritative state did not reach the expected condition');
}
async function recordedSecond() {
  await poll(async () => { const s = await snapshot(); const active = s.records.find(r => r.id === s.activeId); return active?.phase === 'recording' && (s.progress?.samples ?? 0) >= 16000; });
}
try {
  await launch();
  const denied = await page.evaluate(async () => {
    try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(t => t.stop()); return 'granted'; }
    catch (error) { return error.name; }
  });
  assert.equal(denied, 'NotAllowedError'); report.checks.push('Microphone denied outside explicit Record; no fake permission UI bypass');
  const original = 'Original draft.\n  ';
  let composer = page.getByRole('textbox', { name: 'Your message', exact: true });
  await composer.fill(original);
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await recordedSecond();
  assert.equal(await composer.getAttribute('readonly'), '');
  assert.equal(await page.getByRole('button', { name: 'Listen', exact: true }).isDisabled(), true);
  assert.equal(requests.length, 0);
  await composer.dispatchEvent('compositionstart');
  await composer.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  await composer.dispatchEvent('compositionend');
  await composer.dispatchEvent('keydown', { key: 'Enter', repeat: true, bubbles: true });
  assert.equal(requests.length, 0);
  await page.getByRole('button', { name: 'Cancel recording' }).click();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="Your message"]').readOnly);
  assert.equal(await composer.inputValue(), original); assert.equal(requests.length, 0);
  assert.equal((await snapshot()).records.at(-1).discarded, true);
  report.checks.push('Native capture; read-only selectable draft; TTS exclusion; zero-upload cancellation preserves exact draft');

  await composer.focus();
  const beforeKeys = (await snapshot()).records.length;
  await composer.dispatchEvent('compositionstart');
  await page.keyboard.press('F8');
  await composer.dispatchEvent('compositionend');
  await page.keyboard.press('Shift+F8');
  assert.equal((await snapshot()).records.length, beforeKeys);
  await page.keyboard.down('F8'); await recordedSecond();
  const heldId = (await snapshot()).activeId;
  for (let n = 0; n < 10; n++) await page.keyboard.down('F8');
  assert.equal((await snapshot()).activeId, heldId); assert.equal(requests.length, 0);
  await page.keyboard.up('F8');
  await composer.dispatchEvent('compositionstart');
  await page.keyboard.press('Escape');
  assert.equal((await snapshot()).records.find(r => r.id === heldId).phase, 'recording');
  await composer.dispatchEvent('compositionend');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="Your message"]').readOnly);
  assert.equal(await composer.inputValue(), original); assert.equal(requests.length, 0);
  report.checks.push('F8 ignores IME/modified keys and held repeats; composing Esc does not cancel; fresh Esc cancels without upload');

  // Delay permission resolution so a second fresh F8 deterministically queues stop.
  await page.evaluate(() => {
    window.originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      await new Promise(resolve => { window.releaseOpening = resolve; });
      return window.originalGetUserMedia(constraints);
    };
  });
  await composer.focus(); await page.keyboard.press('F8');
  await page.waitForFunction(() => !!window.releaseOpening);
  await page.keyboard.press('F8');
  await page.getByText('Opening microphone… Stop requested. Esc cancels without uploading.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.releaseOpening(); navigator.mediaDevices.getUserMedia = window.originalGetUserMedia; });
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="Your message"]').readOnly);
  assert.equal(requests.length, 0); assert.equal(await composer.inputValue(), original);
  report.checks.push('Second F8 during microphone initialization queues one stop; Esc overrides it without dispatch');

  await page.getByRole('button', { name: 'Record', exact: true }).click(); await recordedSecond();
  const libraryToggle = page.locator('.history-toggle');
  await libraryToggle.waitFor();
  if (await libraryToggle.getAttribute('aria-expanded') !== 'true') await libraryToggle.click();
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await page.getByRole('dialog', { name: 'Discard this recording?' }).waitFor();
  await page.keyboard.down('Escape');
  await page.keyboard.down('Escape');
  await page.keyboard.up('Escape');
  await page.getByRole('dialog', { name: 'Discard this recording?' }).waitFor({state:'hidden'});
  await composer.waitFor();
  const staying=await snapshot(); assert.equal(staying.records.find(r => r.id === staying.activeId)?.phase,'recording');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor();
  await page.keyboard.press('F8');
  const inSettings = await snapshot(); assert.equal(inSettings.activeId, staying.activeId); assert.equal(inSettings.records.find(r => r.id === staying.activeId)?.phase, 'recording');
  await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'hidden' });
  const afterSettings = await snapshot(); assert.equal(afterSettings.records.find(r => r.id === staying.activeId)?.phase, 'recording'); assert.equal(requests.length, 0);
  report.checks.push('Settings and its F8/Escape ownership preserve an existing recording without upload or discard');
  if (await page.getByRole('button', { name: 'Show history', exact: true }).count()) await page.getByRole('button', { name: 'Show history', exact: true }).click();
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Recent conversations', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  assert.equal(await composer.inputValue(), original); assert.equal(requests.length, 0);
  await poll(async()=>await composer.evaluate(n => n === document.activeElement));
  report.checks.push('Learning navigation invokes the recording guard: Stay preserves capture, Discard enters Learning with zero uploads and restores draft/focus on return');


  await page.getByRole('button', { name: 'Record', exact: true }).click(); await recordedSecond();
  await page.getByRole('button', { name: 'Stop and transcribe' }).click();
  const recognized = 'Um, I goes walking. 한국어도 말해요.';
  await page.waitForFunction(text => document.querySelector('textarea[aria-label="Your message"]').value === text, original + '\n' + recognized);
  await poll(async () => await composer.evaluate(n => n === document.activeElement && n.selectionStart === n.value.length));
  assert.equal(asrCalls().length, 1); assert.equal(requests.length, 1);
  assert.equal(asrCalls()[0].input_audio.format, 'flac');
  assert.equal(Buffer.from(asrCalls()[0].input_audio.data, 'base64').subarray(0, 4).toString(), 'fLaC');
  await page.locator('.dictation-details > summary').click();
  await page.waitForFunction(() => [...document.querySelectorAll('audio')].some(a => a.duration > 0));
  const audio = page.getByLabel('Recorded audio'); await audio.evaluate(a => a.play());
  await page.waitForFunction(() => [...document.querySelectorAll('audio')].some(a => a.currentTime > 0));
  await audio.evaluate(a => a.pause());
  assert.equal(requests.length, 1);
  report.checks.push('One explicit transcription returns raw mixed-language learner errors into unsent draft; native FLAC playback works');
  await composer.dispatchEvent('compositionstart');
  await composer.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  await composer.dispatchEvent('compositionend');
  await composer.dispatchEvent('keydown', { key: 'Enter', repeat: true, bubbles: true });
  assert.equal(requests.length, 1);
  assert.equal(await composer.inputValue(), original + '\n' + recognized);
  report.checks.push('IME composition and held Enter during capture and after insertion never submit the draft');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 620));
  await poll(async () => await page.evaluate(() => innerWidth >= 760 && innerHeight >= 620));
  const layout = await page.evaluate(() => {
    const voice = document.querySelector('.dictation').getBoundingClientRect();
    const draft = document.querySelector('textarea[aria-label="Your message"]').getBoundingClientRect();
    return { voice: { top: voice.top, bottom: voice.bottom, right: voice.right }, draft: { top: draft.top, bottom: draft.bottom, right: draft.right }, width: innerWidth, height: innerHeight };
  });
  assert.ok(layout.voice.top >= 0 && layout.voice.bottom <= layout.height && layout.voice.right <= layout.width);
  assert.ok(layout.draft.top >= 0 && layout.draft.bottom <= layout.height && layout.draft.right <= layout.width);
  assert.ok(layout.voice.bottom <= layout.draft.top || layout.draft.bottom <= layout.voice.top);
  mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/asr-minimum-layout.png' });
  report.checks.push('Voice panel and editable draft fit without overlap at the minimum window size');
  await page.locator('.dictation-result summary').click();
  const clipboardBefore = await application.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await page.getByRole('button', { name: 'Copy recognized text', exact: true }).click();
    await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), recognized);
  } finally { await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardBefore); }
  report.checks.push('Copy recognized text writes exact raw text to the native clipboard');

  await composer.focus(); await page.keyboard.press('F8'); await recordedSecond();
  await page.keyboard.press('F8');
  await page.waitForFunction(text => document.querySelector('textarea[aria-label="Your message"]').value === text, original + '\n' + recognized + '\n' + recognized);
  if (!await page.locator('.dictation-details').evaluate(node => node.open)) await page.locator('.dictation-details > summary').click();
  await page.getByRole('button', { name: 'Remove last dictation' }).click();
  await page.waitForFunction(text => document.querySelector('textarea[aria-label="Your message"]').value === text, original + '\n' + recognized);
  assert.equal(requests.length, 2);
  report.checks.push('F8 stop transcribes once into the existing draft; explicit removal preserves the preceding draft');
  await composer.fill('Edited before sending.');
  // Close through the real UI so its draft flush and provenance binding run.
  const beforeRestart = requests.length;
  const exited = new Promise(done => application.process().once('exit', done));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await exited; application = null;
  await launch();
  composer = page.getByRole('textbox', { name: 'Your message', exact: true });
  await poll(async () => await composer.inputValue() === 'Edited before sending.');
  assert.equal(requests.length, beforeRestart);
  assert.equal((await snapshot()).audioId, null);
  report.checks.push('Edited recognized draft survives normal close/restart without re-insertion or another request');
  await page.getByRole('button', { name: /^Send/ }).click();
  await poll(async () => await page.evaluate(async () => { const s = await window.stomylos.command('snapshot'); return s.activity.phase === 'idle' && !document.querySelector('textarea[aria-label="Your message"]').value; }));
  const records = readdirSync(join(directory, 'asr')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(directory, 'asr', name))));
  const linked = records.filter(r => r.submitted);
  assert.equal(linked.length, 1); assert.equal(linked[0].text, recognized); assert.equal(linked[0].submitted.edited, true);
  const message = await page.evaluate(async () => { const app = await window.stomylos.command('snapshot'); return (await window.stomylos.command('loadSession', { sessionId: app.unfinished.id })).messages.find(m => m.role === 'user'); });
  assert.equal(linked[0].submitted.messageId, message.id); assert.equal(message.content, 'Edited before sending.');
  report.checks.push('Additional dictation, exact unchanged-insertion removal, explicit edit/Send and actual committed-message provenance');

  await page.getByRole('button', { name: 'Record', exact: true }).click(); await recordedSecond();
  await page.getByRole('button', { name: 'End chat', exact: true }).click();
  await page.getByRole('dialog', { name: 'Discard this recording?' }).waitFor();
  await page.getByRole('button', { name: 'Stay', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel recording' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Record', exact: true }).waitFor();
  assert.equal(asrCalls().length, 2);
  report.checks.push('End-chat recording guard supports Stay; Escape cancels capture without another ASR request');
  await page.evaluate(() => {
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(...args) { super(...args); window.testCaptureContext = this; }
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await getUserMedia(constraints); window.testCaptureStream = stream; return stream;
    };
  });
  for (const interruption of ['context-suspend', 'track-ended', 'window-hide']) {
    await composer.fill('Keep interrupted draft.');
    await page.getByRole('button', { name: 'Record', exact: true }).click(); await recordedSecond();
    const samplesBefore = (await snapshot()).progress.samples;
    if (interruption === 'context-suspend') await page.evaluate(() => window.testCaptureContext.suspend());
    if (interruption === 'track-ended') await page.evaluate(() => {
      const track = window.testCaptureStream.getAudioTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended'));
    });
    if (interruption === 'window-hide') await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await poll(async () => { const s = await snapshot(); return s.records.find(r => r.id === s.activeId)?.phase === 'ready'; });
    if (interruption === 'window-hide') await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    const stopped = await snapshot();
    assert.equal(stopped.records.find(r => r.id === stopped.activeId).stopReason, 'interrupted');
    assert.ok(stopped.progress.samples >= samplesBefore);
    assert.equal(await composer.inputValue(), 'Keep interrupted draft.');
    assert.equal(asrCalls().length, 2);
    assert.equal(await page.evaluate(() => window.testCaptureStream.getTracks().every(track => track.readyState === 'ended')), true);
    await page.getByRole('button', { name: 'Transcribe', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Discard recording', exact: true }).click();
    report.checks.push(`${interruption}: retains captured audio/draft, releases tracks and requires explicit Transcribe or Discard`);
  }
  holdTranscription = true;
  await page.getByRole('button', { name: 'Record', exact: true }).click(); await recordedSecond();
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    buttons.find(b => b.textContent === 'Stop and transcribe').click();
    buttons.find(b => b.textContent === 'Cancel recording').click();
  });
  await poll(async () => { const s = await snapshot(); return s.records.find(r => r.id === s.activeId)?.discarded && !s.audioId; });
  assert.equal(asrCalls().length, 2);
  assert.equal(await composer.inputValue(), 'Keep interrupted draft.');
  report.checks.push('Same-turn Stop/Cancel race discards locally without upload or draft change');
  await page.getByRole('button', { name: 'Record', exact: true }).click(); await recordedSecond();
  await page.getByRole('button', { name: 'Stop and transcribe' }).click();
  await poll(async () => asrCalls().length === 3 && !!releaseTranscription);
  await composer.focus();
  for (let n = 0; n < 10; n++) await page.keyboard.press('F8');
  assert.equal(asrCalls().length, 3);
  await page.getByRole('button', { name: 'Cancel transcription', exact: true }).click();
  await poll(async () => { const s = await snapshot(); return s.records.find(r => r.id === s.activeId)?.phase === 'cancelled'; });
  releaseTranscription(); holdTranscription = false;
  assert.equal(await composer.inputValue(), 'Keep interrupted draft.');
  assert.equal(asrCalls().length, 3);
  await page.getByRole('button', { name: 'Retry transcription', exact: true }).click();
  await page.waitForFunction(text => document.querySelector('textarea[aria-label="Your message"]').value === text,
    'Keep interrupted draft.\n' + recognized);
  assert.equal(asrCalls().length, 4);
  const retried = await snapshot();
  assert.equal(retried.records.find(r => r.id === retried.activeId).attempts.length, 2);
  if (!await page.locator('.dictation-details').evaluate(node => node.open)) await page.locator('.dictation-details > summary').click();
  await page.getByRole('button', { name: 'Remove last dictation' }).click();
  report.checks.push('In-flight response cancellation preserves draft; only explicit retry uploads again and inserts once');
  await page.evaluate(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await getUserMedia(constraints);
      await new Promise(resolve => { window.releaseLateMicrophone = resolve; });
      return stream;
    };
  });
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await page.waitForFunction(() => typeof window.releaseLateMicrophone === 'function');
  await page.getByRole('button', { name: 'Cancel recording' }).click();
  await page.evaluate(() => window.releaseLateMicrophone());
  await page.waitForFunction(() => window.testCaptureStream.getTracks().every(track => track.readyState === 'ended'));
  assert.equal((await snapshot()).audioId, null);
  assert.equal(await composer.inputValue(), 'Keep interrupted draft.');
  assert.equal(asrCalls().length, 4);
  report.checks.push('Late getUserMedia resolution after Cancel releases all tracks without upload or draft change');
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = window.originalGetUserMedia; });

  // Use an actual second native window: plain blur keeps capture, F8 stays local.
  await composer.focus(); await page.keyboard.press('F8'); await recordedSecond();
  const visibleCapture = (await snapshot()).activeId;
  await application.evaluate(async ({ BrowserWindow }) => {
    globalThis.voiceMainWindow = BrowserWindow.getAllWindows()[0];
    const other = new BrowserWindow({ width: 360, height: 200 });
    globalThis.voiceOtherWindow = other;
    await other.loadURL('data:text/html,<title>Shortcut isolation</title><input autofocus>');
    other.setAlwaysOnTop(true); other.show(); other.moveTop();
    globalThis.voiceMainWindow.blur(); other.focus();
  });
  // Use native ownership: Playwright's own CDP session keeps DOM focus emulated.
  await poll(async () => await application.evaluate(() => !globalThis.voiceMainWindow.isFocused() && globalThis.voiceOtherWindow.isFocused()));
  await application.evaluate(() => {
    globalThis.voiceOtherWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F8' });
    globalThis.voiceOtherWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F8' });
  });
  assert.equal((await snapshot()).activeId, visibleCapture);
  assert.equal((await snapshot()).records.find(r => r.id === visibleCapture).phase, 'recording');
  assert.equal(asrCalls().length, 4);
  await application.evaluate(() => { globalThis.voiceOtherWindow.destroy(); globalThis.voiceMainWindow.focus(); });
  await composer.focus(); await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="Your message"]').readOnly);
  report.checks.push('Actual visible-window blur keeps recording; F8 in another native window does not stop or upload it');

  for (const name of ['NotAllowedError', 'NotFoundError']) {
    await page.evaluate(name => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Fixture device failure', name); }; }, name);
    await composer.focus(); await page.keyboard.press('F8');
    await page.getByText(name === 'NotAllowedError' ? 'Microphone access was denied.' : 'No microphone was found.', { exact: false }).waitFor();
    await poll(async () => await composer.evaluate(n => n === document.activeElement && !n.readOnly));
    assert.equal(await composer.inputValue(), 'Keep interrupted draft.'); assert.equal(asrCalls().length, 4);
  }
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
    window.normalVoiceTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => window.normalVoiceTimeout(callback, delay === 15000 ? 100 : delay, ...args);
  });
  await composer.focus(); await page.keyboard.press('F8');
  await page.getByText('The microphone did not open in time.', { exact: false }).waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label="Your message"]').readOnly);
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = window.originalGetUserMedia; window.setTimeout = window.normalVoiceTimeout; });
  assert.equal(asrCalls().length, 4);
  report.checks.push('Permission/device failures and accelerated initialization watchdog preserve draft, unlock and restore composer without a request');

  await page.evaluate(() => {
    window.normalVoiceNode = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends window.normalVoiceNode {
      constructor(...args) {
        super(...args);
        const post = this.port.postMessage.bind(this.port);
        this.port.postMessage = (...values) => { if (values[0] !== 'stop') post(...values); };
      }
    };
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await window.originalGetUserMedia(constraints); window.watchdogStream = stream; return stream;
    };
    window.setTimeout = (callback, delay, ...args) => window.normalVoiceTimeout(callback, delay === 5000 ? 100 : delay, ...args);
  });
  await composer.focus(); await page.keyboard.press('F8'); await recordedSecond(); await page.keyboard.press('F8');
  await page.getByText('Recording could not stop normally and was cancelled.', { exact: false }).waitFor();
  await page.waitForFunction(() => window.watchdogStream.getTracks().every(t => t.readyState === 'ended'));
  await page.evaluate(() => { window.AudioWorkletNode = window.normalVoiceNode; window.setTimeout = window.normalVoiceTimeout; navigator.mediaDevices.getUserMedia = window.originalGetUserMedia; });
  assert.equal(asrCalls().length, 4); assert.equal(await composer.inputValue(), 'Keep interrupted draft.');
  report.checks.push('Missing worklet stop acknowledgement triggers accelerated watchdog, releases tracks and never uploads');

  responseText = '';
  await page.evaluate(() => {
    window.normalVoiceContext = window.AudioContext;
    window.AudioContext = class extends window.normalVoiceContext {
      async resume() { await super.resume(); await new Promise(resolve => { window.releaseContextReady = resolve; }); }
    };
  });
  await composer.focus(); await page.keyboard.press('F8');
  await page.waitForFunction(() => !!window.releaseContextReady);
  await page.keyboard.press('F8'); await recordedSecond();
  await page.evaluate(() => { window.releaseContextReady(); window.AudioContext = window.normalVoiceContext; });
  await page.getByText('No readable speech was recognized. Your draft is unchanged.', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), 'Keep interrupted draft.'); assert.equal(asrCalls().length, 5);
  responseText = recognized; responseStatus = 503;
  await composer.focus(); await page.keyboard.press('F8'); await recordedSecond(); await page.keyboard.press('F8');
  await page.getByRole('button', { name: 'Retry transcription', exact: true }).waitFor();
  await poll(async () => await composer.evaluate(n => n === document.activeElement && !n.readOnly));
  await page.keyboard.press('F8'); assert.equal(asrCalls().length, 6);
  assert.equal(await composer.inputValue(), 'Keep interrupted draft.');
  await page.getByRole('button', { name: 'Discard recording', exact: true }).click(); responseStatus = 200;
  report.checks.push('Empty ASR result and failed transcription preserve draft; F8 never retries retained failed audio');

  holdTranscription = true; releaseTranscription = null;
  await composer.focus(); await page.keyboard.press('F8'); await recordedSecond(); await page.keyboard.press('F8');
  await poll(async () => asrCalls().length === 7 && !!releaseTranscription);
  await page.getByRole('button', { name: 'Settings', exact: true }).focus();
  releaseTranscription(); holdTranscription = false;
  await page.waitForFunction(text => document.querySelector('textarea[aria-label="Your message"]').value === text, 'Keep interrupted draft.\n' + recognized);
  assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).evaluate(n => n === document.activeElement), true);
  report.checks.push('Delayed success does not steal focus after the user moves to another control');
  mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/asr-native.png' });
  await close(); await launch();
  assert.equal(asrCalls().length, 7);
  assert.equal((await snapshot()).audioId, null);
  assert.deepEqual(report.errors, []); await close(); report.status = 'passed';
  report.checks.push('Restart preserves provenance and makes no automatic request; audio is ephemeral');
} catch (error) { report.failure = String(error.stack ?? error); console.error(report.failure); throw error; }
finally {
  releaseTranscription?.();
  if (page && !page.isClosed()) { mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/asr-last-state.png' }).catch(() => undefined); }
  if (application) await application.evaluate(({app}) => app.exit()).catch(() => undefined);
  server.closeAllConnections(); await new Promise(done => server.close(done));
  mkdirSync('test-results', { recursive: true }); writeFileSync(packaged ? 'test-results/asr-package-report.json' : 'test-results/asr-native-report.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
