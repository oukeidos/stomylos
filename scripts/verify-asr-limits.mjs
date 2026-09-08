import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
if (!process.argv.includes('--realtime')) throw new Error('This optional real-time soak takes up to ten minutes. Pass --realtime explicitly; ordinary npm test uses a deterministic audio clock.');
const require = createRequire(import.meta.url);
const kind = process.argv.includes('--noise') ? 'noise' : 'time';
const packaged = process.argv.includes('--packaged');
const directory = mkdtempSync(join(tmpdir(), `stomylos-asr-${kind}-`));
// Long deterministic input is generated locally; none is sent to a real ASR model.
const samples = 16000 * 610, pcm = Buffer.alloc(samples * 2); let random = 1;
for (let i = 0; i < samples; i++) {
  let value;
  if (kind === 'noise') { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; value = (random << 16) >> 16; }
  else value = Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / 16000));
  pcm.writeInt16LE(value, i * 2);
}
const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24);
header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
const wav = join(directory, 'input.wav'); writeFileSync(wav, Buffer.concat([header, pcm]));
const report = { directory, kind, packaged, checks: [], fixtureSha256: createHash('sha256').update(readFileSync(wav)).digest('hex') };
const { server, endpoint, requests } = await startMockGateway();
const env = { ...process.env, STOMYLOS_DATA_DIR: join(directory, 'app-data'), STOMYLOS_TEST_ENDPOINT: endpoint,
  ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) }; delete env.ELECTRON_RUN_AS_NODE;
let app, page; const captured = createHash('sha256'); let capturedSamples = 0, sequence = 0;
try {
  app = await electron.launch({ executablePath: packaged ? resolve('release/linux-unpacked/stomylos') : require('electron'),
    args: [...(packaged ? [] : ['.']), '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`], env, chromiumSandbox: true });
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  await page.exposeFunction('auditCapturedPcm', (seq, values) => {
    assert.equal(seq, sequence++); const array = new Int16Array(values); captured.update(Buffer.from(array.buffer)); capturedSamples += array.length;
  });
  await page.evaluate(() => {
    const Original = window.AudioWorkletNode;
    window.captureAudits = [];
    window.AudioWorkletNode = class extends Original {
      constructor(...args) {
        super(...args);
        this.port.addEventListener('message', ({ data }) => {
          if (data.type === 'chunk') window.captureAudits.push(window.auditCapturedPcm(data.sequence, [...data.pcm]));
        });
      }
    };
  });
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Preserve this draft.');
  await page.evaluate(() => {
    window.frameAudit = { count: 0, over50: 0, max: 0, intervals: [] };
    let previous = performance.now();
    const frame = now => { const gap = now - previous; previous = now;
      if (!document.hidden) { window.frameAudit.count++; window.frameAudit.max = Math.max(window.frameAudit.max, gap);
        if (gap > 50) window.frameAudit.over50++; window.frameAudit.intervals.push(gap); }
      window.frameAudit.id = requestAnimationFrame(frame);
    }; window.frameAudit.id = requestAnimationFrame(frame);
  });
  let peakWorkingSetKiB = 0, initialWorkingSetKiB = 0;
  const started = Date.now(); await page.getByRole('button', { name: 'Record', exact: true }).click();
  let lastReported = -1, sawWarning = false, finished;
  while (Date.now() - started < 660000) {
    await new Promise(done => setTimeout(done, 1000));
    const state = await page.evaluate(() => window.stomylos.command('asrSnapshot'));
    const record = state.records.find(r => r.id === state.activeId);
    assert.equal(requests.length, 0, 'Capture/automatic stop must not upload');
    const seconds = (state.progress?.samples ?? 0) / 16000;
    const minute = Math.floor(seconds / 60);
    const memory = await app.evaluate(({ app }) => app.getAppMetrics().reduce((sum, metric) => sum + metric.memory.workingSetSize, 0));
    if (!initialWorkingSetKiB) initialWorkingSetKiB = memory;
    peakWorkingSetKiB = Math.max(peakWorkingSetKiB, memory);
    if (minute !== lastReported) { lastReported = minute; console.log(JSON.stringify({ kind, seconds, bytes: state.progress?.bytes ?? 0, phase: record?.phase })); }
    sawWarning ||= await page.getByText('Recording is approaching its limit.', { exact: false }).count() > 0;
    if (record?.phase === 'ready' || record?.phase === 'failed') { finished = { state, record }; break; }
  }
  assert.ok(finished, 'Capture must stop by its deadline');
  assert.equal(finished.record.phase, 'ready');
  assert.equal(finished.record.stopReason, kind === 'time' ? 'time' : 'size');
  assert.equal(sawWarning, true);
  assert.equal(await page.getByRole('textbox', { name: 'Your message', exact: true }).inputValue(), 'Preserve this draft.');
  await page.evaluate(() => Promise.all(window.captureAudits));
  assert.equal(capturedSamples, finished.state.progress.samples);
  if (kind === 'time') { assert.equal(capturedSamples, 9600000); assert.ok(Date.now() - started >= 599000); }
  else assert.ok(capturedSamples < 9600000);
  const encoded = Buffer.from(await app.evaluate(async ({ net }, id) => {
    const response = await net.fetch(`stomylos://app/dictation/${id}`); return Buffer.from(await response.arrayBuffer()).toString('base64');
  }, finished.state.audioId), 'base64');
  assert.ok(encoded.length <= 14 * 1024 * 1024);
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { input: encoded, maxBuffer: 25 * 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr.toString()); assert.equal(decoded.stdout.length, capturedSamples * 2);
  report.capturedSha256 = captured.digest('hex'); report.decodedSha256 = createHash('sha256').update(decoded.stdout).digest('hex');
  assert.equal(report.decodedSha256, report.capturedSha256);
  report.memory = { initialWorkingSetKiB, peakWorkingSetKiB };
  report.frames = await page.evaluate(() => { const audit = window.frameAudit; cancelAnimationFrame(audit.id);
    const sorted = audit.intervals.sort((a, b) => a - b); return { count: audit.count, max: audit.max, over50: audit.over50, p95: sorted[Math.floor(sorted.length * .95)] }; });
  assert.ok(report.frames.p95 < 25, 'Recording should retain 60-Hz frame pacing');
  report.duration = capturedSamples / 16000; report.audioBytes = encoded.length; report.elapsedSeconds = (Date.now() - started) / 1000;
  const audio = page.getByLabel('Recorded audio');
  await audio.evaluate(async a => { await a.play(); });
  await page.waitForFunction(() => document.querySelector('audio[aria-label="Recorded audio"]').currentTime > 0);
  await audio.evaluate(a => { a.pause(); a.currentTime = Math.max(0, a.duration - 1); });
  assert.equal(requests.length, 0);
  report.checks.push('Real-time worklet capture; advance warning; first limit stop; unchanged draft and zero requests');
  report.checks.push('Every emitted PCM sample, including final queued chunks, matches an independent FFmpeg decode');
  report.checks.push('Native FLAC playback and seek after automatic stop; audio remains local');
  await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Your message"]').value.includes('Um, I goes walking.'));
  assert.equal(requests.length, 1); assert.equal(requests[0].model, 'microsoft/mai-transcribe-2');
  report.bodyBytes = Buffer.byteLength(JSON.stringify(requests[0])); assert.ok(report.bodyBytes <= 19 * 1024 * 1024);
  assert.deepEqual(failures, []); report.checks.push('Only fresh Transcribe sends one eligible mock request; no chat submission');
  mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: `test-results/asr-${kind}-limit.png` });
  const exited = new Promise(done => app.process().once('exit', done)); await page.evaluate(() => window.stomylos.command('close')); await exited; app = null;
  report.status = 'passed';
} catch (error) { report.failure = String(error.stack ?? error); throw error; }
finally {
  if (page && !page.isClosed()) {
    report.lastState = await page.evaluate(() => window.stomylos.command('asrSnapshot')).catch(() => null);
    if (report.lastState?.activeId) await page.evaluate(id => window.stomylos.command('asrCancel', { id, discard: true }), report.lastState.activeId).catch(() => undefined);
  }
  await app?.close().catch(() => undefined); await new Promise(done => server.close(done));
  mkdirSync('test-results', { recursive: true }); writeFileSync(`test-results/asr-${kind}-limit${packaged ? '-package' : ''}.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
