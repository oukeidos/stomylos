// Run only after explicit authorization of the plan's eight-call live gate.
import { _electron as electron } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { startMockGateway } from './mock-gateway.mjs';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const mock = process.argv.includes('--mock');
if (JSON.parse(readFileSync('package.json', 'utf8')).version !== '0.2.0') {
  throw new Error('This historical eight-call gate applies only to 0.2.0. Starter renewal needs its separate three-generator gate; do not reuse this budget.');
}
if (!mock && !process.argv.includes('--authorize-eight-calls')) throw new Error('Explicit eight-call authorization is required. Ordinary tests never call providers.');
const local = mock ? await startMockGateway({ delay: 1 }) : null;
const directory = mkdtempSync(join(tmpdir(), mock ? 'stomylos-live-mock-' : 'stomylos-live-'));
const executablePath = mock ? createRequire(import.meta.url)('electron') : resolve('release/linux-unpacked/stomylos');
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_LIVE_VERIFY: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.STOMYLOS_TEST_ENDPOINT; delete env.ELECTRON_RENDERER_URL;
if (mock) { delete env.STOMYLOS_LIVE_VERIFY; env.STOMYLOS_TEST_ENDPOINT = local.endpoint; }
const texts = ['I usually take a short walk after breakfast. It gives me time to think before I start work.', 'Yesterday I notice a new cafe on my usual route, but I did not stop because I was in a hurry.'];
const report = { directory, mock, status: 'running', integrated: null, endpoints: [], failure: null };
let application; let page;
async function open() {
  application = await electron.launch({ executablePath, args: mock ? ['.'] : [], env, chromiumSandbox: true, timeout: 20000 });
  page = await application.firstWindow(); await page.getByRole('textbox', { name: 'Your message' }).waitFor();
}
async function close() {
  const child = application.process(); const stopped = new Promise(resolve => child.once('exit', resolve));
  await page.evaluate(() => window.stomylos.command('close')); await stopped; application = null;
}
async function resolved(id, role, count) {
  const deadline = Date.now() + (role === 'chat' ? 140000 : 130000);
  for (;;) {
    // waitForFunction treats a returned Promise as truthy before its value resolves.
    // Await IPC explicitly in the driver, then decide whether another poll is needed.
    const view = await page.evaluate(id => window.stomylos.command('loadSession', { sessionId: id }), id);
    const requests = view.requests.filter(r => r.role === role);
    assert.ok(requests.length <= count, `Unexpected extra ${role} request`);
    if (requests.length === count && ['succeeded', 'failed', 'interrupted'].includes(requests.at(-1).status)) {
      assert.equal(requests.at(-1).status, 'succeeded', `${role} failed; stop without an automatic retry`);
      return view;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for saved ${role} result`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
try {
  await open();
  const app = await page.evaluate(() => window.stomylos.command('snapshot'));
  assert.equal(app.settings.keyPresent, true, 'The external OpenRouter key must be available');
  const id = app.unfinished.id;
  await page.getByRole('button', { name: 'Partner: Automatic' }).click();
  await page.getByRole('menuitemradio', { name: /Calm explainer/ }).click();
  for (let i = 0; i < texts.length; i++) {
    await page.getByRole('textbox', { name: 'Your message' }).fill(texts[i]);
    await page.getByRole('button', { name: 'Send', exact: false }).click();
    const view = await resolved(id, 'chat', i + 1);
    assert.equal(view.requests.filter(r => r.role === 'router').length, 1);
    assert.equal(view.requests.find(r => r.role === 'router').status, 'succeeded');
    console.log(`Saved ${mock ? 'simulated' : 'real'} conversation reply ${i + 1}/2.`);
  }
  await page.getByRole('button', { name: 'End chat', exact: true }).click();
  const completed = await resolved(id, 'grammar', 1);
  assert.equal(completed.session.analysis_state, 'completed');
  assert.deepEqual(completed.messages.filter(m => m.origin === 'learner').map(m => m.content), texts);
  assert.deepEqual(completed.units.map(u => u.source_message_id), completed.messages.filter(m => m.origin === 'learner').map(m => m.id));
  assert.equal(completed.requests.length, 4);
  assert.equal(mock ? local.requests.length : Number(readFileSync(join(directory, 'live-call-count'), 'utf8')), 4);
  await close(); delete env.STOMYLOS_LIVE_VERIFY; delete env.STOMYLOS_TEST_ENDPOINT; await open();
  const reopened = await page.evaluate(id => window.stomylos.command('loadSession', { sessionId: id }), id);
  assert.deepEqual(reopened, completed);
  assert.equal((await page.evaluate(() => window.stomylos.command('snapshot'))).settings.keyPresent, false);
  await close();
  writeFileSync(join(directory, 'integrated.json'), JSON.stringify(completed), { mode: 0o600 });
  report.integrated = { sessionId: id, sourceHash: completed.session.source_hash, units: completed.units.length,
    requests: completed.requests.map(r => ({ role: r.role, status: r.status, configHash: r.config_hash, metadata: JSON.parse(r.metadata) })) };
  console.log(`Four-call ${mock ? 'simulated' : 'packaged'} conversation/analysis gate passed; starting one call per remaining partner.`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executablePath, [resolvePath('node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.checks.config.ts', 'tests/live-compatibility.check.ts'], {
      stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', STOMYLOS_LIVE_DIR: directory,
        ...(mock ? { STOMYLOS_LIVE_MOCK_ENDPOINT: local.endpoint } : {}) }
    });
    child.on('error', reject); child.on('exit', resolve);
  });
  report.endpoints = JSON.parse(readFileSync(join(directory, 'compatibility.json'), 'utf8'));
  assert.equal(code, 0, 'A selected endpoint failed compatibility; no retries were made');
  report.status = 'passed';
  console.log(JSON.stringify({ status: report.status, directory, calls: 8, storedAnalysisUnits: completed.units.length }));
} catch (error) {
  report.status = 'failed';
  report.failure = { name: error.name, message: String(error.message).slice(0, 3000) };
  // Assertion messages contain only fixture values/status, never response bodies or keys.
  console.error('Verification stopped without automatic retry:', report.failure);
  process.exitCode = 1;
} finally {
  await application?.close().catch(() => undefined);
  mkdirSync('test-results', { recursive: true }); writeFileSync(mock ? 'test-results/live-mock-report.json' : 'test-results/live-report.json', JSON.stringify(report, null, 2));
  if (local) await new Promise(resolve => local.server.close(resolve));
}
function resolvePath(path) { return resolve(path); }
