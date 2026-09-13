// Real renderer and styles with synthetic IPC; no Electron, DB or provider access.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const output = 'test-results/memory-pagination';
mkdirSync(output, {recursive:true});
writeFileSync(`${output}/index.html`, '<div id="root"></div><script type="module" src="./harness.tsx"></script>');
writeFileSync(`${output}/harness.tsx`, `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ColdMemories} from '/src/renderer/cold-memory';
import '/src/renderer/style.css';
const fixture = window.fixture = {delay:0, fail:false, requests:[], records:Array.from({length:53},(_,i)=>({id:String(i),text:'Older note '+(i+1)+': enjoys '+(i%2?'museums.':'coastal walks.'),time_basis:'unknown',text_hash:String(i)}))};
const listeners = new Set();
window.stomylos = {
 subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
 async command(name,args) {
  if(name === 'coldDelete') {fixture.records = fixture.records.filter(item=>item.id!==args.id); return;}
  if(name !== 'coldPage') throw Error('Unexpected command: '+name);
  fixture.requests.push({...args});
  const records=fixture.records.filter(item=>item.text.toLowerCase().includes(args.query.toLowerCase()));
  const delay=fixture.delay, fail=fixture.fail; fixture.fail=false;
  await new Promise(resolve=>setTimeout(resolve,delay));
  if(fail) throw Error('Could not load older memories.');
  return {items:records.slice(args.offset,args.offset+50),total:records.length,next:args.offset+50<records.length?args.offset+50:null,revision:1};
 }
};
const errorText = error => String(error.message ?? error);
createRoot(document.getElementById('root')).render(<div className="modal-overlay"><div className="dialog settings-dialog"><div className="dialog-heading"><h2>Settings</h2></div><div className="settings-layout"><div className="settings-tabs"><button>Voice</button><button aria-selected="true">Memory</button><button>Usage &amp; budget</button><button>Connection &amp; data</button></div><div className="settings-panel"><div className="memory-manager"><div className="memory-heading"><h3 className="settings-title">Memory</h3></div><ColdMemories locked={false} onBusy={()=>{}} errorText={errorText} ageSelector={<div className="memory-age-selector"><button>Recent <span className="memory-count">6</span></button><button aria-pressed="true">Older <span className="memory-count">53</span></button></div>} /></div></div></div></div></div>);
`);
const report = {status:'running', geometry:[], errors:[]};
let server, browser, page;
try {
  server = await createServer({configFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0},logLevel:'error'});
  await server.listen();
  browser = await chromium.launch({channel:'chrome',headless:true});
  page = await browser.newPage({viewport:{width:1180,height:860}});
  page.setDefaultTimeout(8000);
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${output}/index.html`);
  const button = name => page.getByRole('button',{name,exact:true});
  const bounds = expected => page.waitForFunction(value=>document.querySelector('.memory-page-range strong')?.textContent===value,expected);
  const ready = () => page.waitForFunction(()=>document.querySelector('.memory-items')?.getAttribute('aria-busy')==='false');
  const search = page.getByRole('searchbox');
  await bounds('1–50'); await ready();
  assert.equal(await button('Previous page').isDisabled(),true);
  await button('Next page').focus();
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  await page.getByRole('tooltip',{name:'Next page',exact:true}).waitFor();
  await page.evaluate(()=>window.fixture.delay=250);
  await page.keyboard.press('Enter');
  assert.equal(await button('Next page').isDisabled(),true);
  assert.equal(await page.locator('.memory-page-range strong').textContent(),'1–50');
  await bounds('51–53'); await ready();
  assert.equal(await page.locator('.memory-items>li').count(),3);
  assert.equal(await button('Next page').isDisabled(),true);
  assert.equal(await button('Previous page').evaluate(node=>node===document.activeElement),true);
  await page.evaluate(()=>{window.fixture.delay=0;window.fixture.fail=true;});
  await button('Previous page').click();
  await button('Retry loading older memories').waitFor();
  assert.equal(await page.locator('.memory-page-range strong').textContent(),'51–53');
  assert.equal(await page.locator('.memory-items>li').count(),3);
  await button('Retry loading older memories').click();
  await bounds('1–50'); await ready();
  assert.equal(await page.getByRole('alert').count(),0);
  for(const [width,height] of [[1180,860],[760,620]]) {
    await page.setViewportSize({width,height});
    await page.locator('.memory-pagination').scrollIntoViewIfNeeded();
    const geometry = await page.locator('.memory-pagination').evaluate(node=>{
      const panel=node.closest('.settings-panel'),range=node.querySelector('.memory-page-range').getBoundingClientRect(),buttons=node.querySelector('.memory-page-buttons').getBoundingClientRect(),arrow=node.querySelector('button').getBoundingClientRect();
      return {overflow:panel.scrollWidth>panel.clientWidth,centerDifference:Math.abs((range.top+range.bottom-buttons.top-buttons.bottom)/2),target:[arrow.width,arrow.height]};
    });
    assert.equal(geometry.overflow,false); assert.ok(geometry.centerDifference<1); assert.deepEqual(geometry.target,[32,30]);
    report.geometry.push({width,height,...geometry});
    await page.mouse.move(0,0);await page.screenshot({path:`${output}/footer-${width}.png`});
  }
  await search.fill('museums'); await ready();
  assert.equal(await page.locator('.memory-pagination').count(),0);
  assert.equal(await page.locator('.memory-items>li').count(),26);
  await search.fill('no matching records'); await ready();
  await page.getByText('No matching older memories.',{exact:true}).waitFor();
  assert.equal(await page.locator('.memory-pagination').count(),0);
  await button('Clear search').click(); await bounds('1–50'); await ready();
  // A slow search must not overwrite a later completed search.
  await page.evaluate(()=>window.fixture.delay=350);
  const before = await page.evaluate(()=>window.fixture.requests.length);
  await search.fill('museums');
  await page.waitForFunction(n=>window.fixture.requests.length>n,before);
  await page.evaluate(()=>window.fixture.delay=0);
  await search.fill('coastal'); await ready();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.memory-items>li').count(),27);
  assert.ok((await page.locator('.memory-items').innerText()).includes('coastal'));
  await button('Clear search').click(); await bounds('1–50'); await ready();
  await button('Next page').click(); await bounds('51–53'); await ready();
  for(let i=0;i<3;i++) {
    await button('Delete older memory').first().click();
    await page.locator('.memory-delete-confirmation').getByRole('button',{name:'Delete older memory',exact:true}).click();
    await ready();
  }
  await page.waitForFunction(()=>document.querySelectorAll('.memory-items>li').length===50 && !document.querySelector('.memory-pagination'));
  assert.equal(await page.evaluate(()=>window.fixture.records.length),50);
  assert.equal(await search.evaluate(node=>node===document.activeElement),true);
  assert.deepEqual(report.errors,[]);
  report.status='passed';
} catch(error) {
  report.status='failed';report.error=String(error);
  await page?.screenshot({path:`${output}/failure.png`}).catch(()=>{});
  throw error;
} finally {
  await browser?.close(); await server?.close();
  writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
