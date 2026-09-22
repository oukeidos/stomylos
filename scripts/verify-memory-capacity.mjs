import {closeNative} from './native-lifecycle.mjs';
// Focused end-processing UX with disposable data and local, zero-cost responses.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const directory = mkdtempSync('/tmp/stomylos-capacity-ui-');
const output = 'test-results/memory-capacity'; mkdirSync(output, { recursive: true });
const report = { status:'running', directory, paidRequests:0, checks:[], errors:[] };
let app, page, memoryCalls = 0, fail = true;
const respond = (res, model, provider, content) => { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({model, provider, choices:[{finish_reason:'stop',message:{content}}],usage:{cost:0}})); };
const mock = await startMockGateway({ delay:0, memoryHandler: async (body,res) => {
  memoryCalls++;assert.deepEqual(body.provider,{allow_fallbacks:true,require_parameters:true,data_collection:'deny'});
  respond(res,body.model,'Automatic mock',JSON.stringify({add:[fail?'x'.repeat(3001):'Prefers useful detail.']}));
}});
const env = {...process.env, STOMYLOS_DATA_DIR:directory, STOMYLOS_TEST_ENDPOINT:mock.endpoint};
for (const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY']) delete env[key];
const command = (name,args) => page.evaluate(([name,args]) => window.stomylos.command(name,args),[name,args]);
const button = name => page.getByRole('button',{name,exact:true});
async function wait(fn,label) { const deadline = Date.now()+15000; while(Date.now()<deadline) { if(await fn()) return; await new Promise(r=>setTimeout(r,50)); } throw new Error(label); }
async function begin() {
  const snap = await command('snapshot'), id = snap.unfinished?.id ?? await command('newSession');
  await command('selectPartner',{sessionId:id,character:'model_03'}); await command('searchMode',{sessionId:id,mode:'off'});
  await command('sendMessage',{sessionId:id,text:'I value useful detail in memories.',revision:1});
  await wait(async()=> (await command('loadSession',{sessionId:id})).messages.at(-1).delivery==='complete' && (await command('snapshot')).activity.phase==='idle','chat did not complete');
  return id;
}
try {
  app = await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,chromiumSandbox:true,timeout:20000});
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror',e=>report.errors.push(e.message));
  await button('Settings').waitFor(); const id = await begin();
  await command('endSession',{sessionId:id});
  await wait(async()=>memoryCalls===1 && (await command('loadSession',{sessionId:id})).memory.job?.state==='failed','oversized ADD did not fail');
  assert.equal((await command('snapshot')).endBlocker,id);assert.equal((await command('loadSession',{sessionId:id})).memory.addJobs[0].failure,'memory_add_item_capacity');
  await assert.rejects(command('newSession'),/end_processing_pending/);
  const panel = page.locator('.end-processing-dialog');
  await panel.waitFor();
  await panel.getByText('Retry needed', { exact: true }).waitFor();
  assert.equal(await page.locator('.new-chat').isDisabled(), true);
  report.checks.push('One bounded extraction call, exact automatic routing, failed-stage UI and IPC new-chat gate');
  await page.setViewportSize({width:720,height:800});
  await page.screenshot({path:output+'/failure-narrow.png'});
  // A persisted blocker must reopen the modal without replaying failed provider work.
  await closeNative(app);
  app = await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,chromiumSandbox:true,timeout:20000});
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror',e=>report.errors.push(e.message));
  await page.locator('.end-processing-dialog').waitFor();
  assert.equal(memoryCalls,1);
  report.checks.push('Restart restores the blocking modal without replay');
  fail = false; await button('Retry session memories').click();
  await wait(async()=>!(await command('snapshot')).endBlocker,'manual recovery did not unlock');
  assert.equal(memoryCalls,2);
  await page.locator('.end-processing-dialog').waitFor({state:'hidden'});
  assert.equal(await button('New chat').isEnabled(),true);
  await button('Conversation details').click();
  await page.getByRole('button',{name:/^Shared memory/}).click(); await button('Changes from this chat').click();
  await page.getByText('Prefers useful detail.',{exact:true}).waitFor();
  await page.screenshot({path:output+'/cleanup-history.png'});
  report.checks.push('Explicit retry makes one extraction and one source-link call and renders saved additions');
  await page.getByRole('button',{name:/Close/}).first().click();
  const second = await begin(); fail = true; await command('endSession',{sessionId:second});
  await wait(async()=> (await command('loadSession',{sessionId:second})).memory.job?.state==='failed','second oversized ADD did not fail');
  await button('Cancel remaining').click();
  await page.locator('.end-processing-dialog').waitFor({state:'hidden'});
  const view = await command('loadSession',{sessionId:second});
  assert.equal(view.endProcessing.cancelled,true); assert.equal((await command('snapshot')).endBlocker,null);
  await assert.rejects(command('continueEnd',{sessionId:second}),/end_processing_cancelled/);
  report.checks.push('Force cancellation releases gate and permanently blocks replay');
  assert.deepEqual(report.errors,[]); report.status='passed';
} catch(error) { report.status='failed'; report.errors.push(error.stack); if(page) report.uiText = await page.locator('body').innerText().catch(()=> 'unavailable'); process.exitCode=1; }
finally { if(app) await closeNative(app); mock.server.closeAllConnections(); await new Promise(resolve => mock.server.close(resolve)); writeFileSync(output+'/report.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); }
