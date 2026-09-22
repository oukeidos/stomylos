// Focused native reading-size checks; disposable profile and synthetic local SSE.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';

const directory = mkdtempSync('/tmp/stomylos-reading-size-');
const output = resolve('test-results/reading-size'); mkdirSync(output, { recursive: true });
const report = { checks: [], errors: [], directory, paidRequests: 0 };
const mock = await startMockGateway({ chatHandler: async (input, response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const content = 'A quiet afternoon gives us time to read. 내일은 천천히 이야기해요. ';
  for (let i = 0; i < 45; i++) {
    if (response.destroyed) return;
    const text = i === 0 ? '## A quiet afternoon\n\n' : i === 44 ? '\n\n```js\nconst line = "' + 'sample'.repeat(32) + '";\n```\n\n|Place|Time|\n|---|---|\n|Cedar|35|' : content.repeat(3) + (i % 3 === 0 ? '\n\n' : '');
    response.write(`data: ${JSON.stringify({model:input.model,choices:[{delta:{content:text},finish_reason:null}]})}\n\n`);
    await new Promise(r => setTimeout(r, 80));
  }
  response.end(`data: ${JSON.stringify({model:input.model,choices:[{delta:{},finish_reason:'stop'}],usage:{total_tokens:100,cost:0}})}\n\ndata: [DONE]\n\n`);
} });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint };
for (const name of Object.keys(env)) if (name.startsWith('STOMYLOS_') && !['STOMYLOS_DATA_DIR','STOMYLOS_TEST_ENDPOINT'].includes(name)) delete env[name];
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
let app, page;
const button = name => page.getByRole('button', { name, exact: true });
const composer = () => page.getByRole('textbox', { name: 'Your message', exact: true });
async function launch() {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.'], env });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => report.errors.push(e.message));
  await composer().waitFor();
}
async function close() {
  const exited = new Promise(r => app.process().once('exit', r));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await exited; app = null;
}
async function settings() { await button('Settings').click(); await page.getByRole('tab', { name:'Appearance', exact:true }).click(); }
async function size(value) { assert.equal(await page.locator('.transcript .assistant-markdown').first().evaluate(n=>parseFloat(getComputedStyle(n).fontSize)), value); }
async function bottom() { await page.waitForFunction(() => { const n=document.querySelector('main'); return n.scrollHeight-n.scrollTop-n.clientHeight<=2; }); }
async function geometry() {
  return page.evaluate(() => Object.fromEntries(['.transcript','.transcript .bubble','.assistant-markdown','.assistant-markdown h2','.assistant-markdown pre code','.assistant-markdown table','.composer','.composer > textarea','.partner-label'].map(s=>{
    const n=document.querySelector(s), c=getComputedStyle(n); return [s,{font:c.fontSize,line:c.lineHeight,max:c.maxWidth,width:n.getBoundingClientRect().width}];
  })));
}
try {
  await launch();
  await composer().fill('Please describe a quiet afternoon.'); await button('Send').click();
  await page.locator('.assistant-markdown').waitFor();
  await settings(); await button('Increase text size').click(); await size(18);
  await bottom(); await button('Close settings').click();
  await page.getByText('Writing…',{exact:true}).waitFor({state:'hidden'});
  await settings(); await button('Reset to default').click(); await size(16); await button('Close settings').click();
  const baseline = await geometry();
  const baselinePath = process.argv.find(a=>a.startsWith('--baseline='))?.slice(11);
  if (baselinePath) {
    await page.evaluate(css=>{document.querySelectorAll('link[rel=stylesheet]').forEach(n=>n.disabled=true);const n=document.createElement('style');n.id='previous-css';n.textContent=css;document.head.append(n);},readFileSync(baselinePath,'utf8'));
    assert.deepEqual(await geometry(),baseline);
    await page.evaluate(()=>{document.getElementById('previous-css').remove();document.querySelectorAll('link[rel=stylesheet]').forEach(n=>n.disabled=false);});
    report.checks.push('Default typography and width geometry match pre-change CSS');
  }
  const draft = 'Tomorrow I will explain the route.\n내일은 천천히 이야기할 거예요.\nKeep this draft 🧭';
  await composer().fill(draft);
  await composer().evaluate(n=>{window.originalComposer=n;n.setSelectionRange(16,33);});
  await page.locator('main').evaluate(n=>{n.dispatchEvent(new WheelEvent('wheel',{deltaY:-10}));n.scrollTop=500;});
  await page.waitForTimeout(180);
  await button('Go to latest message').waitFor();
  // Track one exact visible text character through long-paragraph reflow.
  await page.locator('main').evaluate(n=>{
    const top=n.getBoundingClientRect().top,w=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);
    for(let t=w.nextNode();t;t=w.nextNode()) for(let i=0;i<t.length;i++) {
      const r=document.createRange();r.setStart(t,i);r.setEnd(t,i+1);const b=r.getBoundingClientRect();
      if(b.height&&b.top>=top){window.readingTestAnchor={range:r,y:b.top};return;}
    }
  });
  await settings();
  await page.evaluate(()=>{window.readingTrace=[];for(const type of ['stomylos-reading-will-change','stomylos-reading-did-change'])window.addEventListener(type,()=>{const n=document.querySelector('main');window.readingTrace.push({type,top:n.scrollTop,y:window.readingTestAnchor.range.getBoundingClientRect().top,size:getComputedStyle(document.querySelector('.assistant-markdown')).fontSize});});});
  for (const value of [18,20,22]) { await button('Increase text size').click(); await size(value); }
  assert(await button('Increase text size').isDisabled());
  const preserved=await page.evaluate(()=>({same:window.originalComposer===document.querySelector('.composer > textarea'),text:window.originalComposer.value,start:window.originalComposer.selectionStart,end:window.originalComposer.selectionEnd,drift:Math.abs(window.readingTestAnchor.range.getBoundingClientRect().top-window.readingTestAnchor.y)}));
  report.anchorTrace=await page.evaluate(()=>window.readingTrace);
  assert(preserved.same);assert.equal(preserved.text,draft);assert.equal(preserved.start,16);assert.equal(preserved.end,33);assert(preserved.drift<=2,JSON.stringify(preserved));
  await button('Close settings').click(); await button('Go to latest message').waitFor();
  report.checks.push('Immediate 18/20/22px preview, upper bound, paused text anchor and exact draft/range/node preservation');
  await close(); await launch(); await size(22);assert.equal(await composer().inputValue(),draft);
  await settings();
  for(const value of [20,18,16,14]){await button('Decrease text size').click();await size(value);}
  assert(await button('Decrease text size').isDisabled());
  await button('Reset to default').click();await size(16);
  await button('Close settings').click();assert.deepEqual(await geometry(),baseline);
  await page.evaluate(()=>localStorage.setItem('unrelated-reading-test','keep'));
  await settings();await button('Increase text size').click();
  await page.evaluate(()=>{window.savedSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='reading-size.v1')throw new Error('test quota');return window.savedSetItem.call(this,k,v);};});
  await button('Increase text size').click();await size(20);await button('Retry saving text size').waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('reading-size.v1')),'18');
  await page.evaluate(()=>{Storage.prototype.setItem=window.savedSetItem;});
  await button('Retry saving text size').click();await button('Retry saving text size').waitFor({state:'hidden'});
  await button('Reset to default').click();assert.equal(await page.evaluate(()=>localStorage.getItem('unrelated-reading-test')),'keep');
  await close();await launch();await size(16);
  report.checks.push('Clean relaunch persistence, 14px lower bound, exact reset, unrelated key preservation and recoverable write failure');
  await page.evaluate(()=>localStorage.setItem('reading-size.v1','invalid'));await page.reload();await composer().waitFor();await size(16);
  // Test scaled content in panels without creating private/provider-backed records.
  await page.evaluate(()=>{
    const n=document.createElement('div');n.id='reading-fixtures';n.innerHTML='<p class="genie-source-text">Source</p><div class="genie-turn"><p>Reply</p></div><div class="explain-meaning">Meaning</div><div class="dadouchos-dock"><p>Suggestion</p></div><div class="memory-manager"><ul class="memory-items"><li><p class="memory-text">Memory</p><textarea>Memory</textarea></li></ul></div><div class="reports-main"><div class="expression-content"><p>Explanation</p><small>Metadata</small></div></div>';n.style.cssText='position:fixed;left:-10000px';document.body.append(n);
  });
  const fixtureSizes=()=>page.locator('#reading-fixtures').evaluate(n=>[...n.querySelectorAll('p,textarea,.explain-meaning,small')].map(e=>[e.tagName,parseFloat(getComputedStyle(e).fontSize)]));
  const original=await fixtureSizes();await settings();await button('Increase text size').click();
  const larger=await fixtureSizes();original.forEach(([tag,v],i)=>assert(Math.abs(larger[i][1]-v*(tag==='SMALL'?1:18/16))<.01));
  await page.evaluate(()=>document.getElementById('reading-fixtures').remove());
  for(const width of [760,1440]) {
    await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setContentSize(w,700),width);
    await button('Increase text size').click();
    assert(await button('Close settings').isVisible());
    await button('Close settings').click();
    await composer().waitFor();await button('Send').waitFor();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await settings();
  }
  await button('Reset to default').click();await button('Close settings').click();
  if(await button('Go to latest message').isVisible()) await button('Go to latest message').click();await bottom();
  assert.deepEqual(report.errors,[]);
  report.checks.push('Invalid stored value fallback; assistance/memory/report body scaling with fixed metadata; narrow/wide controls and internal Markdown overflow; following resumes');
  report.status='passed';
} catch(error) { report.status='failed';report.failure=error.stack;if(page)await page.screenshot({path:resolve(output,'failure.png')}).catch(()=>{});throw error; }
finally { writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');if(app)await close();await new Promise(r=>mock.server.close(r)); }
console.log(JSON.stringify(report,null,2));
