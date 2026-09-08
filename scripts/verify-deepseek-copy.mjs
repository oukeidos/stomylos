// Read-only normal-data copy and packaged reopen checks. No private transcript is sent.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reportPath = 'test-results/deepseek-copy-acceptance.json';
assert(!existsSync(reportPath), 'Inspect existing copy evidence instead of replaying.');
const candidate = resolve('release/deepseek-candidate/linux-unpacked');
const directory = resolve('test-results/deepseek-normal-copy');
assert(!existsSync(directory)); mkdirSync(directory, { mode: 0o700 });
const inventory = String.raw`
import sqlite3,json,hashlib,sys
from pathlib import Path
def digest(v):return hashlib.sha256(json.dumps(v,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def inventory(file):
 c=sqlite3.connect('file:'+str(file)+'?mode=ro',uri=True)
 assert c.execute('pragma user_version').fetchone()[0]==9
 assert c.execute('pragma integrity_check').fetchone()[0]=='ok'
 assert not c.execute('pragma foreign_key_check').fetchall()
 out={'schema':digest(c.execute('select type,name,tbl_name,sql from sqlite_master order by type,name').fetchall()),'tables':{},'sessions':{}}
 for table, in c.execute("select name from sqlite_master where type='table' order by name"):
  rows=c.execute('select rowid,* from "'+table+'" order by rowid').fetchall();out['tables'][table]={'count':len(rows),'sha256':digest(rows)}
 for id,config in c.execute('select id,chat_config from sessions'):
  saved=json.loads(config)
  assert all(x['id']!='model_08' for x in saved['characters']), 'New model ID already assigned in saved history'
  out['sessions'][id]=digest(config)
 c.close();return out
`;
const prepared = JSON.parse(execFileSync('python3', ['-c', inventory + String.raw`
import fcntl,os
source=Path.home()/'.local/share/io.github.oukeidos.stomylos/stomylos.sqlite3'
fd=os.open(source.parent/'stomylos.lock',os.O_RDONLY|os.O_NOFOLLOW);fcntl.lockf(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
baseline=inventory(source);target=Path(sys.argv[1])/'stomylos.sqlite3'
c=sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True);d=sqlite3.connect(str(target));c.backup(d);d.close();c.close();os.chmod(target,0o600)
assert inventory(target)==baseline
print(json.dumps({'source':str(source),'copy':str(target),'baseline':baseline}))
os.close(fd)
`, directory], { encoding: 'utf8' }));
const env = { ...process.env, HOME: mkdtempSync('/tmp/stomylos-deepseek-copy-home-'), STOMYLOS_DATA_DIR: directory };
for (const k of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_TEST_ENDPOINT','STOMYLOS_PACKAGED_TEST','STOMYLOS_LIVE_VERIFY']) delete env[k];
let app; const errors = [], passes = [];
try {
 for (let pass=0; pass<2; pass++) {
  app = await electron.launch({ executablePath: join(candidate, 'stomylos'), env, chromiumSandbox: true });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name:'Settings', exact:true }).waitFor();
  const result = await page.evaluate(async ids => {
   const snapshot = await window.stomylos.command('snapshot');
   const views = await Promise.all(ids.map(sessionId => window.stomylos.command('loadSession', { sessionId })));
   const memories = views.map(v => JSON.stringify(v.memory.current));
   if (!memories.every(m => m===memories[0])) throw Error('Shared memory differs');
   return { version:snapshot.settings.appVersion, keyPresent:snapshot.settings.keyPresent, characters:snapshot.characters.map(c=>c.id), sessions:views.length, configs:views.map(v=>[v.session.id,v.session.chat_config]), memory:views[0]?.memory.current };
  }, Object.keys(prepared.baseline.sessions));
  assert.equal(result.version,'0.16.0'); assert.equal(result.keyPresent,false);
  assert.deepEqual(result.characters,['model_01','model_02','model_03','model_04','model_05','model_07','model_08']);
  assert.equal(result.memory.character_id,'shared');
  for (const [id,config] of result.configs) assert.equal(hash(JSON.stringify(config)),prepared.baseline.sessions[id]);
  delete result.configs; result.memoryItems=['traits','relationships','experiences','intentions'].reduce((n,c)=>n+result.memory[c].length,0); delete result.memory; passes.push(result);
  const exited=new Promise(r=>app.process().once('exit',r));await page.evaluate(()=>window.stomylos.command('close'));await exited;app=null;
  const after=JSON.parse(execFileSync('python3',['-c',inventory+'\nprint(json.dumps(inventory(sys.argv[1])))',prepared.copy],{encoding:'utf8'}));
  assert.deepEqual(after,prepared.baseline,'Packaged read/close changed copied rows');
 }
 assert.deepEqual(errors,[]);
 const report={status:'passed',...prepared,passes,errors,applicationSha256:hash(readFileSync(join(candidate,'resources/app.asar'))),inventoryCode:inventory,modelRequests:0,databaseMigration:false};
 writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:report.status,sessions:passes[0].sessions,rows:Object.values(prepared.baseline.tables).reduce((n,t)=>n+t.count,0),memoryItems:passes[0].memoryItems,opens:passes.length,modelRequests:0}));
}finally{await app?.close();}
