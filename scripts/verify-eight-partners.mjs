// Focused header/chooser acceptance with disposable data and loopback inference.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const directory=mkdtempSync('/tmp/stomylos-eight-partners-'), output='test-results/eight-partners';mkdirSync(output,{recursive:true});
const mock=await startMockGateway({delay:0});
const env={...process.env,STOMYLOS_DATA_DIR:directory,STOMYLOS_TEST_ENDPOINT:mock.endpoint};
for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY'])delete env[key];
const report={status:'running',paidRequests:0,checks:[],errors:[]};let app;
try {
 app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,chromiumSandbox:true});
 const page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));
 const command=(name,args)=>page.evaluate(([n,a])=>window.stomylos.command(n,a),[name,args]);
 const partner=page.locator('button.partner');await partner.waitFor();assert.equal(await partner.getAttribute('aria-label'),'Partner: Automatic');
 await partner.click();const options=page.locator('.partner-option');
 assert.deepEqual(await options.locator('strong').allTextContents(),['Automatic','Debate · Fable 5.1','Explain · Sonnet 5','Explore · MiMo V2.5 Pro','Chat · Astra','Share · Seed 2.1 Turbo','Prefer · DeepSeek V4 Pro 0813','Imagine · Gemini 3.8 Flash','Expand · DeepSeek V4.1 Flash']);
 await options.filter({hasText:'Expand ·'}).click();await page.getByRole('textbox',{name:'Your message',exact:true}).fill('I keep thinking of doors as beginnings.');await page.getByRole('button',{name:'Send',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('button.partner')?.getAttribute('aria-label')==='Partner: Expand · DeepSeek V4.1 Flash'&&!document.querySelector('button.partner')?.disabled);
 assert.equal(mock.requests.filter(r=>r.response_format?.json_schema?.name?.startsWith('stomylos_character_scores')).length,0);
 await partner.click();await options.filter({hasText:'Chat · Astra'}).click();assert.equal(await page.locator('.partner-pending').textContent(),'Next reply');
 assert.equal(await partner.getAttribute('aria-label'),'Partner: Chat · Astra');
 assert.ok(await page.locator('article[data-message-origin="model"]').count());
 report.checks.push('Exact chooser order, unresolved Auto, manual Expand without router and clearly pending next-reply label');
 for(const [width,height] of [[1180,860],[760,620]]){
  await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),[width,height]);
  await partner.click();await page.waitForFunction(()=>{const e=document.querySelector('.partner-menu')?.getBoundingClientRect();return e&&e.left>=0&&e.right<=innerWidth&&e.top>=0&&e.bottom<=innerHeight;});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({animations:'disabled',path:`${output}/${width}-chooser.png`});await page.keyboard.press('Escape');
 }
 report.checks.push('Wide/narrow chooser geometry and full accessible nickname/model identity');
 const snapshot=await command('snapshot');const sessionId=snapshot.sessions.find(s=>s.state!=='ended').id;
 await command('endSession',{sessionId});
 await page.locator('.current-partner').waitFor();assert.equal(await page.locator('.current-partner').textContent(),'Expand · DeepSeek V4.1 Flash');
 report.checks.push('Ended header retains the actual current Expand model instead of the unused pending Chat choice');
 assert.deepEqual(report.errors,[]);report.status='passed';
} catch(e){report.status='failed';report.errors.push(e.stack??String(e));process.exitCode=1;}
finally{if(app)await app.close();await new Promise(resolve=>mock.server.close(resolve));writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
