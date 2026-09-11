// Focused isolated Memory switch geometry, persistence and keyboard verification.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startMockGateway } from './mock-gateway.mjs';
const target=process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const directory=mkdtempSync('/tmp/stomylos-memory-controls-ui-'),output='test-results/memory-controls';mkdirSync(output,{recursive:true});
const mock=await startMockGateway({delay:5});
const env={...process.env,STOMYLOS_DATA_DIR:directory,STOMYLOS_TEST_ENDPOINT:mock.endpoint};
for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY'])delete env[key];
const report={status:'running',geometry:[],errors:[]};let app,page;
const button=name=>page.getByRole('button',{name,exact:true});
const launch=async()=>{
 app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[target],env,chromiumSandbox:true,timeout:20000});
 page=await app.firstWindow();await page.addStyleTag({content:'.dialog,.modal-overlay {animation:none!important;transition:none!important;}'});page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));await button('Settings').waitFor();
};
const geometry=()=>page.locator('.settings-panel:not([hidden])').evaluate(panel=>{
 const rect=n=>{const {x,y,width,height}=n.getBoundingClientRect();return {x,y,width,height};};
 const list=panel.querySelector('.memory-items'),first=list.firstElementChild;
 return {panel:rect(panel),search:rect(panel.querySelector('.memory-toolbar')),first:rect(first),available:panel.getBoundingClientRect().bottom-list.getBoundingClientRect().top-parseFloat(getComputedStyle(panel).paddingBottom),font:getComputedStyle(first).fontSize,overflow:panel.scrollWidth>panel.clientWidth};
});
try {
 await launch();
 await app.evaluate(({app},directory)=>{
   const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json'),Database=require('better-sqlite3'),{createHash}=require('node:crypto'),db=new Database(directory+'/stomylos.sqlite3');
   const document=JSON.stringify({character_id:'shared',revision:0,database_records:Array.from({length:24},(_,i)=>({id:'m'+i,text:`Saved detail ${i+1}: enjoys books and quiet walks in the park.`}))});
   db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(document,createHash('sha256').update(document).digest('hex'));db.close();
 },directory);
 await button('Settings').click();await page.getByRole('tab',{name:'Memory',exact:true}).click();await button('Edit').first().waitFor();
 for(const [width,height] of [[1180,860],[760,620]]){
   await app.evaluate(({BrowserWindow},[w,h])=>BrowserWindow.getAllWindows()[0].setContentSize(w,h),[width,height]);
   await page.locator('.settings-panel:not([hidden])').evaluate(n=>n.scrollTop=0);
   await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>undefined))));
   const before=await geometry();
   // Reproduce the pre-change heading only; all record/search/style geometry is shared.
   await page.evaluate(()=>{
     const current=document.querySelector('.memory-control'),old=document.createElement('div');old.className='memory-scope';
     const text=document.createElement('span');text.textContent='Shared across all partners';old.append(text,current.querySelector('[aria-label="About memory"]').cloneNode(true));
     window.__memoryHeading={current,old};current.replaceWith(old);
   });
   const original=await geometry();await page.evaluate(()=>{const {current,old}=window.__memoryHeading;old.replaceWith(current);delete window.__memoryHeading;});
   assert.deepEqual(before,original);assert.equal(before.overflow,false);
   const toggle=page.getByRole('switch',{name:'Use memory'});await toggle.click();await page.waitForFunction(()=>document.querySelector('[role=switch][aria-label="Use memory"]')?.getAttribute('aria-checked')==='false');
   assert.deepEqual(await geometry(),before);
   await button('About memory').click();await page.getByRole('region',{name:'About memory'}).waitFor();assert.deepEqual(await geometry(),before);
   await page.keyboard.press('Escape');await page.getByRole('region',{name:'About memory'}).waitFor({state:'hidden'});assert.equal(await button('About memory').evaluate(n=>n===document.activeElement),true);
   await toggle.focus();await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('[role=switch][aria-label="Use memory"]')?.getAttribute('aria-checked')==='true');
   assert.deepEqual(await geometry(),before);report.geometry.push({width,height,...before});
   await page.screenshot({path:`${output}/${width}.png`});
 }
 // Stale-write error stays in an overlay, preserves geometry and can be retried.
 const stable=await geometry();
 await app.evaluate(({app},directory)=>{const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json'),db=new (require('better-sqlite3'))(directory+'/stomylos.sqlite3');db.prepare('UPDATE memory_preferences SET revision=revision+1').run();db.close();},directory);
 await page.getByRole('switch',{name:'Use memory'}).click();await page.getByRole('alert').waitFor();assert.deepEqual(await geometry(),stable);
 assert.equal(await page.getByRole('switch',{name:'Use memory'}).getAttribute('aria-checked'),'true');await button('Retry').click();
 await page.waitForFunction(()=>document.querySelector('[role=switch][aria-label="Use memory"]')?.getAttribute('aria-checked')==='false');
 await page.keyboard.press('Escape');await page.getByRole('switch',{name:'Use memory'}).click();
 await page.waitForFunction(()=>document.querySelector('[role=switch][aria-label="Use memory"]')?.getAttribute('aria-checked')==='true');
 await button('Edit').first().click();const editor=page.getByRole('textbox',{name:'Edit memory'});await editor.fill('Unsaved exact edit 한글');
 await page.getByRole('switch',{name:'Use memory'}).click();await page.waitForFunction(()=>document.querySelector('[role=switch][aria-label="Use memory"]')?.getAttribute('aria-checked')==='false');
 assert.equal(await editor.inputValue(),'Unsaved exact edit 한글');await button('Cancel').click();
 // Existing processing gate blocks even a stale programmatic preference command.
 await app.evaluate(({app},directory)=>{
   const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json'),db=new (require('better-sqlite3'))(directory+'/stomylos.sqlite3');
   const session=db.prepare("SELECT id FROM sessions WHERE state!='ended'").get();db.prepare('INSERT INTO end_processing(session_id,created_at) VALUES(?,?)').run(session.id,new Date().toISOString());
   db.prepare("INSERT INTO memory_jobs(session_id,character_id,source,source_hash,config,config_hash,created_at,state) VALUES(?,'model_04','{}','fixture','{}','fixture',?,'pending')").run(session.id,new Date().toISOString());db.close();
 },directory);
 const blocked=await page.evaluate(async()=>{const s=await window.stomylos.command('snapshot',undefined);try{await window.stomylos.command('setMemoryPreference',{enabled:true,revision:s.settings.memory.revision});return null;}catch(e){return e.message;}});
 assert.equal(blocked,'end_processing_pending');
 await page.evaluate(async()=>{const s=await window.stomylos.command('snapshot',undefined);await window.stomylos.command('cancelEnd',{sessionId:s.endBlocker});});
 await app.close();app=null;await launch();await button('Settings').click();await page.getByRole('tab',{name:'Memory',exact:true}).click();
 assert.equal(await page.getByRole('switch',{name:'Use memory'}).getAttribute('aria-checked'),'false');
 assert.equal(mock.requests.length,0);assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.error=String(error);if(page&&!page.isClosed())await page.screenshot({path:`output/failure.png`.replace('output',output)}).catch(()=>undefined);throw error;}
finally{await app?.close().catch(()=>undefined);await new Promise(r=>mock.server.close(r));writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
