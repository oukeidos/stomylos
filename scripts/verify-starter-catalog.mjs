// Focused isolated draft/skip/answer/end/reopen acceptance. No provider access.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const directory=mkdtempSync('/tmp/stomylos-catalog-ui-'), output='test-results/starter-catalog';
mkdirSync(output,{recursive:true});
const mock=await startMockGateway({delay:15,backgroundDelay:300});
const env={...process.env,STOMYLOS_DATA_DIR:directory,STOMYLOS_TEST_ENDPOINT:mock.endpoint};
for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY']) delete env[key];
let app,page;const report={status:'running',paidRequests:0,checks:[],errors:[]};
const launch=async()=>{app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,chromiumSandbox:true,timeout:20000});page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));await page.getByRole('button',{name:'Settings',exact:true}).waitFor();};
const command=(name,args)=>page.evaluate(([name,args])=>window.stomylos.command(name,args),[name,args]);
async function wait(fn) {const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out waiting for local flow');}
try {
  await launch();const snapshot=await command('snapshot'),id=snapshot.unfinished.id;
  const initial=await command('loadSession',{sessionId:id});assert.match(initial.session.starter_id,/^catalog:joint-v1:/);
  const input=page.getByRole('textbox',{name:'Your message'});await input.fill('A saved draft.');
  await page.getByRole('button',{name:'Another question',exact:true}).click();assert.equal(await input.inputValue(),'A saved draft.');
  await wait(async()=>(await command('loadSession',{sessionId:id})).session.starter_id!==initial.session.starter_id);
  const changed=await command('loadSession',{sessionId:id});assert.notEqual(changed.session.starter_id,initial.session.starter_id);assert.equal(mock.requests.length,0);
  await command('searchMode',{sessionId:id,mode:'off'});await command('selectPartner',{sessionId:id,character:'model_04'});
  await input.fill('I enjoy quiet museums.');await input.press('Enter');
  await wait(async()=>{const v=await command('loadSession',{sessionId:id});return v.session.state==='active'&&v.messages.at(-1)?.origin==='model'&&v.messages.at(-1)?.delivery==='complete';});
  await page.getByRole('button',{name:'End chat',exact:true}).click();
  await wait(async()=>(await command('loadSession',{sessionId:id})).endProcessing?.complete);
  const ended=await command('loadSession',{sessionId:id});assert.equal(ended.renewal,null);assert.equal(ended.endProcessing.stages.starter,'skipped');
  assert.equal(await page.getByText('New questions',{exact:true}).count(),0);
  const calls=mock.requests.length;await app.close();app=null;await launch();
  const restored=await command('loadSession',{sessionId:id});assert.equal(restored.session.starter_text,changed.session.starter_text);assert.equal(mock.requests.length,calls);
  const next=await command('newSession');const nextView=await command('loadSession',{sessionId:next});assert.match(nextView.session.starter_id,/^catalog:joint-v1:/);
  assert(mock.requests.every(r=>!JSON.stringify(r).includes('stomylos_starter_generation')));
  report.checks.push('Catalog starter and request-free skip preserve draft','Answer/end completes grammar and memory with no renewal job','Reopen preserves opening and makes no requests','New chat uses the reusable catalog');
  assert.deepEqual(report.errors,[]);report.status='passed';await page.screenshot({path:`${output}/screen.png`});
} catch(e) {report.status='failed';report.errors.push(e.stack);if(page)report.debug={snapshot:await command('snapshot').catch(()=>null),text:await page.locator('body').innerText().catch(()=>null)};process.exitCode=1;}
finally {if(app)await app.close();mock.server.closeAllConnections();await new Promise(r=>mock.server.close(r));rmSync(directory,{recursive:true,force:true});writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
