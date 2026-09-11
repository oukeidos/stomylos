// Focused native memory-management verification, synthetic data and local mock only.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const directory=mkdtempSync('/tmp/stomylos-manual-memory-ui-');
const output='test-results/manual-memory';mkdirSync(output,{recursive:true});
const mock=await startMockGateway({delay:5});
const env={...process.env,STOMYLOS_DATA_DIR:directory,STOMYLOS_TEST_ENDPOINT:mock.endpoint};
for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY'])delete env[key];
const report={status:'running',directory,checks:[],errors:[],paidRequests:0};let app,page;
const button=name=>page.getByRole('button',{name,exact:true});
const command=(name,args)=>page.evaluate(([name,args])=>window.stomylos.command(name,args),[name,args]);
const settle=()=>page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>undefined))));
const capture=async name=>{await settle();await page.screenshot({path:`${output}/${name}.png`});};
try {
 app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,chromiumSandbox:true,timeout:20000});
 page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',error=>report.errors.push(error.message));await button('Settings').waitFor();
 await app.evaluate(async ({app},directory)=>{
   const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json');
   const {createHash}=require('node:crypto'),Database=require('better-sqlite3');const db=new Database(directory+'/stomylos.sqlite3');
   const document=JSON.stringify({character_id:'shared',database_records:[{id:'a',text:'Coffee in the morning. Café 한글'},{id:'b',text:'Lives in Seoul.'},{id:'c',text:'Reading in quiet libraries.'}],revision:0});
   db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(document,createHash('sha256').update(document).digest('hex'));db.close();
 },directory);
 const session=(await command('snapshot')).unfinished.id;
 const composer=page.getByRole('textbox',{name:'Your message',exact:true});await composer.fill('Keep my unsent draft. 한글');await page.getByText('Draft saved',{exact:true}).waitFor();
 await button('Settings').click();await page.getByRole('tab',{name:'Memory',exact:true}).click();await button('Edit').first().waitFor();
 assert.equal(await button('Edit').first().isEnabled(),true);
 const search=page.getByRole('searchbox',{name:'Search memories'});await search.fill('MORNING coffee');assert.equal(await button('Edit').count(),1);
 await button('Edit').click();const editor=page.getByRole('textbox',{name:'Edit memory',exact:true});await editor.fill('Tea in the evening. 한글');
 await search.fill('Seoul');assert.equal(await editor.isVisible(),true);
 await page.getByRole('tab',{name:'Voice',exact:true}).click();await page.getByRole('dialog',{name:'Discard memory changes?'}).waitFor();await button('Keep editing').click();assert.equal(await editor.inputValue(),'Tea in the evening. 한글');
 await button('Close settings').click();await button('Keep editing').click();
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await button('Keep editing').click();
 await editor.press('Enter');assert.equal(await editor.isVisible(),true);
 await editor.evaluate(n=>n.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true,bubbles:true})));assert.equal(await editor.isVisible(),true);
 await editor.fill('Tea in the evening. 한글');await editor.press('Control+Enter');await page.getByText('Memory updated',{exact:true}).waitFor();assert.equal(await editor.count(),0);assert.equal(await button('Edit').count(),1);assert.equal(await button('Edit').evaluate(n=>n===document.activeElement),true);
 assert.equal((await command('memoryManagement')).document.database_records[0].text,'Tea in the evening. 한글');
 await button('Clear search').click();
 report.checks.push('Untouched session/draft editing; case/multi-term search; pinned editor; dirty tab/close guard; Enter/IME/Ctrl+Enter; saved filter/focus');
 for(const [width,height] of [[1180,860],[760,620]]) {
   await app.evaluate(({BrowserWindow},[w,h])=>BrowserWindow.getAllWindows()[0].setContentSize(w,h),[width,height]);await settle();
   await button('Edit').first().click();await editor.fill('A precise saved detail with a longer explanation that remains readable at this width. 한글');
   const overflow=await page.locator('.settings-panel:not([hidden])').evaluate(n=>n.scrollWidth>n.clientWidth);assert.equal(overflow,false);await capture(`${width}-editing`);await button('Cancel').click();
 }
 // A storage-independent IPC rejection verifies that the actual renderer preserves drafts.
 await app.evaluate(({ipcMain})=>{const original=ipcMain._invokeHandlers.get('stomylos:command');globalThis.manualOriginal=original;globalThis.manualFail=true;ipcMain.removeHandler('stomylos:command');ipcMain.handle('stomylos:command',(...args)=>{if(args[1]==='editMemory'&&globalThis.manualFail){globalThis.manualFail=false;return {ok:false,error:'memory_edit_conflict'};}return original(...args);});});
 await button('Edit').first().click();await editor.fill('Preserve on failure.');await button('Save').click();await page.getByRole('alert').filter({hasText:'Saved memory changed'}).waitFor();assert.equal(await editor.inputValue(),'Preserve on failure.');
 await button('Save').click();await page.getByText('Memory updated',{exact:true}).waitFor();
 await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('stomylos:command');ipcMain.handle('stomylos:command',globalThis.manualOriginal);delete globalThis.manualOriginal;});
 await button('Edit').first().click();await editor.fill('My pending correction.');
 const latest=await command('memoryManagement');await command('editMemory',{id:'a',text:'Another saved correction.',revision:latest.document.revision,hash:latest.hash});
 await button('Use latest version').waitFor();assert.equal(await editor.inputValue(),'My pending correction.');assert.equal(await button('Save').isDisabled(),true);await button('Use latest version').click();await button('Save').click();await page.getByText('Memory updated',{exact:true}).waitFor();
 await button('Edit').first().click();await editor.fill('Discard this edit.');await page.keyboard.press('Escape');await button('Discard changes').click();await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor({state:'hidden'});
 assert.equal(await composer.inputValue(),'Keep my unsent draft. 한글');
 await button('Settings').click();await page.getByRole('tab',{name:'Memory',exact:true}).click();await button('Delete').first().click();await capture('delete-confirmation');await button('Cancel').click();assert.equal((await command('memoryManagement')).document.database_records.length,3);
 for(let count=3;count>0;count--) {await button('Delete').first().click();await button('Delete memory').click();await page.waitForFunction(n=>document.querySelectorAll('.memory-items>li').length===n,count-1);}
 await page.getByText('Memory deleted',{exact:true}).waitFor();assert.equal((await command('memoryManagement')).document.database_records.length,0);assert.equal(await search.evaluate(n=>n===document.activeElement),true);
 report.checks.push('Wide/narrow textarea and confirmation; draft preserved on failure; explicit discard; deletion cancel/commit and final-item deletion');
 await button('Close settings').click();
 // First Send uses the local test gateway only.
 await command('searchMode',{sessionId:session,mode:'off'});await command('selectPartner',{sessionId:session,character:'model_04'});
 await composer.fill('Testing the first memory snapshot.');await button('Send').click();
 await button('Settings').click();await page.getByRole('tab',{name:'Memory',exact:true}).click();await page.getByText('Memory is in use by your current chat. Finish the chat to edit it.',{exact:true}).waitFor();
 await button('Back to chat').click();await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor({state:'hidden'});
 assert.equal((await command('memoryManagement')).blocker.sessionId,session);
 report.checks.push('Accepted Send locks memory and Back to chat targets the actual blocker');
 assert.deepEqual(report.errors,[]);report.mockRequests=mock.requests.length;report.status='passed';
} catch(error) {report.status='failed';report.error=String(error);if(page&&!page.isClosed())await capture('failure').catch(()=>undefined);throw error;}
finally {await app?.close().catch(()=>undefined);await new Promise(resolve=>mock.server.close(resolve));writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
