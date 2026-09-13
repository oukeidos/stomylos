// Focused isolated Settings memory UI check; no conversation or provider requests.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const directory=mkdtempSync('/tmp/stomylos-memory-layout-');
const output='test-results/memory-layout';mkdirSync(output,{recursive:true});
const mock=await startMockGateway();
const env={...process.env,STOMYLOS_DATA_DIR:directory,STOMYLOS_TEST_ENDPOINT:mock.endpoint};
for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY'])delete env[key];
const report={status:'running',geometry:[],errors:[]};let app,page;
const button=name=>page.getByRole('button',{name,exact:true});
const command=(name,args)=>page.evaluate(([name,args])=>window.stomylos.command(name,args),[name,args]);
try {
  app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],env,chromiumSandbox:true,timeout:20000});
  page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));await button('Settings').waitFor();
  const initial=await command('snapshot');await command('setMemoryPreference',{enabled:false,revision:initial.settings.memory.revision});
  await app.evaluate(({app},directory)=>{
    const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json');
    const db=new (require('better-sqlite3'))(directory+'/stomylos.sqlite3');
    const hash=text=>require('node:crypto').createHash('sha256').update(text).digest('hex');
    db.transaction(()=>{
      const records=Array.from({length:6},(_,i)=>({id:'hot-'+i,text:`Recent note ${i+1}: enjoys quiet walks and books.`}));
      const document=JSON.stringify({character_id:'shared',revision:0,database_records:records});
      db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(document,hash(document));
      records.forEach((item,i)=>db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin) VALUES(?,?,?,'legacy')").run(item.id,100+Math.floor(i/2),i%2));
      for(let i=0;i<55;i++){
        const id='cold-'+i,text=`Older note ${i+1}: remembers a ${i%2?'museum':'coastal'} visit.`;
        const revision=Number(db.prepare("INSERT INTO cold_mutations(memory_id,kind) VALUES(?,'archive')").run(id).lastInsertRowid);
        db.prepare("INSERT INTO cold_memories(id,text,text_hash,source_order,item_index,archived_at,origin,time_basis,archive_revision) VALUES(?,?,?,?,?,?,'legacy','unknown',?)")
          .run(id,text,hash(text),i,0,'2026-09-13T00:00:00Z',revision);
      }
    })();db.close();
  },directory);
  await button('Settings').click();await page.getByRole('tab',{name:'Memory',exact:true}).click();await button('Recent 6').waitFor();await button('Older 55').waitFor();
  assert.equal(await button('Memory needs attention').count(),0);
  for(const [width,height] of [[1180,860],[760,620]]){
    await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),[width,height]);
    for(const age of ['Recent 6','Older 55']){
      await button(age).click();await page.locator('.memory-items>li').first().waitFor();
      await page.locator('.settings-panel:not([hidden])').evaluate(n=>n.scrollTop=0);
      const geometry=await page.locator('.memory-manager').evaluate(root=>{
        const selector=root.querySelector('.memory-age-selector').getBoundingClientRect(),search=root.querySelector('input[type=search]').getBoundingClientRect();
        return {overflow:root.scrollWidth>root.clientWidth,selector:{top:selector.top,bottom:selector.bottom},search:{top:search.top,bottom:search.bottom}};
      });
      assert.equal(geometry.overflow,false);assert.ok(Math.abs((geometry.selector.top+geometry.selector.bottom)-(geometry.search.top+geometry.search.bottom))<2);
      report.geometry.push({width,height,age,...geometry});
      await page.screenshot({path:`${output}/${age.startsWith('Recent')?'recent':'older'}-${width}.png`});
    }
  }
  for (let i=0;i<report.geometry.length;i+=2) assert.equal(report.geometry[i].selector.top,report.geometry[i+1].selector.top);
  assert.equal(await button('Edit').count(),0);
  assert.equal(await page.getByText(/ready groups|\d+ pending|\d+ failed|Older notes are preserved/).count(),0);
  await button('Next').click();await page.waitForFunction(()=>document.querySelectorAll('.memory-items>li').length===5);
  const search=page.getByRole('searchbox',{name:'Search older memories'});await search.fill('coastal');
  await page.waitForFunction(()=>document.querySelectorAll('.memory-items>li').length===28);
  assert.equal(await button('Next').count(),0);
  await button('Delete older memory').first().click();await button('Cancel').click();
  await button('Delete older memory').first().click();await page.locator('.memory-delete-confirmation').getByRole('button',{name:'Delete older memory',exact:true}).click();
  await button('Older 54').waitFor();await button('Clear search').click();
  await button('About memory').click();await page.getByText('Memory saves notes for future chats',{exact:false}).waitFor();
  assert.equal(await page.getByText('Oldest notes are removed',{exact:false}).count(),0);
  await page.getByText('Storage',{exact:true}).click();await page.getByText('54 older notes · 0 groups',{exact:true}).waitFor();
  await page.screenshot({path:`${output}/about.png`});
  await page.keyboard.press('Escape');assert.equal(await button('About memory').getAttribute('aria-expanded'),'false');
  await button('Recent 6').click();await button('Edit').first().click();
  await page.getByRole('textbox',{name:'Edit memory'}).fill('Changed draft');await button('Older 54').click();
  await page.getByRole('dialog',{name:'Discard memory changes?'}).waitFor();await button('Keep editing').click();
  assert.equal(await page.getByRole('textbox',{name:'Edit memory'}).inputValue(),'Changed draft');await button('Cancel').click();
  await app.evaluate(({app},directory)=>{
    const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json'),db=new (require('better-sqlite3'))(directory+'/stomylos.sqlite3');
    db.prepare("INSERT OR REPLACE INTO cold_embeddings(memory_id,space_id,source_hash,state,attempts,failure) SELECT c.id,s.id,c.text_hash,'failed',1,'fixture_failure' FROM cold_memories c CROSS JOIN embedding_spaces s LIMIT 1").run();db.close();
  },directory);
  // Reenter Settings to refresh both lists' shared status without a model run.
  await page.keyboard.press('Escape');await button('Settings').click();await page.getByRole('tab',{name:'Memory',exact:true}).click();
  await button('Memory needs attention').waitFor();await button('Memory needs attention').click();
  await page.getByText('Some notes are not ready for recall.',{exact:false}).waitFor();
  assert.equal(await button('Retry local indexing').isDisabled(),true);
  await page.screenshot({path:`${output}/attention.png`});
  assert.equal(mock.requests.length,0);assert.deepEqual(report.errors,[]);report.status='passed';
} catch(error) { report.status='failed';report.error=String(error);if(page&&!page.isClosed())await page.screenshot({path:`${output}/failure.png`}).catch(()=>undefined);throw error; }
finally { await app?.close().catch(()=>undefined);await new Promise(resolve=>mock.server.close(resolve));writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2));rmSync(directory,{recursive:true,force:true});console.log(JSON.stringify(report)); }
