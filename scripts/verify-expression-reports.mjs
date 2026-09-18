// Actual Reports React/CSS with synthetic IPC; no normal DB, key or provider calls.
import {chromium} from 'playwright-core';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const output='test-results/expression-reports';mkdirSync(output,{recursive:true});
writeFileSync(`${output}/index.html`,'<div id="root"></div><script type="module" src="./harness.tsx"></script>');
writeFileSync(`${output}/harness.tsx`,`
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{Learning,usePatternState}from'/src/renderer/learning';import'/src/renderer/style.css';
const scope={count:2,records:3,from:'2026-09-11',to:'2026-09-18',estimate:6000,limit:922000,characters:24000,characterLimit:2000000,inputCost:.06};
const messages=[{id:'a',role:'assistant',content:'How is the garden going?'},{id:'u',role:'user',content:'I started working on the garden in May. I work on it now.'},{id:'u2',role:'user',content:'I started looking in June. The search is not finished.'}];
const suggestions=[{expression:'have been + -ing + since',explanation:'Connect an activity’s starting point with its continuation up to now.',example:"I have been working on the garden since May.",evidence_ids:['u','u2']},{expression:'rather than + -ing',explanation:'Contrast a preference with its alternative.',example:'I photograph the scenery rather than myself.',evidence_ids:['u']}];
const base={created_at:'2026-09-18T10:00:00Z',scope,status:'succeeded',selected_attempt_id:'a',last_attempt_id:'a',failure:null,cost:.13,canRetry:false,model:'openai/gpt-6-astra',reasoning:'low',attempts:[],sources:[{session_id:'s',ended_at:'2026-09-17',title:'The garden',units:messages.filter(m=>m.role==='user').map(m=>({message_id:m.id,original:m.content})),messages,deleted:false}]};
const fixture=window.fixture={mode:'success',over:false,delay:0,calls:[],records:[{...base,id:'expression',reportType:'expression',resultCount:2,suggestions},{...base,id:'grammar',reportType:'grammar'}],state:{revision:0,reportId:null,phase:'idle',startedAt:null,error:null}};
const listeners=new Set();let timer;function publish(s){fixture.state={...fixture.state,...s,revision:fixture.state.revision+1};listeners.forEach(fn=>fn({type:'pattern',snapshot:fixture.state}));}
window.stomylos={subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async command(name,args){fixture.calls.push({name,args});
 if(name==='patternState')return fixture.state;
 if(name==='patternList')return{reports:fixture.records.filter(r=>!args.reportType||r.reportType===args.reportType),hasMore:false};
 if(name==='patternDetail')return structuredClone(fixture.records.find(r=>r.id===args.id));
 if(name==='patternPreview'){const over=fixture.over,delay=fixture.delay;await new Promise(r=>setTimeout(r,delay));return{fingerprint:'a'.repeat(64),scope:{...scope,selection:args,characters:over?2180000:24000},blocked:over?'input_limit':null,existingId:null};}
 if(name==='patternCreate'||name==='patternRetry'){const id=name==='patternRetry'?args.id:'new-'+fixture.records.length;let r=fixture.records.find(r=>r.id===id);if(!r){r={...base,id,reportType:args.selection.reportType,selected_attempt_id:null,status:'dispatched',suggestions:undefined};fixture.records.unshift(r);}publish({reportId:id,phase:'generating',startedAt:new Date().toISOString()});timer=setTimeout(()=>{Object.assign(r,fixture.mode==='failed'?{status:'failed',failure:'request_timeout',canRetry:true}:{status:'succeeded',selected_attempt_id:'a',resultCount:fixture.mode==='empty'?0:2,suggestions:fixture.mode==='empty'?[]:suggestions,canRetry:false});publish({phase:'idle'});},400);return{id,reused:false};}
 if(name==='patternCancel'){clearTimeout(timer);Object.assign(fixture.records.find(r=>r.id===args.id),{status:'cancelled',failure:'request_cancelled',canRetry:true});publish({phase:'idle'});return;}
 if(name==='patternDelete'){fixture.records=fixture.records.filter(r=>r.id!==args.id);return;}
 if(name==='patternOpen')return;
 throw Error('Unexpected command '+name);
}};
function Harness(){const state=usePatternState(),[active,setActive]=useState(true),[source,setSource]=useState(null);return<div className="app"><header className="app-header">Stomylos</header><aside id="conversation-sidebar"><div className="library-tabs"><button onClick={()=>setActive(false)}>Chats</button><button onClick={()=>setActive(true)}>Reports</button></div><div id="report-history" hidden={!active}/></aside><div className="workspace"><Learning active={active} revision={0} state={state} disabled={false} keyPresent={true} requestedReport={null} handledReport={()=>{}} source={async(id,messageId)=>{setSource({id,messageId});setActive(false);fixture.source={id,messageId};}}/><div hidden={active}><button onClick={()=>setActive(true)}>Back to report</button><p>{source?.messageId}</p></div></div></div>};createRoot(document.getElementById('root')).render(<Harness/>);
`);
let server,browser;const report={status:'running',errors:[],checks:[]};
try{
 server=await createServer({configFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1180,height:860}});page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${output}/index.html`);
 const button=name=>page.getByRole('button',{name,exact:true});
 const capture=async name=>{for(const [width,height]of[[1180,860],[760,620]]){await page.setViewportSize({width,height});await page.screenshot({path:`${output}/${name}-${width}.png`});assert.equal(await page.locator('.reports-main').evaluate(e=>e.scrollWidth>e.clientWidth),false);assert.equal(await page.locator('.reports-main h1').evaluate(e=>getComputedStyle(e).fontSize),'22px');}await page.setViewportSize({width:1180,height:860});};
 await page.locator('.expression-item').first().waitFor();assert.equal(await page.locator('.expression-item').count(),2);
 await button('View your messages (2)').click();assert.equal(await page.locator('.expression-evidence').count(),2);
 await button('Show context').click();await page.getByText('How is the garden going?',{exact:true}).waitFor();
 await button('Open conversation ↗').first().click();assert.deepEqual(await page.evaluate(()=>window.fixture.source),{id:'s',messageId:'u'});await button('Back to report').click();await button('Hide your messages').waitFor();
 await page.getByLabel('Filter report type').selectOption('grammar');assert.equal(await page.locator('.report-history-item').count(),1);await page.locator('.report-history-item').click();await capture('grammar');await page.locator('.report-sources summary').click();await button('Details').click();await capture('grammar-details');await button('Details').click();await button('Open report').click();assert(await page.evaluate(()=>window.fixture.calls.some(c=>c.name==='patternOpen')));
 await page.getByLabel('Filter report type').selectOption('all');await page.waitForFunction(()=>document.querySelectorAll('.report-history-item').length===2);await page.locator('.report-history-item').first().click();await page.locator('.expression-item').first().waitFor();
 // Re-selecting the current report must not leave a permanent loading screen.
 await page.locator('.report-history-item').first().click();await page.locator('.expression-item').first().waitFor();
 await capture('report');
 await button('+ New report').click();await button('Create report').waitFor();await capture('new-report');await button('Custom dates').click();await page.getByLabel('From',{exact:true}).fill('2026-09-11');await page.getByLabel('Through',{exact:true}).fill('2026-09-18');await button('Create report').waitFor();await page.locator('.report-preview summary').click();await capture('new-report-custom');await page.getByLabel('From',{exact:true}).fill('2026-09-19');await page.getByLabel('Through',{exact:true}).fill('2026-09-18');assert.equal(await button('Create report').count(),0);
 await button('1 week').click();await button('Create report').waitFor();
 await page.evaluate(()=>window.fixture.over=true);await button('2 weeks').click();await page.getByText('This selection is too long. Choose a shorter period.',{exact:true}).waitFor();assert(await button('Create report').isDisabled());
 await page.evaluate(()=>{window.fixture.over=false;window.fixture.mode='empty';});await button('1 week').click();await button('Create report').click();await page.getByRole('heading',{name:'No useful suggestions in this report'}).waitFor();
 await button('+ New report').click();await page.evaluate(()=>window.fixture.mode='failed');await button('Create report').click();await button('Retry generation').waitFor();await page.evaluate(()=>window.fixture.mode='success');await button('Retry generation').click();await page.locator('.expression-item').first().waitFor();
 await button('+ New report').click();await button('Create report').click();await button('Cancel generation').click();await button('Retry generation').waitFor();
 await button('Details').click();await button('Delete report').click();await page.getByRole('dialog').getByRole('button',{name:'Delete report',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 // Older slow previews cannot enable creation for a newer oversized scope.
 await button('+ New report').click();await page.evaluate(()=>{window.fixture.delay=350;window.fixture.over=false;});await button('2 weeks').click();await page.evaluate(()=>{window.fixture.delay=0;window.fixture.over=true;});await button('3 weeks').click();await page.getByText('This selection is too long. Choose a shorter period.',{exact:true}).waitFor();await page.waitForTimeout(450);assert(await button('Create report').isDisabled());
 assert.deepEqual(report.errors,[]);report.status='passed';report.checks=['evidence/context/source return','type filter and grammar viewer','1180/760 expression, grammar, metadata and creation layouts','custom dates and input limit','empty success, failure/retry, cancel, deletion','stale preview rejected'];console.log(JSON.stringify(report));
}catch(e){report.status='failed';report.failure=String(e.stack??e);throw e;}finally{writeFileSync(`${output}/result.json`,JSON.stringify(report,null,2));await browser?.close();await server?.close();}
