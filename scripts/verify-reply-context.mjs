// Focused Lighter replies UX verification with disposable data and a local mock.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const directory=mkdtempSync('/tmp/stomylos-reply-ui-'), output='test-results/reply-context';mkdirSync(output,{recursive:true});
const report={status:'running',paidRequests:0,checks:[],errors:[]};
let failReply=true;
const mock=await startMockGateway({chatHandler:async(input,response)=>{
 if(failReply){response.writeHead(429);response.end('{}');return;}
 response.writeHead(200,{'content-type':'text/event-stream'});
 response.end(`data: ${JSON.stringify({model:input.model,provider:'Public mock',choices:[{delta:{content:'A familiar song can feel comforting. Which one do you keep returning to?'},finish_reason:'stop'}],usage:{total_tokens:30,cost:0}})}\n\ndata: [DONE]\n\n`);
}});
const env={...process.env,STOMYLOS_DATA_DIR:directory,STOMYLOS_TEST_ENDPOINT:mock.endpoint};
for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY'])delete env[key];
let app,page;
const command=(name,args)=>page.evaluate(([name,args])=>window.stomylos.command(name,args),[name,args]);
const button=name=>page.getByRole('button',{name,exact:true});
async function wait(fn){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out');}
async function launch(){app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,chromiumSandbox:true});page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));await button('Settings').waitFor();}
try{
 await launch();const initial=await command('snapshot');const id=initial.unfinished.id;
 await command('setMemoryPreference',{enabled:false,revision:initial.settings.memory.revision});
 const feather=button('Lighter replies');await feather.waitFor();assert.equal(await feather.getAttribute('aria-pressed'),'true');
 await feather.focus();await page.getByRole('tooltip').filter({hasText:'Encourages shorter replies'}).waitFor({state:'visible'});
 await page.screenshot({path:`${output}/before-send.png`});
 await app.evaluate(({ipcMain})=>{
   const original=ipcMain._invokeHandlers.get('stomylos:command');let attempts=0;
   ipcMain.removeHandler('stomylos:command');
   ipcMain.handle('stomylos:command',async(event,name,args)=>{
     if(name==='setReplyContext') {
       attempts++;if(attempts===1)return {ok:false,error:'reply_context_changed'};
       if(attempts===2)await new Promise(resolve=>setTimeout(resolve,1000));
     }
     return original(event,name,args);
   });
 });
 await page.getByRole('textbox',{name:'Your message'}).fill('Preserve this draft.');
 await feather.focus();await page.keyboard.press('Space');
 await page.getByRole('alert').filter({hasText:'Couldn’t save.'}).waitFor();
 assert.equal(await feather.getAttribute('aria-pressed'),'true');assert.equal(await button('Send').isDisabled(),true);
 await page.getByRole('alert').getByRole('button',{name:'Retry',exact:true}).click();
 await wait(async()=>await feather.getAttribute('aria-busy')==='true');
 assert.equal(await feather.isDisabled(),true);assert.equal(await button('Send').isDisabled(),true);
 await wait(async()=>await feather.getAttribute('aria-pressed')==='false');
 assert.equal(await page.getByRole('textbox',{name:'Your message'}).inputValue(),'Preserve this draft.');
 assert.equal((await command('loadSession',{sessionId:id})).messages.filter(m=>m.origin==='learner').length,0);
 let view=await command('loadSession',{sessionId:id});assert.equal(view.replyContext.mode,'standard');
 await command('setOpening',{sessionId:id,operationId:'direct',expectedRevision:view.session.opening_revision,kind:'user'});
 await wait(async()=>await page.getByRole('textbox',{name:'Your message'}).getAttribute('placeholder')==="What's on your mind?");
 await feather.click();await wait(async()=>await feather.getAttribute('aria-pressed')==='true');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(760,620));
 assert.equal(await page.locator('.composer-actions').evaluate(n=>n.scrollWidth>n.clientWidth),false);
 await page.screenshot({path:`${output}/narrow.png`});
 await command('selectPartner',{sessionId:id,character:'model_04'});await command('searchMode',{sessionId:id,mode:'off'});
 await page.getByRole('textbox',{name:'Your message'}).fill('I keep listening to the same songs.');
 await page.keyboard.press('Enter');await feather.waitFor({state:'detached'});
 await wait(async()=>(await command('snapshot')).activity.phase==='idle');
 view=await command('loadSession',{sessionId:id});assert.equal(view.replyContext.canChange,false);
 assert.equal(view.requests.filter(r=>r.role==='chat').at(-1).status,'failed');
 await button('Conversation details').click();await page.getByText('Reply style: Lighter',{exact:true}).waitFor();
 await page.screenshot({path:`${output}/details.png`});await page.keyboard.press('Escape');
 await app.close();await launch();await wait(async()=>!!(await command('loadSession',{sessionId:id})).replyContext);
 assert.equal(await button('Lighter replies').count(),0);failReply=false;
 await button('Retry reply').click();await wait(async()=>(await command('snapshot')).activity.phase==='idle' && (await command('loadSession',{sessionId:id})).messages.at(-1).delivery==='complete');
 assert.equal(await button('Lighter replies').count(),0);
 const bodies=mock.requests.filter(b=>b.stream && !b.response_format);
 assert.ok(bodies.length>=2);for(const body of bodies)assert.equal(body.messages.filter(m=>m.content.includes('What are your values?')).length,1);
 await page.screenshot({path:`${output}/after-send.png`});
 report.checks.push('Default On, keyboard-toggle and focus tooltip; save failure preserves confirmed state/draft; delayed save locks Send; Retry saves only the choice','Starter/direct choice preserved; narrow composer fits','First commit removes icon even after provider 429; details shows only Lighter property','Restart and explicit reply retry preserve lock and exactly one seed prefix');
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.errors.push(error.stack);process.exitCode=1;}
finally{if(app)await app.close();mock.server.closeAllConnections();await new Promise(r=>mock.server.close(r));writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.status==='passed')rmSync(directory,{recursive:true,force:true});}
