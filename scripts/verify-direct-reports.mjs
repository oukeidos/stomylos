// Focused source integration check. Synthetic local input and mock responses only.
import {_electron as electron} from 'playwright-core';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {startMockGateway} from './mock-gateway.mjs';
const directory=mkdtempSync('/tmp/stomylos-direct-reports-'),output='test-results/direct-reports';mkdirSync(output,{recursive:true});
const result={status:'running',paidRequests:0,checks:[],errors:[]};
const mock=await startMockGateway({delay:0,patternHandler:async(body,response)=>{
  assert.equal(body.max_tokens,128000);assert.match(body.messages[1].content,/S1-1: /);
  response.writeHead(200,{'Content-Type':'application/json'});
  response.end(JSON.stringify({model:body.model,provider:'OpenAI',choices:[{message:{content:'<!DOCTYPE html><html><head><title>Mock report</title></head><body><h1>Practice report</h1></body></html>'},finish_reason:'stop'}],usage:{cost:0.125}}));
}});
const env={...process.env,STOMYLOS_DATA_DIR:directory,STOMYLOS_TEST_ENDPOINT:mock.endpoint};
for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY'])delete env[key];
let app,page;
const command=(name,args)=>page.evaluate(([n,a])=>window.stomylos.command(n,a),[name,args]);
const button=name=>page.getByRole('button',{name,exact:true});
async function wait(fn){const until=Date.now()+15000;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('mock operation timeout');}
try{
  app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,chromiumSandbox:true});
  page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',e=>result.errors.push(e.message));await button('Settings').waitFor();
  const ids=[];
  for(let i=0;i<5;i++){
    const snap=await command('snapshot'),id=snap.unfinished?.id??await command('newSession');ids.push(id);
    await command('selectPartner',{sessionId:id,character:'model_04'});await command('searchMode',{sessionId:id,mode:'off'});
    await command('sendMessage',{sessionId:id,text:'I enjoy visiting quiet museums.',revision:1});
    await wait(async()=> (await command('snapshot')).activity.phase==='idle');
    await command('endSession',{sessionId:id});await wait(async()=>!(await command('snapshot')).endBlocker);
    assert.equal((await command('loadSession',{sessionId:id})).session.analysis_state,'none');
  }
  const grammarCalls=()=>mock.requests.filter(r=>r.model==='openai/gpt-5.6-terra'&&r.response_format?.json_schema?.name?.includes('grammar')).length;
  assert.equal(grammarCalls(),0);result.checks.push('Five sessions end without grammar requests or grammar blockers');
  await command('loadSession',{sessionId:ids[4]});
  // Select the last ended conversation through history to bind the details UI.
  if (await button('Show history').count()) await button('Show history').click();
  await page.locator('.history-item').first().click();
  await button('Conversation details').click();
  const details=page.getByRole('dialog',{name:'Conversation details',exact:true});
  await details.getByText('Grammar analysis',{exact:true}).click();
  await details.getByRole('button',{name:'Analyze this conversation',exact:true}).focus();await page.keyboard.press('Enter');
  await wait(async()=> (await command('loadSession',{sessionId:ids[4]})).session.analysis_state==='completed');
  assert.equal(await details.getByRole('button',{name:'Analyze this conversation',exact:true}).count(),0);
  await details.evaluate(n=>n.scrollTop=0);await page.screenshot({path:output+'/grammar-details.png'});await page.keyboard.press('Escape');
  assert.equal(await button('Analyze this conversation').count(),0);assert.equal(await page.getByRole('button',{name:/Analysis details/}).count(),0);
  result.checks.push('Grammar is started in Conversation details only; stored success has no regeneration action');
  await button('Reports').click();const scope=page.getByRole('region',{name:'Report scope'});
  assert.equal(await button('1 week').getAttribute('aria-pressed'),'true');
  for(const value of ['2','3','4','1']){await button(value+' '+(value==='1'?'week':'weeks')).click();await wait(async()=>await scope.locator('.scope-number').count()>0);}
  const exclude=page.getByRole('checkbox',{name:'Exclude conversations already included in a report'});assert.equal(await exclude.isChecked(),false);
  await button('Create report').click();await wait(async()=> (await command('patternState')).phase==='idle');
  await button('View existing report').waitFor();const reports=mock.requests.filter(r=>r.model==='openai/gpt-6-astra'&&!r.stream);assert.equal(reports.length,1);
  await button('View existing report').focus();await page.keyboard.press('Enter');assert.equal(mock.requests.filter(r=>r.model==='openai/gpt-6-astra'&&!r.stream).length,1);await command('patternClose');
  await exclude.check();await wait(async()=> (await scope.locator('.scope-number').innerText()).startsWith('0 '));
  assert.equal(await button('Create report').isDisabled(),true);await exclude.uncheck();await button('View existing report').waitFor();
  for(const width of [1180,760]){await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setContentSize(w,820),width);await page.screenshot({path:`${output}/reports-${width}.png`});assert.equal(await scope.evaluate(n=>n.scrollWidth>n.clientWidth),false);assert.equal(await page.locator('.learning').evaluate(n=>n.scrollWidth>n.clientWidth),false,'report container overflows');}
  await button('Custom dates').click();await page.getByLabel('From',{exact:true}).fill('2020-01-01');await page.getByLabel('Through',{exact:true}).fill('2030-01-01');await button('View existing report').waitFor();
  await page.screenshot({path:output+'/custom-dates.png'});assert.equal(await page.locator('.learning').evaluate(n=>n.scrollWidth>n.clientWidth),false);
  result.checks.push('Week presets/default/custom dates, scope and input cost, exclusion and existing-report reuse work with one report call');
  assert.deepEqual(result.errors,[]);result.status='passed';
}catch(e){result.status='failed';result.errors.push(e.stack);process.exitCode=1;}
finally{if(app)await app.close();mock.server.closeAllConnections();await new Promise(r=>mock.server.close(r));writeFileSync(output+'/report.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
