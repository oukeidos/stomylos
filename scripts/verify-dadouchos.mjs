// Actual React guide and composer styles; synthetic IPC, no model or user data.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const output='test-results/dadouchos';mkdirSync(output,{recursive:true});
writeFileSync(`${output}/index.html`,'<div id="root"></div><script type="module" src="./harness.tsx"></script>');
writeFileSync(`${output}/harness.tsx`,`
import React from 'react';import {createRoot} from 'react-dom/client';import '/src/renderer/style.css';
const listeners=new Set();const state={revision:0,sessionId:'s',open:false,phase:'idle',text:null,error:null};
const fixture=window.fixture={calls:0,fail:false,blocked:false,delay:100,emit(){state.revision++;listeners.forEach(f=>f({type:'dadouchos',snapshot:{...state}}));}};
window.stomylos={subscribe(f){listeners.add(f);return()=>listeners.delete(f);},async command(name,args){
 if(name==='dadouchosSnapshot')return {...state};
 if(name==='dadouchosDispose'){state.open=false;state.text=null;state.phase='idle';fixture.emit();return;}
 if(name==='dadouchosClose'){state.open=false;fixture.emit();return;}
 if(name==='dadouchosOpen'||name==='dadouchosRetry'){
  state.open=true;if(state.phase==='ready'&&name==='dadouchosOpen'){fixture.emit();return {...state};}
  fixture.calls++;state.phase='waiting';fixture.emit();setTimeout(()=>{state.phase=fixture.fail?'failed':'ready';state.error=fixture.fail?'request_timeout':null;state.text=fixture.fail?null:'Consider the space between those two feelings.';fixture.emit();},fixture.delay);return {...state};
 }throw Error('Unexpected IPC '+name);
}};
const {DadouchosDock,DadouchosButton}=await import('/src/renderer/dadouchos');
function Harness(){const [text,setText]=React.useState('');return <footer style={{marginTop:20}}><div className="composer"><div className="starter-dock">A retained conversation opener.</div><DadouchosDock sessionId="s" hidden={false} disabled={false}/><textarea aria-label="Your message" value={text} onChange={e=>setText(e.target.value)}/><div className="composer-actions"><DadouchosButton sessionId="s" disabled={false}/><button onClick={()=>{window.stomylos.command('dadouchosDispose',{sessionId:'s'});setText('');}}>Send</button></div></div></footer>;}
createRoot(document.getElementById('root')).render(<Harness/>);
`);
let server,browser,page;const report={status:'running',geometry:[],errors:[]};
try{
 server=await createServer({configFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();
 browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1180,height:860}});page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${output}/index.html`);
 const trigger=page.getByRole('button',{name:'Dadouchos',exact:true}),input=page.getByRole('textbox',{name:'Your message'}),guide=page.getByRole('region',{name:'Dadouchos guidance'});
 await trigger.click();await input.fill('I am still thinking.');await page.getByText('Consider the space between those two feelings.').waitFor();
 assert.equal(await input.inputValue(),'I am still thinking.');assert.equal(await input.evaluate(n=>n===document.activeElement),true);
 await page.keyboard.press('Escape');assert.equal(await guide.isVisible(),true);assert.equal(await guide.getByRole('button',{name:/close/i}).count(),0);
 await trigger.focus();await page.keyboard.press('Enter');await guide.waitFor({state:'hidden'});await page.keyboard.press('Space');await guide.waitFor();assert.equal(await page.evaluate(()=>window.fixture.calls),1);
 for(const [width,height] of [[1180,860],[760,620],[360,640]]){
  await page.setViewportSize({width,height});const geometry=await page.locator('.composer').evaluate(n=>({overflow:n.scrollWidth>n.clientWidth,guideAboveInput:n.querySelector('.dadouchos-dock').getBoundingClientRect().bottom<=n.querySelector('textarea').getBoundingClientRect().top}));report.geometry.push({width,...geometry});assert.equal(geometry.overflow,false);assert.equal(geometry.guideAboveInput,true);await page.screenshot({path:`${output}/${width}.png`});
 }
 await page.getByRole('button',{name:'Send',exact:true}).click();await guide.waitFor({state:'hidden'});assert.equal(await input.inputValue(),'');
 await page.evaluate(()=>window.fixture.fail=true);await trigger.click();await page.getByRole('alert').waitFor();await page.evaluate(()=>window.fixture.fail=false);await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByText('Consider the space between those two feelings.').waitFor();assert.equal(await page.evaluate(()=>window.fixture.calls),3);
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(e){report.status='failed';report.error=String(e);await page?.screenshot({path:`${output}/failure.png`}).catch(()=>{});throw e;}
finally{await browser?.close();await server?.close();writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
