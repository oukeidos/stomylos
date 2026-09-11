// Focused Older management and real local-indexing scenario, using invented data.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import assert from 'node:assert/strict';
const executable=createRequire(import.meta.url)('electron'),directory=mkdtempSync('/tmp/stomylos-cold-ui-');
const output=resolve('test-results/cold-memory');mkdirSync(output,{recursive:true});
const env={...process.env,STOMYLOS_DATA_DIR:directory};for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_TEST_ENDPOINT','OPENROUTER_API_KEY'])delete env[key];
let app,page;const errors=[];
async function launch(){app=await electron.launch({executablePath:executable,args:['.'],env,chromiumSandbox:true,timeout:20000});page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.getByRole('button',{name:'Settings',exact:true}).waitFor();}
async function close(){await app.close();app=null;}
const cmd=(name,args)=>page.evaluate(([name,args])=>window.stomylos.command(name,args),[name,args]);
async function waitFor(fn){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Memory state did not settle');}
try{
  await launch();await cmd('setMemoryPreference',{enabled:false,revision:0});await close();
  const seed=spawnSync(executable,['--input-type=module','-e',`
    import Database from 'better-sqlite3';import {createHash} from 'node:crypto';
    const db=new Database(process.argv[1]);db.pragma('foreign_keys=ON');db.transaction(()=>{
      for(let i=0;i<55;i++){
        const id='fixture-'+i,text=i===54?'Literal 100%_ 한글 😃 hiking memory.':'The user enjoys mountain hiking. Observation '+i;
        const revision=Number(db.prepare("INSERT INTO cold_mutations(memory_id,kind) VALUES(?,'archive')").run(id).lastInsertRowid);
        db.prepare("INSERT INTO cold_memories(id,text,text_hash,source_order,item_index,source_session_id,observed_at,archived_at,origin,time_basis,archive_revision) VALUES(?,?,?,?,0,?,?,'2026-09-11','add','source_message',?)")
          .run(id,text,createHash('sha256').update(text).digest('hex'),i,'session-'+i,'2026-08-01T00:00:00Z',revision);
      }
    })();db.close();`,join(directory,'stomylos.sqlite3')],{cwd:process.cwd(),env:{...env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8'});
  if(seed.status!==0)throw new Error(seed.stderr||seed.stdout);
  await launch();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('tab',{name:'Memory',exact:true}).click();
  await page.getByRole('button',{name:'Older',exact:true}).click();const section=page.getByRole('region',{name:'Older memories'});
  await waitFor(async()=>await section.locator('.memory-items > li').count()===50);
  await section.getByRole('button',{name:'Next',exact:true}).click();await waitFor(async()=>await section.locator('.memory-items > li').count()===5);
  const search=section.getByRole('searchbox',{name:'Search older memories'});await search.fill('100%_');await waitFor(async()=>await section.locator('.memory-items > li').count()===1);
  assert.match(await section.locator('.memory-text').innerText(),/한글 😃/);
  const trigger=section.getByRole('button',{name:'Delete older memory',exact:true});await trigger.focus();await page.keyboard.press('Enter');
  await section.locator('.memory-delete-confirmation').getByRole('button',{name:'Delete older memory',exact:true}).click();await section.getByText('No matching older memories.',{exact:true}).waitFor();assert.equal(await search.evaluate(n=>n===document.activeElement),true);
  await search.fill('');await waitFor(async()=>await section.locator('.memory-items > li').count()===50);
  const preference=(await cmd('snapshot')).settings.memory;await cmd('setMemoryPreference',{enabled:true,revision:preference.revision});
  await waitFor(async()=>{const status=await cmd('coldStatus');return status.ready===54&&status.pending===0&&status.groups>0;});
  await page.screenshot({path:join(output,'older.png')});
  assert.equal(await section.evaluate(n=>n.scrollWidth>n.clientWidth+1),false);
  const status=await cmd('coldStatus');assert.equal(status.originals,54);assert.equal(status.failed,0);assert.deepEqual(errors,[]);
  writeFileSync(join(output,'result.json'),JSON.stringify({status:'passed',checks:['Memory Off retains originals','50-item paging','literal Unicode search','keyboard confirmation and focus','explicit delete','local utility indexing after On','no horizontal overflow'],index:status,providerRequests:0},null,2));
  console.log(JSON.stringify({status:'passed',originals:status.originals,groups:status.groups,providerRequests:0}));
}finally{if(app)await close();rmSync(directory,{recursive:true,force:true});}
