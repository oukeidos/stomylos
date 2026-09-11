// Isolated layout/accessibility check; no Send or provider requests.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const baseline=process.argv.includes('--baseline');
const directory=mkdtempSync('/tmp/stomylos-memory-density-');
const output='test-results/memory-density';mkdirSync(output,{recursive:true});
const mock=await startMockGateway({delay:5});
const env={...process.env,STOMYLOS_DATA_DIR:directory,STOMYLOS_TEST_ENDPOINT:mock.endpoint};
for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY'])delete env[key];
const report={status:'running',baseline,geometry:[],errors:[]};let app,page;
const button=name=>page.getByRole('button',{name,exact:true});
const settle=()=>page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>undefined))));
try {
 app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,chromiumSandbox:true,timeout:20000});
 page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));await button('Settings').waitFor();
 await app.evaluate(({app},directory)=>{
   const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json');
   const Database=require('better-sqlite3'),{createHash}=require('node:crypto'),db=new Database(directory+'/stomylos.sqlite3');
   const texts=['Prefers coffee in the morning.','Lives in Seoul.','Enjoys long conversations about books, especially in quiet libraries. Prefers small groups where everyone has enough time to explain their ideas without interruption.','Practices English most evenings.','Likes walking by the river.','Works from home on Fridays.','Usually cooks dinner at home.','Has a weekly reading group.','Prefers messages to phone calls.','Enjoys photography on trips.'];
   const document=JSON.stringify({character_id:'shared',revision:0,database_records:Array.from({length:24},(_,i)=>({id:'m'+i,text:texts[i%texts.length]}))});
   db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(document,createHash('sha256').update(document).digest('hex'));db.close();
 },directory);
 await button('Settings').click();await page.getByRole('tab',{name:'Memory',exact:true}).click();await button('Edit').first().waitFor();
 for(const [width,height] of [[1180,860],[760,620]]) {
   await app.evaluate(({BrowserWindow},[w,h])=>BrowserWindow.getAllWindows()[0].setContentSize(w,h),[width,height]);
   await page.locator('.settings-panel:not([hidden])').evaluate(n=>n.scrollTop=0);await page.mouse.move(2,2);await settle();
   const geometry=await page.locator('.settings-panel:not([hidden])').evaluate(panel=>{
     const bounds=panel.getBoundingClientRect(),rows=[...panel.querySelectorAll('.memory-items>li')],first=rows[0].getBoundingClientRect();
     return {overflow:panel.scrollWidth>panel.clientWidth,visible:rows.filter(n=>{const r=n.getBoundingClientRect();return r.top>=bounds.top&&r.bottom<=bounds.bottom;}).length,rowHeight:first.height,fontSize:getComputedStyle(rows[0]).fontSize,bodyWidth:rows[0].querySelector('.memory-text').getBoundingClientRect().width};
   });
   assert.equal(geometry.overflow,false);report.geometry.push({width,height,...geometry});
   if(!baseline) {
     // Measured pre-density layout with the same fixture; no ignored artifact dependency.
     const old={fontSize:'14px',rowHeight:101.5390625,visible:width===1180?3:2};
     assert.equal(geometry.fontSize,old.fontSize);assert.ok(geometry.visible>old.visible);assert.ok(geometry.rowHeight<old.rowHeight);
     const edit=button('Edit').first(),del=button('Delete').first();
     const e=await edit.boundingBox(),d=await del.boundingBox();assert.equal(e.y,d.y);assert.ok(e.width>=36&&e.height>=36);
     await edit.focus();await page.getByRole('tooltip',{name:'Edit',exact:true}).waitFor();await page.keyboard.press('Enter');await page.getByRole('textbox',{name:'Edit memory'}).waitFor();await button('Cancel').click();
     await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Edit');assert.equal(await edit.evaluate(n=>n===document.activeElement),true);
     await del.click();await page.getByText('Delete this memory?',{exact:true}).waitFor();await button('Cancel').click();
   }
   await page.mouse.move(2,2);await settle();await page.screenshot({path:`${output}/${baseline?'before':'after'}-${width}.png`});
 }
 if(!baseline) {
   await button('About memory').click();await page.getByText('An untouched new chat uses your changes',{exact:false}).waitFor();assert.equal(await button('About memory').getAttribute('aria-expanded'),'true');await button('About memory').click();
   const search=page.getByRole('searchbox',{name:'Search memories'});await search.fill('Seoul');assert.equal(await button('Edit').count(),3);assert.equal(await page.locator('.memory-count').innerText(),'3 / 24');await button('Clear search').click();assert.equal(await button('Edit').count(),24);
   assert.equal(await page.locator('.memory-items').getByText('Enjoys long conversations about books, especially in quiet libraries. Prefers small groups where everyone has enough time to explain their ideas without interruption.',{exact:true}).count(),3);
 }
 assert.equal(mock.requests.length,0);assert.deepEqual(report.errors,[]);report.status='passed';
} catch(error) {report.status='failed';report.error=String(error);if(page&&!page.isClosed())await page.screenshot({path:`${output}/failure.png`}).catch(()=>undefined);throw error;}
finally {await app?.close().catch(()=>undefined);await new Promise(r=>mock.server.close(r));writeFileSync(`${output}/${baseline?'baseline':'report'}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
