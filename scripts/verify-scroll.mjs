// Native scroll regression with invented text, isolated storage and local SSE only.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const require = createRequire(import.meta.url);
const packaged = process.argv.includes('--packaged');
const output = `test-results/scroll-${packaged ? 'packaged' : 'native'}`;
mkdirSync(output, { recursive: true });
const directory = mkdtempSync('/tmp/stomylos-scroll-');
let replyCount = 0;
const mock = await startMockGateway({ chatHandler: async (input, response) => {
  const turn = ++replyCount;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = 'A quiet walk creates a small pause before the day gathers speed. Familiar places change with the light.\n\n';
  for (let i = 0; i < 18; i++) {
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify({ model: input.model, provider: 'Public mock', choices: [{ delta: { content: i % 3 === 0 ? `### A small observation\n\n${chunk.repeat(3)}` : chunk }, finish_reason: null }] })}\n\n`);
    await new Promise(r => setTimeout(r, 55));
  }
  response.end(`data: ${JSON.stringify({ model: input.model, provider: 'Public mock', choices: [{ delta: {}, finish_reason: turn === 4 ? 'length' : 'stop' }], usage: { total_tokens: 100, cost: 0 } })}\n\ndata: [DONE]\n\n`);
} });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint,
  ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
let app;
const report = { directory, packaged, paidRequests: 0, checks: [], measurements: {}, errors: [] };
try {
  app = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/linux-unpacked/stomylos') : require('electron'), args: packaged ? [] : ['.'], env, chromiumSandbox: true });
  let page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  const button = name => page.getByRole('button', { name, exact: true });
  await button('Partner: Automatic').waitFor();
  let input = page.getByRole('textbox', { name: 'Your message', exact: true });
  let main = page.locator('main');
  let latest = button('Go to latest message');
  const measure = async name => {
    const value = await main.evaluate(n => ({ top:n.scrollTop, height:n.scrollHeight, viewport:n.clientHeight, gap:n.scrollHeight-n.scrollTop-n.clientHeight }));
    report.measurements[name] = value;
    return value;
  };
  const atBottom = async name => {
    // Sample the successful condition and its geometry atomically. A new SSE
    // chunk can grow the DOM between a successful wait and a later assertion.
    await page.waitForTimeout(100);
    const sample = await page.waitForFunction(() => {
      const n = document.querySelector('main');
      const value = { top: n.scrollTop, height: n.scrollHeight, viewport: n.clientHeight, gap: n.scrollHeight - n.scrollTop - n.clientHeight };
      return value.gap <= 2 ? value : false;
    });
    report.measurements[name] = await sample.jsonValue(); await sample.dispose();
  };
  const complete = async () => {
    await page.getByText('Writing…', { exact:true }).waitFor({ state:'hidden' });
    await page.waitForTimeout(100);
  };
  const send = async text => {
    await input.fill(text); await button('Send').click();
    await page.getByText('Writing…', { exact:true }).waitFor();
  };
  const pageUp = async () => {
    await main.focus();
    const start = await main.evaluate(n => { window.scrollObservation = { top: n.scrollTop, at: performance.now() }; return n.scrollTop; });
    await page.keyboard.press('PageUp');
    await page.waitForFunction(start => {
      const n = document.querySelector('main'), now = performance.now();
      if (window.scrollObservation.top !== n.scrollTop) window.scrollObservation = { top: n.scrollTop, at: now };
      return start - n.scrollTop > 80 && now - window.scrollObservation.at >= 150;
    }, start);
  };
  const resize = async (width,height) => {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width,height]);
    await page.waitForTimeout(100);
  };
  await resize(900,860);
  await send('I enjoy a quiet walk.'); await complete(); await atBottom('initial');
  await resize(900,620); await atBottom('shorter_window');
  await input.fill('A short line.\n'.repeat(8)); await atBottom('multiline');
  await button('Genie').click(); await button('Use in draft').waitFor(); await atBottom('genie_open');
  await button('Close Genie').click(); await atBottom('genie_closed');
  await button('Show history').click(); await atBottom('library_open');
  await button('Hide history').click(); await atBottom('library_closed');
  report.checks.push('Viewport shrink, multiline draft, Genie and library reflow preserve following');

  // A small genuine upward gesture must pause even inside the old 80px zone.
  await main.hover(); await page.mouse.wheel(0,-45); await page.waitForTimeout(120);
  const small = await measure('small_upward_gesture'); assert.ok(small.gap > 2 && small.gap < 80);
  await latest.waitFor();
  await send('I want to continue.'); await atBottom('send_resumes');
  await main.hover(); await page.mouse.wheel(0,-250); await page.waitForTimeout(120);
  const reading = await measure('reading_during_stream');
  await complete();
  assert.equal((await measure('paused_after_completion')).top,reading.top);
  assert.equal(await latest.innerText(),'New reply');
  await page.screenshot({ path:`${output}/new-reply.png`, scale:'css' });
  await latest.focus(); await page.keyboard.press('Enter'); await atBottom('latest_button');
  assert.equal(await input.evaluate(n=>n===document.activeElement),true);
  report.checks.push('Small upward wheel pauses; accepted Send resumes; new reader input wins; unseen reply and keyboard return work');

  // Consecutive Sends without a forced scroll repair reproduce the original race.
  await send('What else did you notice?'); await complete(); await atBottom('consecutive_send');
  await pageUp();
  assert.ok((await measure('keyboard_up')).gap > 80);
  await page.keyboard.press('End'); await atBottom('keyboard_bottom');
  await input.fill('Another short draft.');
  await button('Genie').click(); await button('Use in draft').waitFor(); await button('Close Genie').click();
  await send('Tell me more.'); await complete();
  await button('Retry reply').waitFor();
  await main.hover(); await page.mouse.wheel(0,-250); await page.waitForTimeout(120);
  await button('Retry reply').click(); await page.getByText('Writing…',{exact:true}).waitFor();
  await complete(); await atBottom('retry_resumes');
  report.checks.push('Consecutive bursty Markdown replies, keyboard navigation, interrupted reply and explicit retry');

  // Exercise the native scrollbar rather than synthesizing an onScroll callback.
  const box = await main.evaluate(n => { const r=n.getBoundingClientRect(); return { x:r.left+n.clientLeft+n.clientWidth+(n.offsetWidth-n.clientWidth)/2, y:r.top+n.clientHeight-28 }; });
  await page.mouse.move(box.x,box.y); await page.mouse.down(); await page.mouse.move(box.x,box.y-120,{steps:10}); await page.mouse.up();
  await page.waitForTimeout(150);
  assert.ok((await measure('scrollbar_up')).gap > 80);
  const paused = (await measure('before_paused_resize')).top;
  await resize(900,720); assert.equal((await measure('paused_resize')).top,paused);
  const thumb = await main.evaluate(n => { const r=n.getBoundingClientRect(), track=n.clientHeight-32, size=Math.max(20,track*n.clientHeight/n.scrollHeight); return { x:r.left+n.clientWidth+(n.offsetWidth-n.clientWidth)/2, y:r.top+16+(track-size)*n.scrollTop/(n.scrollHeight-n.clientHeight)+size/2, bottom:r.bottom-2 }; });
  await page.mouse.move(thumb.x,thumb.y); await page.mouse.down(); await page.mouse.move(thumb.x,thumb.bottom,{steps:12}); await page.mouse.up();
  await atBottom('native_drag_reaches_bottom');
  await page.locator('.page').evaluate(n => { const probe=document.createElement('div'); probe.id='scroll-layout-probe'; probe.style.height='220px'; n.append(probe); });
  await atBottom('scrollbar_bottom_resumes');
  await page.locator('#scroll-layout-probe').evaluate(n=>n.remove());
  await pageUp();
  await page.emulateMedia({ reducedMotion:'reduce' });
  await latest.click(); await atBottom('reduced_motion_return');
  await app.close(); app=null;
  const offlineEnv={...env}; delete offlineEnv.STOMYLOS_TEST_ENDPOINT;
  app=await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/linux-unpacked/stomylos') : require('electron'), args:packaged ? [] : ['.'], env:offlineEnv, chromiumSandbox:true });
  page=await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror',error=>report.errors.push(error.message));
  input=page.getByRole('textbox',{name:'Your message',exact:true}); main=page.locator('main'); latest=button('Go to latest message');
  await input.waitFor(); await atBottom('reopened_history');
  assert.equal(await page.evaluate(async ()=>(await window.stomylos.command('snapshot')).settings.keyPresent),false);
  await pageUp();
  const beforeFailure=(await measure('before_rejected_send')).top;
  const requestsBeforeFailure=mock.requests.length;
  await input.fill('An unsent offline message.'); await button('Send').click();
  await page.getByRole('alert').filter({hasText:'No API key is available'}).waitFor();
  await page.waitForTimeout(100);
  assert.equal((await measure('rejected_send')).top,beforeFailure);
  assert.equal(await input.inputValue(),'An unsent offline message.'); assert.equal(mock.requests.length,requestsBeforeFailure);
  report.checks.push('Reopened history starts at latest; a rejected no-key Send preserves reading and draft without a request');
  const beforeEnd=(await measure('before_end')).top;
  await input.fill('/end'); await input.press('Enter');
  await button('New chat').waitFor(); await page.waitForTimeout(150);
  assert.equal((await measure('after_end')).top,beforeEnd);
  await page.getByRole('button',{name:/^Analysis details/}).click();
  await page.waitForTimeout(300);
  assert.ok((await measure('feedback')).gap > 2);
  report.checks.push('Native scrollbar pauses; paused viewport resize, reduced motion, /end and feedback preserve intended reading');
  assert.deepEqual(report.errors,[]);
  report.replyCount=replyCount; report.mockRequests=mock.requests.length; report.passed=true;
  console.log(JSON.stringify({ output,checks:report.checks,measurements:report.measurements }));
} finally {
  writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2)+'\n');
  await app?.close(); await new Promise(r=>mock.server.close(r));
}
