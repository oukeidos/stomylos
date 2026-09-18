// Focused real-shell regression: isolated data, no provider requests.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const output='test-results/report-shell'; mkdirSync(output,{recursive:true});
const mock=await startMockGateway();
const env={...process.env,STOMYLOS_DATA_DIR:mkdtempSync('/tmp/stomylos-report-shell-'),STOMYLOS_TEST_ENDPOINT:mock.endpoint};
for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY','OPENROUTER_API_KEY'])delete env[key];
let app; const result={status:'running',errors:[],checks:[]};
try{
 app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,timeout:20000});
 const page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',e=>result.errors.push(e.message));
 await page.locator('.composer textarea').waitFor();
 const button=name=>page.getByRole('button',{name,exact:true});
 const box=locator=>locator.boundingBox();
 for(const width of [1180,760]){
  await page.setViewportSize({width,height:860});
  const chats=await box(button('Chats')),reports=await box(button('Reports')),toggle=await box(page.getByRole('switch'));
  assert.equal(chats.y,reports.y);assert.equal(chats.height,reports.height);
  assert.equal(chats.y+chats.height/2,toggle.y+toggle.height/2);assert(toggle.x>reports.x+reports.width);
  await page.getByRole('switch').click();assert.equal(await page.getByRole('switch').getAttribute('aria-checked'),'true');
  await page.getByRole('switch').click();
  const spacer=await box(page.locator('.composer-spacer'));assert(spacer.width>10,'composer tool groups need space');
  const controls=await page.locator('.composer-actions button').evaluateAll(nodes=>nodes.filter(n=>n.checkVisibility()).map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};}));
  const center=controls[0].y+controls[0].height/2;
  assert(controls.every(r=>Math.abs(r.y+r.height/2-center)<1),'composer buttons must share a row');
  const send=await box(button('Send'));assert(send.x>spacer.x+spacer.width);
  assert.equal(await page.locator('.composer').evaluate(n=>n.scrollWidth>n.clientWidth),false);
  await page.screenshot({path:`${output}/chats-${width}.png`});
  await button('Reports').click();await page.locator('.reports-main:not([hidden])').waitFor();
  assert.equal((await box(button('Chats'))).y,(await box(button('Reports'))).y);
  assert.equal(await page.getByRole('switch').count(),0);
  await button('+ New report').click();await page.getByRole('heading',{name:'New report',exact:true}).waitFor();
  assert.equal(await page.locator('.reports-main').evaluate(n=>n.scrollWidth>n.clientWidth),false);
  await page.screenshot({path:`${output}/reports-${width}.png`});
  await button('Chats').click();await page.locator('.composer textarea').waitFor();
  result.checks.push(`${width}px: aligned navigation/bookmark toggle, spaced composer groups, report creation and chat return`);
 }
 assert.equal(mock.requests.length,0);assert.deepEqual(result.errors,[]);result.status='passed';
}catch(error){result.status='failed';result.failure=String(error);throw error;}
finally{writeFileSync(`${output}/result.json`,JSON.stringify(result,null,2));await app?.close();await new Promise(resolve=>mock.server.close(resolve));}
console.log(JSON.stringify(result));
