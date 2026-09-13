// Focused isolated UI acceptance; no normal data or provider calls.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const directory=mkdtempSync('/tmp/stomylos-opener-ui-'), output=resolve('test-results/opener');mkdirSync(output,{recursive:true});
const text='I tried making bread today. It came out very flat, but it still tasted good.';
const mock=await startMockGateway({chatHandler:async(input,response)=>{
  await new Promise(resolve=>setTimeout(resolve,450));
  response.writeHead(200,{'content-type':'text/event-stream'});
  response.end(`data: ${JSON.stringify({model:input.model,provider:'Public mock',choices:[{delta:{content:text},finish_reason:'stop'}],usage:{total_tokens:50,cost:0}})}\n\ndata: [DONE]\n\n`);
}});
const env={...process.env,STOMYLOS_DATA_DIR:directory,STOMYLOS_TEST_ENDPOINT:mock.endpoint};
for(const k of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY'])delete env[k];
let app,page;const errors=[],checks=[];
const button=name=>page.getByRole('button',{name,exact:true});
const command=(name,args)=>page.evaluate(([n,a])=>window.stomylos.command(n,a),[name,args]);
async function launch(){app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,timeout:20000});page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.locator('.composer textarea').waitFor();}
async function close(){const exited=new Promise(r=>app.process().once('exit',r));await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await exited;app=null;}
try{
  await launch();await button('Give me something').waitFor();assert.equal(mock.requests.length,0);checks.push('Fresh draft Off, zero calls');
  await button('Give me something').click();await button('Thinking…').waitFor();assert.equal(await button('Thinking…').isEnabled(),false);
  await page.locator('.composer textarea').fill('My unsent words');
  await button('Hide opener').waitFor();assert.equal(mock.requests.length,1);assert.equal(await page.locator('.composer textarea').inputValue(),'My unsent words');
  assert.equal(await page.locator('.bubble').getByText(text,{exact:true}).count(),1);assert.equal(await button('Another question').count(),0);checks.push('Explicit generation, editable draft, original display, no regeneration');
  await page.screenshot({path:resolve(output,'visible.png')});
  await button('Hide opener').click();await button('Show opener').waitFor();assert.equal(await page.locator('.bubble').getByText(text,{exact:true}).count(),0);
  await close();await launch();await button('Show opener').waitFor();assert.equal(mock.requests.length,1);
  await button('Show opener').click();await button('Hide opener').waitFor();assert.equal(await page.locator('.bubble').getByText(text,{exact:true}).count(),1);assert.equal(mock.requests.length,1);checks.push('Hide/restart/show uses identical cached result without inference');
  await button('Hide opener').click();
  const snap=await command('snapshot');const id=snap.unfinished.id;
  await command('searchMode',{sessionId:id,mode:'off'});
  await page.locator('.composer textarea').fill('My own topic');await button('Send').click();
  await page.waitForFunction(()=>!document.querySelector('.opening-action'));
  assert.equal(await button('Give me something').count(),0);checks.push('First Send removes opener control');
  assert.deepEqual(errors,[]);
  writeFileSync(resolve(output,'report.json'),JSON.stringify({status:'passed',directory,checks,errors,paidRequests:0},null,2));
  console.log(JSON.stringify({status:'passed',checks}));
}catch(error){console.error(JSON.stringify(await command('snapshot')));console.error(JSON.stringify(mock.requests));throw error;}finally{if(app)await app.close();await new Promise(r=>mock.server.close(r));}
