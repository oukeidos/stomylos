// Packaged read/reopen of an isolated, externally converted database copy.
import { _electron as electron } from 'playwright-core';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const directory=process.argv[2];assert.ok(directory?.startsWith('/tmp/stomylos-pattern-'));
const executablePath=resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/pattern-candidate/linux-unpacked/stomylos');
const env={...process.env,STOMYLOS_DATA_DIR:directory};
for(const name of ['ELECTRON_RUN_AS_NODE','STOMYLOS_TEST_ENDPOINT','ELECTRON_RENDERER_URL','STOMYLOS_LIVE_VERIFY'])delete env[name];
const digest=value=>createHash('sha256').update(value).digest('hex');
const errors=[],passes=[];let app,firstHash;
try {
  for(let pass=0;pass<2;pass++) {
    app=await electron.launch({executablePath,env,chromiumSandbox:true,timeout:20000});
    const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
    await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
    const result=await page.evaluate(async()=>{
      const snap=await window.stomylos.command('snapshot');
      if(snap.settings.keyPresent)throw new Error('Copy validation must have no key');
      const sessions=[];
      for(let offset=0;;offset+=40) { const list=await window.stomylos.command('listSessions',{offset});sessions.push(...list.sessions);if(!list.hasMore)break; }
      const views=[];for(const session of sessions)views.push(await window.stomylos.command('loadSession',{sessionId:session.id}));
      return {views,settings:snap.settings,preview:await window.stomylos.command('patternPreview'),reports:await window.stomylos.command('patternList',{offset:0})};
    });
    assert.equal(result.settings.dataPath,directory);assert.equal(result.settings.appVersion,'0.12.0');
    const viewHash=digest(JSON.stringify(result.views));if(firstHash)assert.equal(viewHash,firstHash,'History changed between packaged opens');else firstHash=viewHash;
    assert.equal(result.reports.reports.length,0);
    await page.getByRole('button',{name:'Learning',exact:true}).click();await page.getByRole('heading',{name:'Recent conversations',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Create report',exact:true}).isDisabled(),true);
    passes.push({sessions:result.views.length,view_sha256:viewHash,eligible:result.preview.scope.count,blocked:result.preview.blocked,keyPresent:false});
    const exited=new Promise(r=>app.process().once('exit',r));await page.evaluate(()=>window.stomylos.command('close'));await exited;app=null;
  }
  assert.deepEqual(errors,[]);
  const archive=readdirSync(join(directory,'backups')).find(name=>name.startsWith('patterns-v7-'));
  const audit=JSON.parse(execFileSync('python3',['-c',`
import sqlite3,json,sys
old=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
new=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True)
assert old.execute('pragma user_version').fetchone()[0]==6
assert new.execute('pragma user_version').fetchone()[0]==7
assert new.execute('pragma integrity_check').fetchone()[0]=='ok'
assert not new.execute('pragma foreign_key_check').fetchall()
counts={}
for (table,) in old.execute("SELECT name FROM sqlite_master WHERE type='table'"):
 q='SELECT rowid,* FROM "'+table+'" ORDER BY rowid'
 before=old.execute(q).fetchall();after={r[0]:r for r in new.execute(q).fetchall()}
 for row in before:
  if after.get(row[0])!=row:raise RuntimeError('Original row changed in '+table)
 counts[table]=len(before)
for table in ['pattern_reports','pattern_report_sources','pattern_report_attempts']:
 assert new.execute('SELECT count(*) FROM '+table).fetchone()[0]==0
print(json.dumps({'status':'passed','originalRows':sum(counts.values()),'counts':counts,'integrity':'ok','foreignKeys':[],'reportBackfill':0}))
`,join(directory,'backups',archive,'before-v6.sqlite3'),join(directory,'stomylos.sqlite3')],{encoding:'utf8'}));
  const report={status:'passed',directory,executablePath,version:'0.12.0',passes,audit,errors,liveCalls:0,bundle_sha256:digest(readFileSync(resolve(executablePath,'../resources/app.asar')))};
  writeFileSync(join(directory,'package-open.json'),JSON.stringify(report,null,2),{mode:0o600});
  writeFileSync('test-results/pattern-copy-acceptance.json',JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({status:report.status,passes,audit,liveCalls:0}));
} catch(error) {console.error(error.message);throw new Error('Copy acceptance failed; no learner text was logged');}
finally {if(app)await app.evaluate(({app})=>app.exit());}
