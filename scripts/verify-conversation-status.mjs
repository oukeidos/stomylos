// Actual Electron renderer; disposable DB, synthetic IPC, no provider requests.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';

const output = 'test-results/conversation-status';
mkdirSync(output, { recursive: true });
const directory = mkdtempSync('/tmp/stomylos-conversation-status-');
const mock = await startMockGateway();
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY', 'OPENROUTER_API_KEY']) delete env[key];
let app, page;
const report = { status: 'running', geometry: [], checks: [], errors: [], providerRequests: 0 };
try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.'], env, timeout: 20000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000);
  page.on('pageerror', e => report.errors.push(e.message));
  await page.locator('.composer textarea').waitFor();
  const fixture = await page.evaluate(async () => {
    const snapshot = await window.stomylos.command('snapshot');
    const view = await window.stomylos.command('loadSession', { sessionId: snapshot.unfinished.id });
    return { snapshot, view };
  });
  await app.evaluate(({ ipcMain }, fixture) => {
    globalThis.statusFixture = { ...fixture, calls: [], revision: 10000 };
    const original = ipcMain._invokeHandlers.get('stomylos:command');
    ipcMain.removeHandler('stomylos:command');
    ipcMain.handle('stomylos:command', (event, name, args) => {
      const f = globalThis.statusFixture;
      if (name === 'loadSession') return { ok: true, value: f.view };
      if (name === 'snapshot') return { ok: true, value: f.snapshot };
      if (['retryReply', 'retryPartnerSelection', 'useSelectedPartner', 'generateOpener'].includes(name)) {
        f.calls.push({ name, args }); return { ok: true, value: undefined };
      }
      return original(event, name, args);
    });
  }, fixture);
  const id = fixture.view.session.id;
  const learner = { id: 'audit-learner', session_id: id, role: 'user', origin: 'learner', delivery: 'complete', sequence: 1, content: 'A short thought.', request_id: null };
  const reply = { ...learner, id: 'audit-reply', role: 'assistant', origin: 'model', delivery: 'streaming', sequence: 2, content: '' };
  const activeView = { ...fixture.view, session: { ...fixture.view.session, state: 'active' }, messages: [learner] };
  const emit = async (view, phase, operation = 'reply', order = 'together') => {
    await app.evaluate(({ BrowserWindow }, { view, phase, operation, order }) => {
      const f = globalThis.statusFixture, send = e => BrowserWindow.getAllWindows()[0].webContents.send('stomylos:event', e);
      f.snapshot = { ...f.snapshot, revision: ++f.revision, activity: { ...f.snapshot.activity, sessionId: view.session.id, phase, operation, streamingMessageId: null, streamingText: '', error: null }, settings: { ...f.snapshot.settings, wordCloud: false } };
      const change = () => { f.view = view; send({ type: 'session-changed', sessionId: view.session.id, revision: ++f.revision }); };
      if (order !== 'snapshot-only') change();
      if (order !== 'view-only') send({ type: 'snapshot', snapshot: { ...f.snapshot, revision: ++f.revision } });
    }, { view, phase, operation, order });
    await page.waitForTimeout(100);
  };
  const button = name => page.getByRole('button', { name, exact: true });
  const left = locator => locator.evaluate(n => n.getBoundingClientRect().left);
  const aligned = (a, b, name) => assert.ok(Math.abs(a - b) < 1, `${name}: ${a} vs ${b}`);
  const status = page.locator('.conversation-status');
  for (const width of (process.argv.includes('--opener-only') ? [] : [760, 950, 951, 1024, 1180, 1440])) for (const collapsed of [false, true]) {
    await page.setViewportSize({ width, height: 860 });
    if (await page.locator('.app').evaluate(n => n.classList.contains('history-collapsed')) !== collapsed)
      await button(collapsed ? 'Hide history' : 'Show history').click();
    const xs = [];
    for (const phase of ['preparing', 'routing', 'reply']) {
      await emit(activeView, phase);
      assert.equal(await status.count(), 1); xs.push(await left(status));
      aligned(xs.at(-1), await left(page.locator('.transcript')), 'transcript/status');
      assert.equal(await page.locator('.typing').count(), 0);
    }
    for (const x of xs) aligned(x, xs[0], 'phase handoff');
    await emit({ ...activeView, messages: [learner, reply] }, 'reply');
    assert.equal(await status.count(), 1); assert.equal(await page.locator('.typing').count(), 0);
    await emit({ ...activeView, messages: [learner, { ...reply, content: 'A reply with text.' }] }, 'reply');
    assert.equal(await page.getByText('Writing…', { exact: true }).count(), 1);
    aligned(await left(status), xs[0], 'streamed reply');
    await emit({ ...activeView, messages: [learner, { ...reply, delivery: 'interrupted', content: 'Partial reply.' }],
      partner: { ...activeView.partner, canRetryReply: true } }, 'idle');
    aligned(await left(page.locator('.reply-recovery')), xs[0], 'reply recovery');
    await button('Retry reply').click();
    report.geometry.push({ width, collapsed, phaseX: xs, recoveryX: await left(page.locator('.reply-recovery')) });
  }
  if (report.geometry.length) report.checks.push('12 viewport/sidebar combinations: preparing, routing, waiting, writing, interrupted and retry alignment');
  // Deliver only the view, then only the phase, to reproduce the former overlap.
  await emit(activeView, 'preparing');
  await emit({ ...activeView, messages: [learner, reply] }, 'reply', 'reply', 'view-only');
  assert.equal(await status.textContent(), 'Preparing your reply…');
  assert.equal(await page.locator('main [role="status"]').count(), 1);
  await emit({ ...activeView, messages: [learner, reply] }, 'reply', 'reply', 'snapshot-only');
  assert.equal(await status.textContent(), 'Writing…');
  await emit({ ...activeView, messages: [learner, { ...reply, delivery: 'complete', content: 'Finished.' }] }, 'idle', 'reply', 'snapshot-only');
  assert.equal(await status.textContent(), 'Writing…');
  await emit({ ...activeView, messages: [learner, { ...reply, delivery: 'complete', content: 'Finished.' }] }, 'idle');
  assert.equal(await status.count(), 0);
  report.checks.push('Independent phase/view delivery never duplicates progress; completion clears it');
  for (const width of [1180, 760]) {
    await page.setViewportSize({ width, height: 860 });
    const draft = { ...fixture.view, messages: [], opener: { generated: false, status: 'empty', failure: null } };
    await emit(draft, 'preparing', 'opener');
    assert.equal(await status.count(), 0);
    const x = await left(page.locator('.opener-status'));
    await emit({ ...draft, opener: { generated: false, status: 'failed', failure: 'request_timeout' } }, 'idle', 'opener');
    aligned(await left(page.locator('.opener-status')), x, 'opener failure');
    assert.equal(await page.locator('.starter-dock [role="alert"]').count(), 1);
    await button('Give me something').click();
    await emit({ ...draft, opener: { generated: false, status: 'dispatched', failure: null } }, 'preparing', 'opener');
    aligned(await left(page.locator('.opener-status')), x, 'opener retry');
    await emit({ ...draft, session: { ...draft.session, opening_kind: 'starter' },
      opener: { generated: true, status: 'succeeded', failure: null },
      messages: [{ ...reply, id: 'audit-opener', origin: 'starter', delivery: 'complete', content: 'A quiet morning.' }] }, 'idle', 'opener');
    aligned(await left(page.locator('.starter-dock .bubble p')), x, 'opener result');
    assert.equal(await page.locator('.opener-status').count(), 0);
    await page.locator('.composer textarea').fill('x'.repeat(6001));
    await page.locator('.composer-notices .limit-note').waitFor();
    aligned(await left(page.locator('.composer-notices')), await left(page.locator('.composer')), 'composer notices');
    await page.locator('.composer textarea').fill('');
    await page.screenshot({ path: `${output}/opener-${width}.png` });
  }
  const calls = await app.evaluate(() => globalThis.statusFixture.calls);
  assert.equal(calls.filter(c => c.name === 'retryReply').length, process.argv.includes('--opener-only') ? 0 : 12);
  assert.equal(calls.filter(c => c.name === 'generateOpener').length, 2);
  assert.ok(calls.every(c => c.args.sessionId === id));
  report.checks.push('Opener pending, failure, retry and result share X at wide/narrow widths; recovery commands retain session identity');
  assert.equal(mock.requests.length, 0); assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = String(error); throw error;
} finally {
  writeFileSync(`${output}/${process.argv.includes('--opener-only') ? 'opener-report' : 'report'}.json`, JSON.stringify(report, null, 2));
  await app?.close(); await new Promise(resolve => mock.server.close(resolve));
}
console.log(JSON.stringify(report));
