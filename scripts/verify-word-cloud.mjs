// Focused real Electron/React acceptance with disposable data and a local mock.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const directory=mkdtempSync('/tmp/stomylos-word-cloud-ui-'), output=resolve('test-results/word-cloud-flow');mkdirSync(output,{recursive:true});
const mock=await startMockGateway({chatHandler:async(input,response)=>{
 response.writeHead(200,{'content-type':'text/event-stream'});
 response.end(`data: ${JSON.stringify({model:input.model,provider:'Public mock',choices:[{delta:{content:'A quiet afternoon can leave room for a new thought.'},finish_reason:'stop'}],usage:{total_tokens:50,cost:0}})}\n\ndata: [DONE]\n\n`);
}});
const env={...process.env,STOMYLOS_DATA_DIR:directory,STOMYLOS_TEST_ENDPOINT:mock.endpoint};
for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY'])delete env[key];
let app,page;const report={status:'running',checks:[],geometry:[],errors:[],paidRequests:0};
const button=name=>page.getByRole('button',{name,exact:true});
const command=(name,args)=>page.evaluate(([n,a])=>window.stomylos.command(n,a),[name,args]);
const words=async()=>(await page.locator('.word-cloud-drift').allTextContents()).filter(Boolean);
const positions=()=>page.locator('.word-cloud-anchor').evaluateAll(nodes=>nodes.filter(n=>n.textContent&&Number(getComputedStyle(n).opacity)>0.05).map(n=>({word:n.textContent,cloud:n.dataset.cloud,x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y,opacity:Number(getComputedStyle(n).opacity)})));
async function launch(){
 app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,timeout:20000});
 app.process().stderr.on('data',chunk=>writeFileSync(resolve(output,'electron-stderr.log'),chunk,{flag:'a'}));
 app.process().on('exit',(code,signal)=>console.log(JSON.stringify({electronExit:code,signal})));
 page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));await page.locator('.composer textarea').waitFor();
}
async function close(){const exited=new Promise(r=>app.process().once('exit',r));await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await exited;app=null;}
async function geometry(label){
 const value=await page.locator('.word-cloud').evaluate(node=>{
  const box=node.getBoundingClientRect(), r=[...node.querySelectorAll('.word-cloud-drift')].filter(n=>n.textContent&&Number(getComputedStyle(n.closest('.word-cloud-anchor')).opacity)>0.05).map(n=>n.getBoundingClientRect());
  return {viewport:innerWidth,height:box.height,capacity:Number(node.dataset.capacity),count:r.length,contained:r.every(b=>b.left>=box.left&&b.right<=box.right&&b.top>=box.top&&b.bottom<=box.bottom),
   overlap:r.some((a,i)=>r.some((b,j)=>i<j&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)),
   interactive:node.querySelectorAll('button,a,input,[tabindex]').length,aria:node.getAttribute('aria-hidden'),
   styles:[...new Set([...node.querySelectorAll('.word-cloud-drift')].filter(n=>n.textContent).map(n=>parseFloat(getComputedStyle(n).fontSize)))],
   equalWeight:new Set([...node.querySelectorAll('.word-cloud-drift')].map(n=>{const s=getComputedStyle(n);return [s.fontWeight,s.color].join();})).size===1};
 });report.geometry.push({label,...value});assert(value.count>0&&value.count<=value.capacity);assert(value.capacity>0&&value.capacity<=48);assert.equal(value.contained,true);assert.equal(value.overlap,false);assert.equal(value.interactive,0);assert.equal(value.aria,'true');assert.equal(value.equalWeight,true);assert(value.styles.length>=3);assert(Math.max(...value.styles)/Math.min(...value.styles)>=1.5);
}
try{
 await launch();await page.locator('.word-cloud-anchor').first().waitFor({state:'attached'});assert((await words()).length>=10);assert(new Set((await positions()).map(p=>p.cloud)).size>=2);assert.equal(mock.requests.length,0);
 await page.clock.install();await page.reload();await page.locator('.word-cloud-anchor').first().waitFor({state:'attached'});
 const initial=await positions();await page.clock.runFor(8000);const moved=await positions();
 for(const before of initial){const after=moved.find(p=>p.word===before.word);if(after)assert(after.x>before.x);}
 assert(moved.some(p=>Math.abs(p.y-initial.find(i=>i.word===p.word)?.y)>1));
 report.checks.push('Multiple initial clouds, rightward flow and nonrigid shape change; zero provider calls');
 const input=page.locator('.composer textarea');await input.fill('My unsent thought');await input.dispatchEvent('compositionstart');await input.dispatchEvent('compositionend');await input.fill('');assert((await words()).length>0);
 await input.fill('A thought kept through restart');await page.clock.runFor(400);
 await button('Settings').click();await page.getByRole('tab',{name:'Appearance',exact:true}).click();
 const toggle=page.getByRole('switch',{name:'Show word cloud in new chats',exact:true});
 const frozen=await words(),frozenPositions=await positions();await page.clock.runFor(17000);assert.deepEqual(await words(),frozen);assert.deepEqual(await positions(),frozenPositions);
 await toggle.uncheck();await page.locator('.word-cloud').waitFor({state:'detached'});assert.equal((await command('snapshot')).settings.wordCloud,false);
 await toggle.check();await button('Close settings').click();await page.locator('.word-cloud').waitFor();
 const resumed=await positions();assert.deepEqual(await words(),frozen);await page.clock.runFor(1000);const resumedLater=await positions();assert(resumedLater.some(p=>p.x>resumed.find(i=>i.word===p.word)?.x));
 report.checks.push('Typing/IME/clear retention, exact modal pause/no catch-up and Settings Off/On');
 await close();await launch();await page.locator('.word-cloud').waitFor();assert.equal(await page.locator('.composer textarea').inputValue(),'A thought kept through restart');
 // Test the actual opener control and cache coexistence without introducing cloud hooks.
 await button('Give me something').click();await button('Hide opener').waitFor();assert((await words()).length>0);
 await button('Hide opener').click();await button('Show opener').waitFor();assert((await words()).length>0);
 // Voice IPC failure remains ordinary pre-submission state and cannot dismiss cues.
 await app.evaluate(({ipcMain})=>{const original=ipcMain._invokeHandlers.get('stomylos:command');ipcMain.removeHandler('stomylos:command');ipcMain.handle('stomylos:command',(e,n,a)=>n==='asrBegin'?{ok:false,error:'microphone_unavailable'}:original(e,n,a));});
 await page.keyboard.press('F8');await page.waitForTimeout(350);assert((await words()).length>0);
 report.checks.push('Unsent restart, opener generation/cache coexistence and failed voice-start retention');
 for(const [width,height] of [[1180,860],[760,620],[360,640]]){
  await page.setViewportSize({width,height});
  await page.waitForTimeout(100);await geometry(`${width}px`);assert.equal(report.geometry.at(-1).viewport,width);await page.screenshot({path:resolve(output,`${width}.png`)});
 }
 await page.evaluate(()=>document.querySelector('.word-cloud').style.fontSize='27px');
 await page.setViewportSize({width:760,height:620});await page.waitForTimeout(100);await geometry('enlarged 27px');
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(50);
 assert.equal(await page.locator('.word-cloud-drift').first().evaluate(n=>getComputedStyle(n).animationName),'none');
 const staticWords=await words(),staticPositions=await positions();await page.clock.install();await page.clock.runFor(17000);assert.deepEqual(await words(),staticWords);assert.deepEqual(await positions(),staticPositions);
 report.checks.push('Responsive geometry, enlarged text and static reduced-motion mode');
 await close();await launch();await page.clock.install();await page.reload();await page.locator('.word-cloud').waitFor();
 const snap=await command('snapshot'),id=snap.unfinished.id;await command('searchMode',{sessionId:id,mode:'off'});
 // Reject one send before commit, through the actual IPC boundary.
 await app.evaluate(({ipcMain})=>{const original=ipcMain._invokeHandlers.get('stomylos:command');let reject=true;ipcMain.removeHandler('stomylos:command');ipcMain.handle('stomylos:command',(e,n,a)=>{if(n==='sendMessage'&&reject){reject=false;return {ok:false,error:'draft_changed'};}return original(e,n,a);});});
 await page.locator('.composer textarea').fill('I want to talk about my afternoon.');await button('Send').click();await page.waitForTimeout(100);assert((await words()).length>0);
 const footer=await page.locator('.composer').boundingBox();
 // Advance the real RAF loop to an edge replacement, keeping cues display-only.
 const oldClouds=new Set((await positions()).map(p=>p.cloud));
 for(let i=0;i<25;i++){await page.clock.runFor(10000);if(i%5===0)console.log(`Flow clock: ${(i+1)*10}s`);}
 const successor=await positions();assert(successor.length>0);assert(successor.every(p=>!oldClouds.has(p.cloud)));
 await geometry('successor clouds after 250 seconds');await page.screenshot({path:resolve(output,'successors.png')});
 report.checks.push('New independent clouds continuously enter; initial clouds all depart and successor clouds remain after 250 seconds');
 await button('Send').click();await page.locator('.word-cloud.exiting').waitFor();
 assert.equal(await page.locator('.transcript .bubble.user').count(),1);
 assert.equal(await page.locator('.composer textarea').evaluate(n=>n===document.activeElement),true);
 const samples=[];for(let i=0;i<4;i++){samples.push(await page.locator('.word-cloud-slot').filter({hasText:/[a-z]/}).first().evaluate(n=>({opacity:Number(getComputedStyle(n).opacity),transform:getComputedStyle(n).transform})));await page.waitForTimeout(180);}
 assert(samples[3].opacity<samples[0].opacity);assert.notEqual(samples[0].transform,samples[3].transform);
 await page.screenshot({path:resolve(output,'exit.png')});await page.locator('.word-cloud').waitFor({state:'detached'});
 assert.equal((await page.locator('.composer').boundingBox()).y,footer.y);
 report.checks.push('Rejected Send retains cues; committed Send exits once with decreasing opacity/outward motion, continuous flow position, immediate message and fixed composer');
 await close();await launch();assert.equal(await page.locator('.word-cloud').count(),0);
 await button('Settings').click();await page.getByRole('tab',{name:'Appearance',exact:true}).click();await page.getByRole('switch',{name:'Show word cloud in new chats'}).uncheck();await button('Close settings').click();await close();await launch();assert.equal((await command('snapshot')).settings.wordCloud,false);assert.equal(await page.locator('.word-cloud').count(),0);
 report.checks.push('Started-chat restart never replays exit; visibility preference survives restart');
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.error=String(error);report.status='failed';await page?.screenshot({path:resolve(output,'failure.png')}).catch(()=>{});throw error;}
finally{if(app)await app.close();await new Promise(r=>mock.server.close(r));writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
