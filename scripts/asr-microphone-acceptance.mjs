// User-operated native acceptance. The shared live ledger enforces the remaining budget.
import { _electron as electron } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const mock = process.argv.includes('--mock'), smoke = process.argv.includes('--smoke');
if (!mock && !process.argv.includes('--authorize-asr-call')) throw new Error('Require --authorize-asr-call or --mock');
if (smoke && !mock) throw new Error('Automatic smoke is mock-only; live capture requires user action');
const directory = mkdtempSync(join(tmpdir(), 'stomylos-microphone-acceptance-'));
const fixtureRoot = join(directory, 'private-speech'); mkdirSync(fixtureRoot, { mode: 0o700 });
const reference = 'Um, I goes to the park yesterday. I was, I was very tired. 오늘은 집에서 쉬고 싶어요. I want to practice English slowly.';
const fixtures = [];
let pending = false, requestsStarted = 0, child;
const report = { directory, mock, requests: [], status: 'open' };
const save = () => writeFileSync(join(directory, 'acceptance.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
const { server, requests, endpoint } = await startMockGateway({ delay: 5, asrHandler: async (input, response) => {
  try {
    assert.ok(!pending && requestsStarted < 2, 'This window permits at most two explicit transcriptions');
    assert.equal(input.model, 'microsoft/mai-transcribe-2'); assert.equal(input.input_audio.format, 'flac');
    assert.deepEqual(Object.keys(input).sort(), ['input_audio', 'model']);
    const bytes = Buffer.from(input.input_audio.data, 'base64'); assert.ok(bytes.length >= 42 && bytes.length <= 14 * 1024 * 1024);
    const duration = Number(bytes.readBigUInt64BE(18) & ((1n << 36n) - 1n)) / 16000;
    const name = `microphone-${Date.now()}-${++requestsStarted}`;
    pending = true;
    fixtures.push({ name, duration, flac_sha256: createHash('sha256').update(bytes).digest('hex') });
    writeFileSync(join(fixtureRoot, name + '.flac'), bytes, { mode: 0o600 });
    writeFileSync(join(fixtureRoot, name + '.txt'), reference, { mode: 0o600 });
    writeFileSync(join(fixtureRoot, 'manifest.json'), JSON.stringify({ source: 'User-operated microphone acceptance', license: 'Private acceptance evidence; do not distribute', fixtures }), { mode: 0o600 });
    const attempt = { name, duration, status: 'gate-started' }; report.requests.push(attempt); save();
    child = spawn(process.execPath, ['scripts/verify-asr-live.mjs', mock ? '--mock' : '--authorize-asr-call', '--fixtures', fixtureRoot, '--fixture', name],
      { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
    // Never relay child stderr, which could contain sensitive provider diagnostics.
    child.stderr.resume();
    const code = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject); }); child = null;
    assert.equal(code, 0, 'Bounded gate stopped; inspect its ledger before further calls');
    const ledger = JSON.parse(readFileSync(resolve('test-results', mock ? 'asr-live-mock' : 'asr-live', 'ledger.json'), 'utf8'));
    const saved = ledger.attempts.find(a => a.name === name); assert.equal(saved?.status, 'received');
    attempt.status = 'received'; attempt.generationId = saved.result.generationId; save();
    response.writeHead(200, { 'content-type': 'application/json', ...(saved.result.generationId ? { 'x-generation-id': saved.result.generationId } : {}) });
    response.end(JSON.stringify({ text: saved.result.text, usage: saved.result.usage }));
  } catch {
    report.status = 'gate-stopped'; save();
    response.writeHead(502, { 'content-type': 'application/json' }); response.end('{"error":"Acceptance gate stopped; inspect the ledger"}');
  } finally { pending = false; }
} });
const env = { ...process.env, STOMYLOS_DATA_DIR: join(directory, 'app-data'), STOMYLOS_TEST_ENDPOINT: endpoint, STOMYLOS_PACKAGED_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ executablePath: resolve('run.sh'), env, chromiumSandbox: true, args: smoke ? ['--use-fake-device-for-media-stream'] : [] });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Record', exact: true }).waitFor();
  await page.evaluate(({ reference, mock }) => {
    const notice = document.createElement('aside'); notice.id = 'acceptance-instructions';
    notice.style.cssText = 'padding:10px;background:#fff5cc;font-size:12px;line-height:1.5;flex-shrink:0';
    notice.textContent = `${mock ? 'MOCK' : 'LIVE ASR'} ACCEPTANCE — Record a short clip and Cancel first. Then Record, read the passage, and Stop and transcribe. Review/edit before Send. Other model roles are simulated. Maximum two transcriptions in this window. Private audio is retained only as test evidence. Read: ${reference}`;
    document.querySelector('main').prepend(notice);
  }, { reference, mock });
  console.log(JSON.stringify({ directory, mock, status: 'ready', reference })); save();
  if (smoke) {
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    const deadline = Date.now() + 15000;
    while (true) {
      const s = await page.evaluate(() => window.stomylos.command('asrSnapshot'));
      if ((s.progress?.samples ?? 0) >= 16000) break;
      assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 100));
    }
    await page.getByRole('button', { name: 'Stop and transcribe' }).click();
    await page.waitForFunction(text => document.querySelector('textarea[aria-label="Your message"]').value === text, reference);
    assert.equal(requests.filter(r => r.model === 'microsoft/mai-transcribe-2').length, 1);
    assert.equal(requests.length, 1);
    report.status = 'mock-smoke-passed'; save();
    await page.evaluate(() => window.stomylos.command('close'));
  }
  if (app.process().exitCode === null) await new Promise(done => app.process().once('exit', done));
} finally {
  await app?.close().catch(() => undefined);
  await new Promise(done => server.close(done));
  report.status = report.status === 'open' ? 'closed-awaiting-human-review' : report.status; save();
}
