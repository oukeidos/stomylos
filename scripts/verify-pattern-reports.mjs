// Isolated native report workflow. Frozen public reports are replayed, never regenerated.
import { createServer } from 'node:http';
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { startMockGateway } from './mock-gateway.mjs';
import { checkWindowIcon } from './check-window-icon.mjs';
const packaged = process.argv.includes('--packaged');
const interactions=[];
const directory = mkdtempSync('/tmp/stomylos-pattern-native-');
const fixtures = ['P01','P02','P03','P04'].map(id => readFileSync(`tests/fixtures/pattern-reports/${id}.html`, 'utf8'));
const v2Ids = ['v2-P02-a','v2-P02-b','v2-P01','v2-P03','v2-P04'];
const v2System = readFileSync('tests/fixtures/pattern-reports/system-v2.txt','utf8');
const v1System = readFileSync('tests/fixtures/pattern-reports/system-v1.txt','utf8');
let fixture = 0, hold = false, release;
const mock = await startMockGateway({ delay: 0, patternHandler: async (body, response) => {
  assert.ok([v1System,v2System].includes(body.messages[0].content), 'Exact supported system prompt');
  const content = fixtures[fixture]; if (hold) await new Promise(r => { release = r; });
  if (response.destroyed) return;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ model: body.model, provider: 'OpenAI', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { cost: 0 } }));
} });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint, ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY']) delete env[key];
let app, page; const checks = [], errors = [];
const cmd = (name, args) => page.evaluate(([name,args]) => window.stomylos.command(name,args), [name,args]);
const count = () => mock.requests.filter(r => r.max_tokens === 32768).length;
async function wait(fn, label) { const until = Date.now()+20000; while (Date.now()<until) { const value = await fn(); if(value) return value; await new Promise(r=>setTimeout(r,40)); } throw new Error(label); }
async function launch() {
  app = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_PATTERN_BUNDLE ?? 'release/linux-unpacked/stomylos') : createRequire(import.meta.url)('electron'), args: packaged ? [] : ['.'], env, chromiumSandbox: true });
  page = await app.firstWindow(); page.on('pageerror', e=>errors.push(e.message)); await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
  await checkWindowIcon(app, page);
}
async function close() { const exited = new Promise(r=>app.process().once('exit',r)); await cmd('close'); await exited; app=null; }
async function addConversation() {
  let snap = await cmd('snapshot'), id = snap.unfinished?.id ?? await cmd('newSession');
  let view = await cmd('loadSession',{sessionId:id});
  if (view.session.opening_kind !== 'user') await cmd('setOpening',{sessionId:id,kind:'user',operationId:'open-'+id,expectedRevision:view.session.opening_revision});
  await cmd('selectPartner',{sessionId:id,character:'model_04'});
  await cmd('sendMessage',{sessionId:id,text:'I enjoyed a quiet walk today.',revision:1});
  await wait(async()=> (await cmd('snapshot')).activity.phase==='idle','chat');
  await cmd('endSession',{sessionId:id});
  await wait(async()=> (await cmd('loadSession',{sessionId:id})).session.analysis_state==='completed','analysis');
  return id;
}
async function exercise(report, index) {
  if (index === 0) { await checkWindowIcon(app, report); checks.push('Main and report native window icons match the selected PNG pixels'); }
  const issues=[]; report.on('pageerror',e=>issues.push(e.message));
  await report.emulateMedia({reducedMotion:'reduce'});
  let actions=0;
  if(index===0) {
    for(let n=0;n<3;n++) {
      await report.locator('[role="tab"]').nth(n).click();
      for(const choice of await report.locator('[data-choice]').all()) { await choice.click(); assert.ok(await report.locator('#feedback').innerText()); actions++; }
    }
    await report.locator('[role="tab"]').first().focus(); await report.keyboard.press('ArrowRight');
    assert.equal(await report.locator('[role="tab"]').nth(1).getAttribute('aria-selected'),'true'); actions++;
  }
  if(index===2) {
    for(const quiz of await report.locator('.quiz').all()) {
      await quiz.locator('xpath=..').locator('summary').click();
      for(let round=0;round<2;round++) {
        for(const choice of await quiz.locator('.choice').all()) { await choice.click(); assert.ok(await quiz.locator('.feedback').innerText()); actions++; }
        const answers = (await quiz.getAttribute('data-quiz')) === 'time' ? ['for', 'since'] : ['are', 'is'];
        await quiz.getByRole('button', { name: answers[round], exact: true }).click();
        await quiz.locator('.feedback.good').waitFor({ state: 'visible' });
        await quiz.locator('.next').click(); actions++;
      }
      assert.equal(await quiz.locator('.position').innerText(),'Prompt 1 of 2');
    }
  }
  if(index===1 || index===3) {
    const panels=index===3 ? await report.locator('[data-panel]').all() : [null];
    for(const panel of panels) {
      if(panel) { await panel.click(); actions++; }
      for(const summary of await report.locator('details:not([open]) > summary').all()) if(await summary.isVisible()) { await summary.click(); actions++; }
      for(const choice of await report.locator('.choice').all()) if(await choice.isVisible()) { await choice.click(); assert.equal(await choice.getAttribute('aria-pressed'),'true'); actions++; }
      for(const text of await report.locator('textarea').all()) if(await text.isVisible()) { await text.fill('Yesterday I walked home. 한글'); assert.ok((await text.inputValue()).includes('한글')); actions++; }
    }
  }
  for(const [width,height] of [[1180,860],[760,620],[430,760]]) { await report.setViewportSize({width,height}); assert.equal(await report.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`P0${index+1} width ${width}`); }
  await report.setViewportSize({width:1180,height:860});
  const closeSelector=['#closeReport','#close-report','#close','#close'][index];
  await report.locator(closeSelector).click(); await report.locator('#reopen').click(); actions+=2;
  await report.screenshot({path:`test-results/pattern-P0${index+1}-${packaged?'packaged':'native'}.png`});
  assert.deepEqual(issues,[]); return {fixture:`P0${index+1}`,actions,widths:[1180,760,430],reducedMotion:true};
}
async function exerciseV2(report, id, reportId) {
  const issues=[]; report.on('pageerror',e=>issues.push(e.message));
  await report.emulateMedia({reducedMotion:'reduce'});
  let actions=0;
  for (const width of [1180,760,430]) {
    if(width!==1180) {
      await cmd('patternClose'); const opening=app.waitForEvent('window');
      await cmd('patternOpen',{id:reportId}); report=await opening;
      report.on('pageerror',e=>issues.push(e.message)); await report.emulateMedia({reducedMotion:'reduce'});
    }
    await report.setViewportSize({width,height:860});
    await report.locator('h1').first().waitFor();
    assert.equal(await report.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.equal(await report.evaluate(()=>getComputedStyle(document.body).fontSize),'16px');
    await report.screenshot({path:`test-results/pattern-${id}-${width}-${packaged?'packaged':'native'}.png`,fullPage:true});
    const focuses=report.locator('[data-focus]'); const n=await focuses.count();
    if(id==='v2-P03') assert.equal(await report.locator('button,input').count(),0);
    for(let i=0;i<n;i++) {
      await focuses.nth(i).focus(); assert.equal(await focuses.nth(i).evaluate(e=>e===document.activeElement),true);
      await report.keyboard.press('Enter'); actions++;
      const practice=report.locator('.practice:visible'); assert.equal(await practice.count(),1);
      const geometry=await practice.evaluate(e=>({x:e.getBoundingClientRect().x,hidden:!!e.closest('details:not([open])')}));
      assert.equal(geometry.hidden,false);
      if(width===1180) assert.ok(geometry.x>500,'Desktop application is beside the explanation');
      const choices=report.locator('[data-answer]:visible,input[type=radio]:visible');
      const feedback=[];
      for(const choice of await choices.all()) {
        await choice.click();
        if(await report.locator('[data-check]:visible').count()) await report.locator('[data-check]:visible').click();
        const text=await report.locator('[role=status]:visible').innerText();assert.ok(text.length>15);feedback.push(text);actions++;
      }
      assert.ok(new Set(feedback).size>=2,'Distinct explanatory feedback for different answers');
      for(const detail of await report.locator('details:visible').all()) {
        if(await detail.getAttribute('open')===null) {await detail.locator('summary').click();actions++;}
      }
    }
    if(!n) {await report.locator('summary').click();assert.ok((await report.locator('body').innerText()).includes('L01-U02'));actions++;}
    assert.equal(await report.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }
  assert.deepEqual(issues,[]);return {fixture:id,actions,widths:[1180,760,430],allAnswerBranches:true};
}
try {
  await launch(); await page.getByRole('button',{name:'Show history',exact:true}).click(); await page.getByRole('button',{name:'Reports',exact:true}).click();
  await page.getByText('0 of 5 analyzed conversations ready.',{exact:false}).waitFor(); checks.push('Reachable empty Learning state');
  await page.getByRole('button',{name:'Chats',exact:true}).click();
  await page.getByRole('button',{name:'Hide history',exact:true}).click();
  await page.getByRole('button',{name:'Show history',exact:true}).click();
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  await page.getByRole('heading',{name:'Recent conversations',exact:true}).waitFor();
  assert.equal(await page.locator('aside').isVisible(),true,'Report navigation opens the library');
  assert.equal(await page.locator('main').isVisible(),true,'The conversation remains visible beside reports');
  checks.push('Reports remains reachable through the library from collapsed navigation');
  for(let i=0;i<5;i++) await addConversation();
  const emptyId=await cmd('newSession'); await cmd('endSession',{sessionId:emptyId});
  await page.getByText('How this scope was chosen',{exact:true}).click();
  await page.getByRole('button',{name:/No analysis evidence/}).click();
  assert.equal(await page.locator('.history-item[aria-current="page"]').count(),1);
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  checks.push('Unavailable analysis links return to the original conversation');
  const p = await cmd('patternPreview'); assert.equal(p.scope.count,5); assert.equal(p.blocked,null);
  await page.getByRole('button',{name:'New chat',exact:true}).click();
  const composer = page.getByRole('textbox',{name:'Your message',exact:true}); await composer.fill('Keep this unfinished draft. 한글');
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  await page.getByRole('button',{name:'Chats',exact:true}).click(); assert.equal(await composer.inputValue(),'Keep this unfinished draft. 한글');
  assert.equal(await composer.evaluate(n=>document.activeElement===n),true); checks.push('Draft preserved and composer focus restored');
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  await page.getByRole('button',{name:'Create report',exact:true}).click();
  const card = await wait(async()=> (await cmd('patternList',{offset:0})).reports.find(r=>r.status==='succeeded'),'report');
  assert.equal(count(),1); assert.equal((await cmd('patternState')).phase,'idle');
  const pendingWindow = app.waitForEvent('window'); await cmd('patternOpen',{id:card.id}); const report = await pendingWindow;
  await report.locator('h1').first().waitFor();
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('stomylos-report:'))?.getTitle().startsWith('Learning report')),true);
  const security = await report.evaluate(()=>{ let storage=false; try{localStorage.setItem('probe','x')}catch{storage=true} return {node:typeof process,require:typeof require,bridge:typeof window.stomylos,storage}; });
  assert.deepEqual(security,{node:'undefined',require:'undefined',bridge:'undefined',storage:true});
  const overflow = await report.evaluate(()=>document.documentElement.scrollWidth>innerWidth); assert.equal(overflow,false);
  mkdirSync('test-results',{recursive:true}); await page.screenshot({path:`test-results/pattern-learning-${packaged?'packaged':'native'}.png`});
  await report.screenshot({path:`test-results/pattern-report-${packaged?'packaged':'native'}.png`});
  interactions.push(await exercise(report,0));
  await cmd('patternClose'); await wait(()=>report.isClosed(),'viewer close');
  checks.push('Actual medium HTML rendered in native isolated window; no Node/preload/storage, no desktop overflow');
  const reopenedWindow = app.waitForEvent('window');
  assert.equal(await page.getByRole('button',{name:'Conversation details',exact:true}).count(),1,'Current conversation details stay available beside the report library');
  await page.getByRole('button',{name:'View existing report',exact:true}).click();
  const reopened = await reopenedWindow; await reopened.locator('h1').first().waitFor();
  assert.equal(count(),1,'Reopening the existing report must not generate another report');
  await page.getByRole('button',{name:'Reports options',exact:true}).click();
  await page.getByRole('menuitem',{name:'Close report window',exact:true}).click();
  await wait(()=>reopened.isClosed(),'menu closes report viewer');
  await page.locator('.learning-card').first().getByRole('button',{name:'Report options',exact:true}).click();
  await page.getByRole('menuitem',{name:'Report details',exact:true}).click();
  await page.getByRole('dialog',{name:'Report details'}).waitFor();
  const detailDialog=page.getByRole('dialog',{name:'Report details'});
  await detailDialog.locator('summary').nth(1).click();
  await detailDialog.getByRole('button',{name:'Open source conversation',exact:true}).first().click();
  await page.locator('.history-row').filter({has:page.locator('.history-item[aria-current="page"]')}).getByRole('button',{name:/^Options for/}).click();
  await page.getByRole('menuitem',{name:'Delete chat',exact:true}).click();
  const deleteDialog=page.getByRole('dialog',{name:'Delete this chat?'});
  await deleteDialog.getByText('1 learning reports contain excerpts',{exact:true}).click();
  await deleteDialog.getByRole('button',{name:/^View report/}).click();
  await detailDialog.waitFor(); await page.getByRole('button',{name:'Close report details',exact:true}).click(); assert.equal(count(),1);
  checks.push('Literal source inspector opens the source chat; deletion disclosure links back to its saved report without deleting');
  await close(); await launch(); assert.equal(count(),1); assert.equal((await cmd('patternList',{offset:0})).reports[0].id,card.id);
  checks.push('Identical-input reuse, report details and restart without inference');
  for(fixture=1;fixture<4;fixture++) {
    await addConversation();
    const preview=await cmd('patternPreview');
    const created=await cmd('patternCreate',{fingerprint:preview.fingerprint,operationId:crypto.randomUUID()});
    await wait(async()=>(await cmd('patternDetail',{id:created.id})).status==='succeeded','next report');
    const opening=app.waitForEvent('window'); await cmd('patternOpen',{id:created.id}); const next=await opening;
    await next.locator('h1').first().waitFor(); interactions.push(await exercise(next,fixture));
    await cmd('patternClose');
  }
  assert.equal(count(),4); checks.push('All four frozen medium reports: real interactions, narrow layouts, keyboard and reduced motion');
  const latest=(await cmd('patternList',{offset:0})).reports[0];
  const sourceCount=(await cmd('snapshot')).sessions.length;
  await page.locator('.learning-nav').click();
  await page.locator('.learning-card').first().getByRole('button',{name:'Report options',exact:true}).click();
  await page.getByRole('menuitem',{name:'Delete report',exact:true}).click();
  const remove=page.getByRole('dialog',{name:'Delete this report?',exact:true});
  await remove.getByRole('button',{name:'Cancel',exact:true}).click();await remove.waitFor({state:'hidden'});
  assert.equal((await cmd('patternList',{offset:0})).reports.length,4);
  const viewerOpening=app.waitForEvent('window');await cmd('patternOpen',{id:latest.id});const deletedViewer=await viewerOpening;
  await page.locator('.learning-card').first().getByRole('button',{name:'Report options',exact:true}).click();
  await page.getByRole('menuitem',{name:'Delete report',exact:true}).click();
  await remove.getByRole('button',{name:'Delete report',exact:true}).click();await remove.waitFor({state:'hidden'});
  await wait(()=>deletedViewer.isClosed(),'deletion closes viewer');
  assert.equal((await cmd('patternList',{offset:0})).reports.length,3);
  assert.equal((await cmd('snapshot')).sessions.length,sourceCount);
  assert.equal((await cmd('patternState')).reportId,null);
  checks.push('Report deletion confirmation, cancellation, viewer revocation, source preservation and ready-indicator cleanup');

  fixture = fixtures.push('This is not an HTML report.') - 1;
  await addConversation();
  const failedScope = await cmd('patternPreview');
  const failedReport = await cmd('patternCreate', { fingerprint: failedScope.fingerprint, operationId: crypto.randomUUID() });
  await wait(async () => (await cmd('patternDetail', { id: failedReport.id })).status === 'failed', 'failed report');
  await page.locator('.learning-nav').click();
  const beforeInspect = count();
  await page.getByRole('button', { name: 'View existing report', exact: true }).click();
  await page.getByRole('dialog', { name: 'Report details', exact: true }).getByRole('button', { name: 'Retry generation', exact: true }).waitFor();
  assert.equal(count(), beforeInspect, 'Inspecting an incomplete report must not retry automatically');
  await page.getByRole('button', { name: 'Close report details', exact: true }).click();
  checks.push('Existing failed report opens its retry inspector without opening invalid HTML or generating automatically');

  const hits=[];
  const probeServer=createServer((req,res)=>{hits.push(req.url);res.writeHead(200,{'access-control-allow-origin':'*'});res.end('probe');});
  await new Promise(r=>probeServer.listen(0,'127.0.0.1',r));
  const probeUrl=`http://127.0.0.1:${probeServer.address().port}/probe`;
  async function replay(content) {
    fixture=fixtures.push(content)-1; await addConversation(); const preview=await cmd('patternPreview');
    const created=await cmd('patternCreate',{fingerprint:preview.fingerprint,operationId:crypto.randomUUID()});
    await wait(async()=>(await cmd('patternDetail',{id:created.id})).status==='succeeded','probe report');
    const opening=app.waitForEvent('window'); await cmd('patternOpen',{id:created.id}); return {id:created.id,window:await opening};
  }
  try {
    const hostile=await replay(`<!DOCTYPE html><html><head><title>Untrusted title</title></head><body><h1>Isolation probe</h1>
      <a id="fragment" href="#anchor">Jump within report</a><p id="anchor">Anchor</p>
      <a id="download" download="probe.txt" href="${probeUrl}">Download</a>
      <form action="${probeUrl}" method="post"><input name="probe" value="synthetic"></form>
      <iframe src="${probeUrl}"></iframe><img src="${probeUrl}" alt="probe">
      <script>
      window.probe={node:typeof process,require:typeof require,bridge:typeof window.stomylos,violations:[]};
      addEventListener('securitypolicyviolation',e=>probe.violations.push(e.effectiveDirective));
      const urls=['${probeUrl}','stomylos://app/index.html','stomylos-audio://probe','file:///tmp/stomylos-nonexistent-probe'];
      Promise.all(urls.map(url=>fetch(url).then(()=>false,()=>true))).then(blocked=>{probe.fetchBlocked=blocked;probe.done=true;});
      try {localStorage.setItem('probe','x');probe.storage=false;}catch{probe.storage=true;}
      try {sessionStorage.setItem('probe','x');probe.sessionStorage=false;}catch{probe.sessionStorage=true;}
      try {eval('probe.evaluated=true');}catch{probe.evalBlocked=true;}
      try {new Worker('data:text/javascript,postMessage(1)');probe.workerCreated=true;}catch{probe.workerBlocked=true;}
      try {new WebSocket('${probeUrl.replace('http:','ws:')}');}catch{}
      window.open('${probeUrl}');
      addEventListener('beforeunload',e=>{e.preventDefault();e.returnValue='Stay';});
      </script></body></html>`);
    const w=hostile.window; await w.waitForFunction(()=>window.probe?.done);
    const results=await w.evaluate(()=>window.probe);
    assert.equal(results.node,'undefined');assert.equal(results.require,'undefined');assert.equal(results.bridge,'undefined');
    assert.equal(results.storage,true);assert.equal(results.sessionStorage,true);assert.equal(results.evalBlocked,true);assert.deepEqual(results.fetchBlocked,[true,true,true,true]);
    await w.locator('#fragment').click();assert.ok(w.url().endsWith('#anchor'));
    await w.locator('#download').click({noWaitAfter:true});await w.evaluate(()=>document.querySelector('form').submit());
    await w.evaluate(url=>{location.href=url;},probeUrl).catch(()=>{});
    await wait(async()=> (await cmd('snapshot')).activity.phase==='idle','main responsive');
    assert.ok(w.url().startsWith('stomylos-report:')); assert.deepEqual(hits,[]);
    assert.equal((await app.windows()).length,2);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('stomylos-report:')).close());
    await wait(()=>w.isClosed(),'native beforeunload close');
    checks.push('Hostile HTML blocked network, private origins, storage, eval, popup, form, download and navigation; fragments and native close remain usable');
    const hanging=await replay('<!DOCTYPE html><html><head><title>Hang</title></head><body><h1>Hanging report</h1><script>window.startHang=()=>setTimeout(()=>{while(true){}},25)</script></body></html>');
    await hanging.window.locator('h1').waitFor();
    await hanging.window.evaluate(()=>window.startHang());
    await new Promise(r=>setTimeout(r,100));
    await cmd('snapshot'); await cmd('patternClose'); await wait(()=>hanging.window.isClosed(),'close hung report');
    const crashing=await replay('<!DOCTYPE html><html><head><title>Crash</title></head><body><h1>Crash probe</h1></body></html>');
    await crashing.window.locator('h1').waitFor();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('stomylos-report:')).webContents.forcefullyCrashRenderer());
    await wait(()=>crashing.window.isClosed(),'crash cleanup'); await cmd('snapshot');
    checks.push('Hung and crashed report renderers do not prevent main IPC or trusted viewer close');
  } finally {probeServer.closeAllConnections();await new Promise(r=>probeServer.close(r));}

  let lastV2;
  for(const id of v2Ids) {
    const rendered=await replay(readFileSync(`tests/fixtures/pattern-reports/${id}.html`,'utf8'));
    interactions.push(await exerciseV2(rendered.window,id,rendered.id));
    await cmd('patternClose');
    const opening=app.waitForEvent('window');await cmd('patternOpen',{id:rendered.id});const reopened=await opening;
    await reopened.locator('h1').first().waitFor();await cmd('patternClose');
    lastV2=rendered;
  }
  checks.push('Five selected v2 outputs replay unchanged at three widths, with focus/answer/disclosure/keyboard and reopen checks');
  const beforeUpgrade=count(); await close();
  execFileSync(createRequire(import.meta.url)('electron'),['scripts/seed-pattern-history.mjs',directory,lastV2.id,failedReport.id],{
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8'});
  await launch();assert.equal(count(),beforeUpgrade);
  const legacyOpening=app.waitForEvent('window');await cmd('patternOpen',{id:lastV2.id});const legacy=await legacyOpening;
  await legacy.locator('h1').first().waitFor();assert.equal(count(),beforeUpgrade);await cmd('patternClose');
  assert.equal((await cmd('patternDetail',{id:failedReport.id})).canRetry,true);
  fixture=fixtures.push(readFileSync('tests/fixtures/pattern-reports/v2-P03.html','utf8'))-1;
  await cmd('patternRetry',{id:failedReport.id,operationId:crypto.randomUUID()});
  await wait(async()=>(await cmd('patternDetail',{id:failedReport.id})).status==='succeeded','v1 retry');
  const oldRequest=mock.requests.filter(r=>r.max_tokens===32768).at(-1);assert.equal(oldRequest.messages[0].content,v1System);
  const upgradedPreview=await cmd('patternPreview');assert.equal(upgradedPreview.existingId,null);
  const upgraded=await cmd('patternCreate',{fingerprint:upgradedPreview.fingerprint,operationId:crypto.randomUUID()});
  await wait(async()=>(await cmd('patternDetail',{id:upgraded.id})).status==='succeeded','v2 new contract');
  assert.equal(mock.requests.filter(r=>r.max_tokens===32768).at(-1).messages[0].content,v2System);
  assert.equal((await cmd('patternCreate',{fingerprint:upgradedPreview.fingerprint,operationId:crypto.randomUUID()})).reused,true);
  assert.equal(count(),beforeUpgrade+2);
  await close();await launch();assert.equal(count(),beforeUpgrade+2);
  assert.equal((await cmd('patternDetail',{id:lastV2.id})).status,'succeeded');
  checks.push('Packaged/native v1 history opens without inference, failed v1 retries its frozen request, v2 creates separately and reuses across restart');

  assert.deepEqual(errors,[]);
  writeFileSync(`test-results/pattern-${packaged?'packaged':'native'}.json`,JSON.stringify({passed:true,directory,checks,security,errors,liveCalls:0,replayedReports:9,systemHash:createHash('sha256').update(v2System).digest('hex'),interactions},null,2));
  console.log(JSON.stringify({passed:true,checks}));
} catch (error) { console.error(error); throw error; }
finally { release?.(); if(app) { await app.evaluate(({app})=>app.exit()); } mock.server.closeAllConnections(); await new Promise(r=>mock.server.close(r)); }
