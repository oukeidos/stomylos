// Isolated native Explain acceptance, local mocked model only.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const require = createRequire(import.meta.url);
if (['--fail-save','--restore-save'].includes(process.argv[2])) {
  const directory=process.argv[3]; assert.ok(directory.startsWith(join(tmpdir(),'stomylos-explain-ui-')));
  const Database=require('better-sqlite3'), db=new Database(join(directory,'stomylos.sqlite3'));
  db.exec(process.argv[2]==='--fail-save' ? "CREATE TRIGGER native_explain_save_failure BEFORE UPDATE OF content ON explanations WHEN NEW.state='ready' BEGIN SELECT RAISE(ABORT,'test'); END" : 'DROP TRIGGER native_explain_save_failure'); db.close(); process.exit(0);
}
const directory = mkdtempSync(join(tmpdir(), 'stomylos-explain-ui-'));
const packaged = process.argv.includes('--packaged');
const output = packaged ? 'test-results/explain-packaged' : 'test-results/explain-native'; mkdirSync(output, { recursive: true });
const source = '## A little help\n\n🙂 You are on the **home stretch**. Keep your pace.\n\nTry the same word twice: word and **word**.\n\nUse `C:\\notes\\today` and fish &amp; chips.\n\n<b>hello</b>';
const requests = []; let mode = 'success', release;
const mock = await startMockGateway({ chatHandler: async (input, response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ model: input.model, provider: 'Public mock', choices: [{ delta: { content: source }, finish_reason: 'stop' }], usage: { total_tokens: 30, cost: 0 } })}\n\ndata: [DONE]\n\n`);
}, explainHandler: async (input, response) => {
  requests.push(input); const current = mode;
  if (current === 'hold') await new Promise(done => { release = done; });
  if (response.destroyed) return;
  if (current === 'fail') { response.writeHead(429); response.end('test'); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ model: input.model, provider: 'OpenAI', choices: [{ message: { content: 'You are almost done.\nYou have only a little left to do.' }, finish_reason: 'stop' }], usage: { total_tokens: 20, cost: 0 } }));
} });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint, ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY']) delete env[key];
let app, page, sessionId, messageId; const errors = [];
const report = { checks: [], errors, paidRequests: 0, directory };
const command = (name, args) => page.evaluate(([n,a]) => window.stomylos.command(n,a),[name,args]);
const button = name => page.getByRole('button', { name, exact: true });
async function until(fn) { const deadline = Date.now()+12000; while (Date.now()<deadline) { if (await fn()) return; await new Promise(done=>setTimeout(done,30)); } throw Error('State did not settle'); }
async function launch() {
  app = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/linux-unpacked/stomylos') : require('electron'), args: packaged ? [] : ['.'], env, chromiumSandbox: true });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await button('Settings').waitFor(); await page.locator('.composer textarea').waitFor();
}
async function close() { const exited = new Promise(done => app.process().once('exit', done)); await command('close'); await exited; app = null; }
function inject(flag) {
  const result=spawnSync(require('electron'),[resolve('scripts/verify-explain.mjs'),flag,directory],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8'});assert.equal(result.status,0,result.stderr);
}
async function screenshot(name) { await page.evaluate(async()=>{await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));});await page.screenshot({path:output+'/'+name+'.png'}); }
const root = () => page.locator(`[data-message-id="${messageId}"] .explainable`);
async function select(text, occurrence=0) {
  await root().evaluate((node, { text, occurrence }) => {
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT); let found=0;
    for(let t=walker.nextNode();t;t=walker.nextNode()) { let at=t.textContent.indexOf(text); while(at>=0) { if(found++===occurrence){const r=document.createRange();r.setStart(t,at);r.setEnd(t,at+text.length);const s=window.getSelection();s.removeAllRanges();s.addRange(r);return;} at=t.textContent.indexOf(text,at+1); } }
    throw Error('Selection text missing');
  }, {text,occurrence});
  await button('Explain').waitFor();
}
try {
  await launch(); sessionId=(await command('snapshot')).unfinished.id;
  await page.locator('.composer textarea').fill('I am almost finished.'); await page.locator('.composer textarea').press('Enter');
  await until(async()=>{const v=await command('loadSession',{sessionId}); const m=v.messages.findLast(m=>m.origin==='model'&&m.delivery==='complete'); if(m){messageId=m.id;return true;} return false;});
  await root().waitFor(); await page.locator('.composer textarea').fill('Keep my unsent draft.');
  await select('home stretch'); assert.equal(requests.length,0); mode='hold'; await button('Explain').click();
  await page.getByRole('dialog').waitFor(); await until(()=>requests.length===1);
  const input=JSON.parse(requests[0].messages[1].content); assert.equal(input.selected_text,'home stretch'); assert.equal(input.full_passage,source); assert.equal(input.preceding_message,'I am almost finished.'); assert.equal(source.slice(input.selection.start,input.selection.end),'home stretch');
  assert.equal(requests[0].messages[0].content,readFileSync('src/main/explain-prompt.txt','utf8').trim()); assert.deepEqual(requests[0].reasoning,{effort:'xhigh'});
  await button('Close explanation').click(); await page.getByRole('dialog').waitFor({state:'detached'}); await button('Past explanations').click(); await page.getByText('Thinking…',{exact:true}).waitFor(); assert.equal(requests.length,1); await button('Close explanation').click(); await page.getByRole('dialog').waitFor({state:'detached'}); release(); mode='success';
  await until(async()=>(await command('explainList',{sessionId}))[0]?.state==='ready'); assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal(await page.locator('.composer textarea').inputValue(),'Keep my unsent draft.');
  await button('Past explanations').click(); await page.locator('.explain-meaning').waitFor(); assert.equal(requests.length,1);
  await screenshot('desktop'); await page.keyboard.press('Escape');
  await select('home stretch'); await page.keyboard.press('Alt+e'); await page.locator('.explain-meaning').waitFor(); assert.equal(requests.length,1); await page.keyboard.press('Escape');
  report.checks.push('Exact Markdown source/range/context/prompt, no call on selection, close continues quietly, saved reuse, draft retained, Alt+E and Escape');
  for(const [text,occurrence] of [['word',2],['C:\\notes\\today',0],['fish & chips',0]]) {
    await select(text,occurrence); await button('Explain').click(); await page.locator('.explain-meaning').waitFor();
    const x=JSON.parse(requests.at(-1).messages[1].content); assert.equal(source.slice(x.selection.start,x.selection.end),x.selected_text); if(text==='fish & chips')assert.equal(x.selected_text,'fish &amp; chips'); else assert.equal(x.selected_text,text);
    if(text==='word')assert.equal(x.selection.start,source.indexOf('**word**')+2);
    await page.keyboard.press('Escape');
  }
  report.checks.push('Repeated text, code path and entity source offsets');
  await select('Keep your pace'); mode='fail'; await button('Explain').click(); await button('Retry explanation').waitFor(); const failed=requests.length; mode='success'; await button('Retry explanation').click(); await page.locator('.explain-meaning').waitFor(); assert.equal(requests.length,failed+1); await page.keyboard.press('Escape');
  await button('Past explanations').click(); await page.locator('.explain-list button').first().waitFor(); assert.ok(await page.locator('.explain-list button').count()>=4); await page.locator('.explain-list button').first().click(); await page.locator('.explain-meaning').waitFor();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(680,680));
  const box=await page.locator('.explain-dialog').boundingBox(), viewport=await page.evaluate(()=>({w:innerWidth,h:innerHeight})); assert.ok(Math.abs(box.x+box.width/2-viewport.w/2)<3); assert.ok(box.width<=viewport.w-16); await screenshot('narrow'); await page.keyboard.press('Escape');
  report.checks.push('Explicit retry, per-reply history list and centered narrow dialog');
  await root().focus(); await page.keyboard.press('Control+Shift+ArrowRight'); await button('Explain').waitFor(); await page.keyboard.press('Alt+e'); await page.locator('.explain-meaning').waitFor(); await page.keyboard.press('Escape');
  report.checks.push('Keyboard-only source selection and activation');
  inject('--fail-save'); await select('pace'); await button('Explain').click(); await button('Retry saving explanation').waitFor(); await page.locator('.explain-meaning').waitFor(); const savedCalls=requests.length;
  inject('--restore-save'); await button('Retry saving explanation').click(); await button('Retry saving explanation').waitFor({state:'detached'}); assert.equal(requests.length,savedCalls);
  await assert.rejects(()=>command('genieOpen',{sessionId,text:'Keep my unsent draft.',revision:0,range:{start:0,end:0,direction:'none',scope:'draft'},operationId:'blocked-genie'}),/explain_busy/);
  await page.keyboard.press('Escape'); await button('Genie').click(); await button('Close Genie').waitFor(); await assert.rejects(()=>command('explainHistory',{sessionId,messageId}),/genie_busy/); await button('Close Genie').click(); await page.locator('.genie-dock').waitFor({state:'detached'}); await root().focus(); await page.evaluate(()=>new Promise(requestAnimationFrame));
  report.checks.push('Local-save failure keeps result visible; save retry makes no model call; Genie exclusion in both directions');
  await root().evaluate(node=>{const spans=[...node.querySelectorAll('[data-source-start]')];const a=spans.find(n=>n.textContent.includes('Keep your pace')),b=spans.find(n=>n.textContent==='word');const r=document.createRange();r.setStart(a.firstChild,a.textContent.indexOf('Keep'));r.setEnd(b.firstChild,4);const s=window.getSelection();s.removeAllRanges();s.addRange(r);});
  const beforeCross=requests.length; await button('Explain').click(); await until(()=>requests.length===beforeCross+1); await page.locator('.explain-meaning').waitFor();const cross=JSON.parse(requests.at(-1).messages[1].content);assert.ok(cross.selected_text.includes('\n\n'));assert.equal(cross.selected_text,source.slice(cross.selection.start,cross.selection.end));await page.keyboard.press('Escape');
  report.checks.push('Cross-paragraph source selection');
  const count=requests.length; await close(); await launch(); await root().waitFor(); await button('Past explanations').click(); await page.locator('.explain-list button').first().click(); await page.locator('.explain-meaning').waitFor(); assert.equal(requests.length,count);
  report.checks.push('Saved explanations survive restart without inference');
  assert.deepEqual(errors,[]); await close(); report.status='passed';
} catch(error) { report.status='failed'; report.failure=String(error.stack??error); if(page)await page.screenshot({path:output+'/failure.png'}).catch(()=>{}); throw error; }
finally { release?.(); if(app)await app.close().catch(()=>{}); await new Promise(done => mock.server.close(done)); writeFileSync(output+'/report.json',JSON.stringify(report,null,2)); }
