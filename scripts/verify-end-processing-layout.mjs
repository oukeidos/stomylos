// Real dialog/client/CSS with synthetic IPC; no database or provider requests.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const out = 'test-results/end-processing-layout'; mkdirSync(out, { recursive: true });
writeFileSync(`${out}/index.html`, '<div id="root"></div><script type="module" src="./harness.tsx"></script>');
writeFileSync(`${out}/harness.tsx`, `
import React from 'react';import {createRoot} from 'react-dom/client';import '/src/renderer/style.css';
const listeners=new Set();let resolveView,rejectView,revision=1,loaded=false;
const fixture=window.fixture={calls:[],view:{memory:{addJobs:[]},endProcessing:{complete:false,stages:{update:'running',cleanup:'skipped'}}},release(){resolveView(this.view)},reject(){rejectView(Error('Cannot load processing status.'))},update(view){this.view=view;listeners.forEach(f=>f({type:'session-changed',sessionId:'s',revision:++revision}));}};
window.stomylos={subscribe(f){listeners.add(f);return()=>listeners.delete(f)},async command(n,args){if(n==='snapshot')return {revision:0,activity:{},sessions:[]};if(n==='loadSession'){if(!loaded){loaded=true;return new Promise((r,j)=>{resolveView=r;rejectView=j})}return fixture.view;}fixture.calls.push({name:n,args});}};
const {EndProcessingDialog}=await import('/src/renderer/end-processing');const errorText=e=>String(e.message??e);
function Harness(){const [storage,setStorage]=React.useState(null),[automatic,setAutomatic]=React.useState(true);window.storage=setStorage;window.automatic=setAutomatic;return <><main aria-label="Conversation" tabIndex={0}>Saved conversation</main><EndProcessingDialog sessionId="s" storageError={storage} automaticMemory={automatic} errorText={errorText}/></>};createRoot(document.getElementById('root')).render(<Harness/>);
`);
let server, browser; const report = { status: 'running', cases: [], errors: [] };
try {
  server = await createServer({ configFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen(); browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage(); page.setDefaultTimeout(6000); page.on('pageerror', e => report.errors.push(e.message));
  const button = name => page.getByRole('button', { name, exact: true });
  const geometry = () => page.evaluate(() => {
    const rect = n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    const dialog = document.querySelector('.end-processing-dialog');
    return { dialog: rect(dialog), title: rect(dialog.querySelector('h2')), cancel: rect(dialog.querySelector('.end-processing-actions button')) };
  });
  const open = async () => { await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${out}/index.html`); await page.locator('.end-processing-dialog').waitFor(); await page.waitForTimeout(280); };
  const update = async (state, { modern = true, long = false } = {}) => {
    await page.evaluate(({ state, modern, long }) => window.fixture.update({ memory: modern ? { addJobs: [{ session_id: 's', ordinal: 1, source_kind: 'session', phase: 'link', state, failure: state === 'failed' ? (long ? 'source_link_timeout_'.repeat(160) : 'request_timeout') : null }] } : {}, endProcessing: { complete: false, stages: { update: state, cleanup: 'skipped' } } }), { state, modern, long });
    await page.waitForTimeout(70);
  };
  for (const [width, height] of [[1180, 860], [760, 620], [360, 640], [360, 400]]) for (const reduced of [false, true]) {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' }); await open();
    const initial = await geometry();
    const stable = async () => assert.deepEqual(await geometry(), initial);
    assert.equal(await page.locator('.end-processing-stages li').count(), 0);
    await page.getByText('Checking processing status…', { exact: true }).waitFor();
    await page.evaluate(() => window.fixture.release()); await page.locator('li.active').waitFor(); await stable();
    await page.evaluate(() => window.rowSpinner = document.querySelector('li .end-spinner'));
    await update('pending'); await stable(); assert.equal(await button('Try again').count(), 0);
    assert.equal(await page.evaluate(() => window.rowSpinner === document.querySelector('li .end-spinner')), true);
    await update('running'); await stable();
    await update('failed', { long: true }); await stable();
    const body = page.locator('.end-processing-body');
    assert.equal(await body.evaluate(n => n.scrollHeight > n.clientHeight), true);
    await button('Retry source linking').focus(); await page.keyboard.press('Enter'); await stable();
    assert.equal(await body.evaluate(n => n.scrollTop > 0), true);
    await button('Skip session memories').focus(); await page.keyboard.press('Enter'); await stable();
    await page.screenshot({ path: `${out}/failure-${width}-${height}-${reduced}.png` });
    await update('pending'); await page.evaluate(() => window.automatic(false)); await button('Try again').waitFor(); await stable();
    await button('Try again').click();
    await page.evaluate(() => window.automatic(true)); await button('Try again').waitFor({ state: 'hidden' }); await stable();
    await update('pending', { modern: false }); await button('Try again').waitFor(); await stable();
    assert.equal(await page.locator('.end-processing-stages li').count(), 2);
    await update('running'); await page.evaluate(() => window.storage('operation_failed')); await button('Retry saving').waitFor(); await stable();
    assert.equal(await button('Cancel remaining').isDisabled(), true); await button('Retry saving').click();
    await page.evaluate(() => window.storage(null)); await button('Retry saving').waitFor({ state: 'hidden' }); await stable();
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.end-processing-dialog').isVisible(), true);
    await button('Cancel remaining').click();
    const calls = await page.evaluate(() => window.fixture.calls);
    assert.deepEqual(calls.map(c => c.name), ['retryMemoryAdd', 'skipMemoryAdd', 'continueEnd', 'retrySaving', 'cancelEnd']);
    assert.ok(calls.filter(c => c.name !== 'retrySaving').every(c => c.args.sessionId === 's'));
    report.cases.push({ width, height, reduced, geometry: initial, checks: 'loading, continuous handoff, error/keyboard recovery, paused and legacy recovery, storage failure, fixed cancel' });
  }
  await open(); const initial = await geometry(); await page.evaluate(() => window.fixture.reject()); await button('Reload status').waitFor(); assert.deepEqual(await geometry(), initial);
  await button('Reload status').click(); await page.locator('li.active').waitFor(); assert.deepEqual(await geometry(), initial);
  report.loadRecovery = 'passed'; assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = String(error); throw error; }
finally { writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2)); await browser?.close(); await server?.close(); }
console.log(JSON.stringify(report));
