// One full-app expression flow through the built worker and a loopback provider.
import {_electron as electron} from 'playwright-core';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {startMockGateway} from './mock-gateway.mjs';
const directory=mkdtempSync('/tmp/stomylos-expression-native-'),output='test-results/expression-native';mkdirSync(output,{recursive:true});
const result={status:'running',paidRequests:0,checks:[],errors:[]};
const mock=await startMockGateway({delay:0,repeat:3,patternHandler:async(body,response)=>{
 assert.equal(body.reasoning.effort,'low');assert.equal(body.response_format.json_schema.name,'grammatical_expression_suggestions');assert.equal(body.provider.only,undefined);
 const ids=[...body.messages[1].content.matchAll(/^([^ ]+) USER: /gm)].map(m=>m[1]);assert.equal(ids.length,2);assert.match(body.messages[1].content,/ASSISTANT:/);
 response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({model:body.model,provider:'Public mock',choices:[{message:{content:JSON.stringify({suggestions:[{expression:'have been + -ing + since',explanation:'Connect a past starting point with an activity continuing now.',example:'I have been working on this garden since May.',evidence_ids:ids}]})},finish_reason:'stop'}],usage:{cost:0.125}}));
}});
const env={...process.env,STOMYLOS_DATA_DIR:directory,STOMYLOS_TEST_ENDPOINT:mock.endpoint};for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY'])delete env[key];
let app,page;const command=(name,args)=>page.evaluate(([n,a])=>window.stomylos.command(n,a),[name,args]);const button=name=>page.getByRole('button',{name,exact:true});
async function wait(fn){const until=Date.now()+15000;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('local operation timeout');}
async function launch(){app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,chromiumSandbox:true});page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',e=>result.errors.push(e.message));await button('Settings').waitFor();}
try{
 await launch();const initial=await command('snapshot');await command('setMemoryPreference',{enabled:false,revision:initial.settings.memory.revision});
 const id=initial.unfinished?.id??await command('newSession');await command('selectPartner',{sessionId:id,character:initial.characters[0].id});await command('searchMode',{sessionId:id,mode:'off'});
 for(const [i,text]of['I started working on this garden in May. I still work on it.','I began looking in June. I am still looking now.'].entries()){await command('sendMessage',{sessionId:id,text,revision:i+1});await wait(async()=>(await command('snapshot')).activity.phase==='idle');}
 await command('endSession',{sessionId:id});await wait(async()=>!(await command('snapshot')).endBlocker);
 if(await button('Show history').count())await button('Show history').click();await button('Reports').click();await button('+ New report').click();await button('Create report').click();await page.locator('.expression-item').waitFor();
 const reports=await command('patternList',{offset:0,reportType:'expression'});assert.equal(reports.reports.length,1);assert.equal(reports.reports[0].cost,.125);const reportId=reports.reports[0].id;
 await button('View your messages (2)').click();await button('Show context').click();await page.locator('.expression-context').waitFor();
 const detail=await command('patternDetail',{id:reportId}),messageId=detail.suggestions[0].evidence_ids[0];await button('Open conversation ↗').first().click();
 const target=page.locator(`[data-message-id="${messageId}"]`);await target.waitFor();
 await wait(async()=>target.evaluate(n=>{const a=n.getBoundingClientRect(),b=n.closest('main').getBoundingClientRect();return a.top>=b.top-1&&a.bottom<=b.bottom+1;}));
 await button('← Back to report').click();await button('Hide your messages').waitFor();await page.screenshot({path:`${output}/report.png`});
 assert.equal(mock.requests.filter(r=>r.response_format?.json_schema?.name==='grammatical_expression_suggestions').length,1);
 await app.close();app=null;await launch();if(await button('Show history').count())await button('Show history').click();await button('Reports').click();await page.locator('.expression-item').waitFor();
 assert.equal(mock.requests.filter(r=>r.response_format?.json_schema?.name==='grammatical_expression_suggestions').length,1);assert.equal((await command('patternDetail',{id:reportId})).suggestions[0].evidence_ids.length,2);
 result.checks=['real IPC/worker/provider-policy/JSON persistence','two-message grouping and cost','source scroll and report return','restart without redispatch'];assert.deepEqual(result.errors,[]);result.status='passed';
}catch(e){result.status='failed';result.errors.push(e.stack);process.exitCode=1;}finally{if(app)await app.close();mock.server.closeAllConnections();await new Promise(r=>mock.server.close(r));writeFileSync(`${output}/result.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
