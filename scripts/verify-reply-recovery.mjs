// Public mocked cutoff/retry verification; never reads the normal key or history.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';

const executablePath = createRequire(import.meta.url)('electron');
const directory = mkdtempSync(join(tmpdir(), 'stomylos-reply-recovery-'));
const mock = await startMockGateway({ delay: 1, streamFinishes: ['length', 'stop'] });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.STOMYLOS_LIVE_VERIFY;
const errors = []; let application;
const report = { status: 'checking', version: JSON.parse(readFileSync('package.json', 'utf8')).version, directory,
  maxTokens: 8192, realCalls: 0, mockCalls: 0, errors, sourceHashes: {} };
const view = page => page.evaluate(async () => {
  const snapshot = await window.stomylos.command('snapshot');
  return window.stomylos.command('loadSession', { sessionId: snapshot.sessions.find(s => s.state !== 'ended').id });
});
async function launch() {
  application = await electron.launch({ executablePath, args: ['.'], env, chromiumSandbox: true, timeout: 20_000 });
  const page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor(); return page;
}
async function close(page) {
  const child = application.process(); const exited = new Promise(resolve => child.once('exit', resolve));
  await page.evaluate(() => window.stomylos.command('close')); await exited; application = null;
}
try {
  let page = await launch();
  await page.getByRole('textbox', { name: 'Your message' }).fill('I noticed the changing light during a quiet walk.');
  await page.getByRole('button', { name: 'Send', exact: false }).click();
  const failureText = 'The reply reached its output token limit before finishing. The partial reply is saved. Retry reply to generate it again.';
  await page.getByText(failureText, { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Retry reply', exact: true }).waitFor();
  const failedView = await view(page); const failed = failedView.requests.find(r => r.role === 'chat');
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure, 'response_length_limit');
  assert.equal(JSON.parse(failed.config).max_tokens, 8192);
  assert.equal(JSON.parse(failed.metadata).usage.completion_tokens_details.reasoning_tokens, 8000);
  assert.equal(failedView.messages.at(-1).delivery, 'interrupted');
  assert.equal(mock.requests.length, 2);
  await close(page); page = await launch();
  await page.getByRole('button', { name: 'Retry reply', exact: true }).waitFor();
  assert.deepEqual((await view(page)).requests.find(r => r.id === failed.id), failed);
  assert.equal(mock.requests.length, 2, 'Reopening must not retry');
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('menuitem', { name: 'Conversation details', exact: true }).click();
  await page.getByRole('button', { name: /Request details/ }).click();
  await page.getByText('Finish reason: length', { exact: true }).waitFor();
  await page.getByText('8192 output tokens · 8000 reasoning tokens', { exact: true }).waitFor();
  await page.getByText(failureText, { exact: true }).waitFor();
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/reply-cutoff.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Retry reply', exact: true }).click();
  await page.waitForFunction(async () => {
    const snapshot = await window.stomylos.command('snapshot');
    const current = await window.stomylos.command('loadSession', { sessionId: snapshot.sessions.find(s => s.state !== 'ended').id });
    return current.requests.filter(r => r.role === 'chat').length === 2 && current.messages.at(-1).delivery === 'complete';
  });
  const retried = await view(page); const retry = retried.requests.findLast(r => r.role === 'chat');
  assert.equal(retry.parent_id, failed.id); assert.equal(retry.source_hash, failed.source_hash);
  assert.deepEqual(retried.requests.find(r => r.id === failed.id), failed);
  assert.equal(mock.requests.length, 3); assert.deepEqual(mock.requests[2], mock.requests[1]);
  await close(page); assert.deepEqual(errors, []);
  for (const file of ['src/main/contracts.ts', 'src/main/runtime-config.json', 'src/main/coordinator.ts', 'src/main/transport.ts', 'src/renderer/src.tsx']) {
    report.sourceHashes[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  report.status = 'passed'; report.mockCalls = mock.requests.length;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await application?.close().catch(() => undefined); await new Promise(resolve => mock.server.close(resolve));
  mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/reply-recovery-report.json', JSON.stringify(report, null, 2));
}
