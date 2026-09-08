// Focused end-processing UX with disposable data and local, zero-cost responses.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const directory = mkdtempSync('/tmp/stomylos-capacity-ui-');
const output = 'test-results/memory-capacity'; mkdirSync(output, { recursive: true });
const report = { status:'running', directory, paidRequests:0, checks:[], errors:[] };
let app, page, cleanupCalls = 0, fail = true;
const respond = (res, model, provider, content) => { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({model, provider, choices:[{finish_reason:'stop',message:{content}}],usage:{cost:0}})); };
const mock = await startMockGateway({ delay:0, memoryHandler: async (body,res) => {
  const packet = JSON.parse(body.messages[1].content);
  const source = packet.session.messages.find(m => m.origin === 'learner');
  respond(res,body.model,'Google AI Studio',JSON.stringify({operations:[{op:'add',id:null,category:'experiences',text:'Useful detail. '.repeat(2500),source_message_ids:[source.id]}]}));
}, cleanupHandler: async (body,res) => {
  cleanupCalls++; assert.deepEqual(body.provider,{allow_fallbacks:true,require_parameters:true});
  respond(res,body.model,'Automatic mock', fail ? 'invalid structure' : 'Traits\nPrefers useful detail.\nRelationships\nExperiences\nIntentions');
}});
const env = {...process.env, STOMYLOS_DATA_DIR:directory, STOMYLOS_TEST_ENDPOINT:mock.endpoint};
for (const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY']) delete env[key];
const command = (name,args) => page.evaluate(([name,args]) => window.stomylos.command(name,args),[name,args]);
const button = name => page.getByRole('button',{name,exact:true});
async function wait(fn,label) { const deadline = Date.now()+15000; while(Date.now()<deadline) { if(await fn()) return; await new Promise(r=>setTimeout(r,50)); } throw new Error(label); }
async function begin() {
  const snap = await command('snapshot'), id = snap.unfinished?.id ?? await command('newSession');
  await command('selectPartner',{sessionId:id,character:'model_04'}); await command('searchMode',{sessionId:id,mode:'off'});
  await command('sendMessage',{sessionId:id,text:'I value useful detail in memories.',revision:1});
  await wait(async()=> (await command('loadSession',{sessionId:id})).messages.at(-1).delivery==='complete' && (await command('snapshot')).activity.phase==='idle','chat did not complete');
  return id;
}
try {
  app = await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,chromiumSandbox:true,timeout:20000});
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror',e=>report.errors.push(e.message));
  await button('Settings').waitFor(); const id = await begin();
  await command('endSession',{sessionId:id});
  await wait(async()=>cleanupCalls===2 && (await command('loadSession',{sessionId:id})).memory.cleanup?.state==='failed','cleanup retry did not fail');
  assert.equal((await command('snapshot')).endBlocker,id);
  await assert.rejects(command('newSession'),/end_processing_pending/);
  if(await button('Show history').count()) await button('Show history').click();
  await page.locator('.history-item').first().click();
  await button('Processing details').click();
  const panel = page.getByRole('region',{name:'Processing stages'});
  await panel.waitFor(); assert.match(await panel.innerText(),/Memory cleanup[\s\S]*Needs attention/);
  report.checks.push('Two cleanup calls, exact automatic routing, failed-stage UI and IPC new-chat gate');
  await page.setViewportSize({width:720,height:800});
  await page.screenshot({path:output+'/failure-narrow.png'});
  fail = false; await button('Continue processing').click();
  await wait(async()=>!(await command('snapshot')).endBlocker,'manual recovery did not unlock');
  assert.equal(cleanupCalls,3);
  await panel.getByText('Chat saved · Processing complete',{exact:true}).waitFor();
  await page.getByRole('button',{name:/^Shared memory/}).click(); await button('Changes from this chat').click();
  await page.getByRole('region',{name:'Memory cleanup history'}).waitFor();
  await page.screenshot({path:output+'/cleanup-history.png'});
  report.checks.push('Manual Continue makes one cleanup call and renders separate cleanup history');
  await page.getByRole('button',{name:/Close/}).first().click();
  const second = await begin(); fail = true; await command('endSession',{sessionId:second});
  await wait(async()=> (await command('loadSession',{sessionId:second})).memory.cleanup?.state==='failed','second cleanup did not fail');
  await command('cancelEnd',{sessionId:second});
  const view = await command('loadSession',{sessionId:second});
  assert.equal(view.endProcessing.cancelled,true); assert.equal((await command('snapshot')).endBlocker,null);
  await assert.rejects(command('continueEnd',{sessionId:second}),/end_processing_cancelled/);
  report.checks.push('Force cancellation releases gate and permanently blocks replay');
  assert.deepEqual(report.errors,[]); report.status='passed';
} catch(error) { report.status='failed'; report.errors.push(error.stack); if(page) report.uiText = await page.locator('body').innerText().catch(()=> 'unavailable'); process.exitCode=1; }
finally { if(app) await app.close(); mock.server.closeAllConnections(); await new Promise(resolve => mock.server.close(resolve)); writeFileSync(output+'/report.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); }
