// Short native proof that normalization rejects energy above the 16-kHz Nyquist limit.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const directory = mkdtempSync(join(tmpdir(), 'stomylos-asr-resample-'));
const rate = 48000, pcm = Buffer.alloc(rate * 20 * 2);
for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(9000 *
  (Math.sin(2 * Math.PI * 1000 * i / rate) + Math.sin(2 * Math.PI * 11000 * i / rate))), i * 2);
const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVEfmt ', 8);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
const wav = join(directory, 'two-tones-48khz.wav'); writeFileSync(wav, Buffer.concat([h, pcm]));
const { server, requests, endpoint } = await startMockGateway();
const env = { ...process.env, STOMYLOS_DATA_DIR: join(directory, 'app-data'), STOMYLOS_TEST_ENDPOINT: endpoint, STOMYLOS_PACKAGED_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let app; const report = { directory, status: 'running', checks: [] };
async function poll(fn) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Capture deadline exceeded'); }
try {
  app = await electron.launch({ executablePath: resolve('release/linux-unpacked/stomylos'), chromiumSandbox: true, env,
    args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] });
  const page = await app.firstWindow();
  await page.evaluate(() => {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async args => { const stream = await gum(args); window.captureSettings = stream.getAudioTracks()[0].getSettings(); return stream; };
  });
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  const snapshot = () => page.evaluate(() => window.stomylos.command('asrSnapshot'));
  await poll(async () => ((await snapshot()).progress?.samples ?? 0) >= 64000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await poll(async () => { const s = await snapshot(); return s.records.find(r => r.id === s.activeId)?.phase === 'ready'; });
  const state = await snapshot();
  assert.equal(requests.length, 0);
  const flac = Buffer.from(await app.evaluate(async ({ net }, id) => {
    const r = await net.fetch(`stomylos://app/dictation/${id}`); return Buffer.from(await r.arrayBuffer()).toString('base64');
  }, state.audioId), 'base64');
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], { input: flac, maxBuffer: 1024 * 1024 });
  assert.equal(decode.status, 0); const samples = decode.stdout;
  // Use a central one-second window to exclude stream startup and finalization.
  const amplitude = frequency => {
    let re = 0, im = 0;
    for (let i = 0; i < 16000; i++) { const v = samples.readInt16LE((16000 + i) * 2);
      re += v * Math.cos(2 * Math.PI * frequency * i / 16000); im += v * Math.sin(2 * Math.PI * frequency * i / 16000); }
    return Math.hypot(re, im) * 2 / 16000;
  };
  report.sourceRate = rate; report.trackSettings = await page.evaluate(() => window.captureSettings);
  report.outputSamples = samples.length / 2; report.passbandAmplitude = amplitude(1000); report.aliasAmplitude = amplitude(5000);
  report.aliasRelativeDb = 20 * Math.log10(Math.max(report.aliasAmplitude, 1e-12) / report.passbandAmplitude);
  assert.ok(report.passbandAmplitude > 1000, 'Audible 1-kHz signal must survive');
  assert.ok(report.aliasRelativeDb < -35, '11-kHz source energy must not alias into 5 kHz');
  assert.equal(samples.length / 2, state.progress.samples);
  await page.evaluate(id => window.stomylos.command('asrCancel', { id, discard: true }), state.activeId);
  report.status = 'passed'; report.checks.push('48-kHz source normalized to mono PCM16/16 kHz with low-pass rejection, retained samples and zero uploads');
} catch (e) { report.status = 'failed'; report.failure = String(e); throw e; }
finally {
  await app?.close().catch(() => undefined); await new Promise(r => server.close(r));
  mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/asr-resampling.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
