// Deliver the verified DeepSeek bundle; preserve the normal v9 database and all saved contracts.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative } from 'node:path';
import { extractFile } from '@electron/asar';
import { _electron as electron } from 'playwright-core';
const read=p=>JSON.parse(readFileSync(p,'utf8')), hash=b=>createHash('sha256').update(b).digest('hex');
const reportPath='test-results/deepseek-delivery.json';
assert(!existsSync(reportPath),'Inspect existing delivery before any replay.');
const copy=read('test-results/deepseek-copy-acceptance.json'), live=read('test-results/deepseek-live-20260907-v1/quality-review.json');
assert.equal(copy.status,'passed');assert.equal(live.status,'accepted_with_response_style_limit');
for(const path of ['test-results/seven-models-native/report.json','test-results/seven-models-packaged/report.json','test-results/deepseek-package-report.json','test-results/install-report.json'])assert.equal(read(path).status,'passed');
const gate=read('test-results/deepseek-live-20260907-v1/gate.json');
for(const [path,h] of Object.entries(gate.hashes))assert.equal(hash(readFileSync(path)),h,path);
const candidate=resolve('release/deepseek-candidate/linux-unpacked'), active=resolve('release/linux-unpacked'), asar=join(candidate,'resources/app.asar');
assert(!existsSync('stomylos'),'Unexpected launcher override');
assert.equal(hash(readFileSync(asar)),copy.applicationSha256);
assert.equal(JSON.parse(extractFile(asar,'package.json')).version,'0.16.0');
assert.equal(JSON.parse(extractFile(join(active,'resources/app.asar'),'package.json')).version,'0.15.0');
function verifyOut(dir){for(const name of readdirSync(dir)){const path=join(dir,name);if(statSync(path).isDirectory())verifyOut(path);else assert.equal(hash(extractFile(asar,relative(process.cwd(),path))),hash(readFileSync(path)),path);}}
verifyOut(resolve('out'));
assert.equal(hash(readFileSync('README.md')),hash(readFileSync(join(candidate,'README.md'))));
const archive=read('test-results/release-audit.json');assert.equal(archive.version,'0.16.0');assert.equal(hash(readFileSync(archive.archive)),archive.sha256);assert.equal(read('test-results/install-report.json').archiveSha256,archive.sha256);
if(!process.argv.includes('--deliver')){console.log(JSON.stringify({status:'ready',version:'0.16.0',databaseMigration:false,applicationSha256:copy.applicationSha256}));process.exit(0);}
const code=copy.inventoryCode+String.raw`
import os,fcntl,shutil,uuid
root=Path.cwd();acceptance=json.loads((root/'test-results/deepseek-copy-acceptance.json').read_text());source=Path(acceptance['source']);data=source.parent
fd=os.open(data/'stomylos.lock',os.O_RDWR|os.O_NOFOLLOW);fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
assert inventory(source)==acceptance['baseline'],'Normal data changed since accepted copy'
candidate=root/'release/deepseek-candidate/linux-unpacked';active=root/'release/linux-unpacked'
def sha(file):return hashlib.sha256(file.read_bytes()).hexdigest()
def files(folder):
 result={}
 for p in sorted(folder.rglob('*')):
  assert not p.is_symlink(),'Unexpected bundle symlink'
  if p.is_file():result[str(p.relative_to(folder))]=sha(p)
 return result
selected=files(candidate);prior=files(active);ident=str(uuid.uuid4());backup=data/'backups'/('deepseek-0.16.0-'+ident);backup.mkdir(mode=0o700)
c=sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True);d=sqlite3.connect(str(backup/'stomylos.sqlite3'));c.backup(d);d.close();c.close();os.chmod(backup/'stomylos.sqlite3',0o600)
assert inventory(backup/'stomylos.sqlite3')==acceptance['baseline']
for name in ['preferences.json','asr','speech']:
 p=data/name
 if p.is_dir():shutil.copytree(p,backup/name)
 elif p.exists():shutil.copy2(p,backup/name)
shutil.copytree(active,backup/'linux-unpacked-0.15.0');assert files(backup/'linux-unpacked-0.15.0')==prior
stage=root/'release'/('.deepseek-stage-'+ident);shutil.copytree(candidate,stage);assert files(stage)==selected
old=root/'release'/('before-deepseek-0.15.0-'+ident)
report={'status':'backed_up','backup':str(backup),'source':str(source),'baseline':acceptance['baseline'],'candidate':str(candidate),'active':str(active),'priorBundle':str(old),'applicationSha256':selected['resources/app.asar'],'databaseMigration':False,'modelRequests':0,'rollback':'Preserve all newer data before an explicitly agreed restore. Old 0.15.0 does not support new v7 conversations; prefer a forward fix.'}
def save():
 for p in [backup/'delivery.json',root/'test-results/deepseek-delivery.json']:
  with open(p,'w') as f:json.dump(report,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
  os.chmod(p,0o600)
save()
for p in [x for x in backup.rglob('*') if x.is_file()]+[x for x in stage.rglob('*') if x.is_file()]:
 with open(p,'rb') as f:os.fsync(f.fileno())
assert inventory(source)==acceptance['baseline']
active.rename(old)
try:stage.rename(active)
except:
 old.rename(active)
 raise
assert files(active)==selected and inventory(source)==acceptance['baseline']
for folder in [root/'release',backup]:
 d=os.open(folder,os.O_RDONLY);os.fsync(d);os.close(d)
report['status']='bundle_switched';save();os.close(fd)
print(json.dumps({'status':report['status'],'backup':str(backup)}))
`;
console.log(execFileSync('python3',['-c',code],{encoding:'utf8',maxBuffer:2000000}).trim());
const report=read(reportPath),passes=[],errors=[],env={...process.env};
for(const k of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_DATA_DIR','STOMYLOS_TEST_ENDPOINT','STOMYLOS_PACKAGED_TEST','STOMYLOS_LIVE_VERIFY'])delete env[k];
let app;
try{
 for(let pass=0;pass<2;pass++){
  app=await electron.launch({executablePath:resolve('run.sh'),env,chromiumSandbox:true,timeout:30000});
  const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
  const result=await page.evaluate(async ids=>{
   const snapshot=await window.stomylos.command('snapshot');const views=await Promise.all(ids.map(sessionId=>window.stomylos.command('loadSession',{sessionId})));
   const memory=JSON.stringify(views[0].memory.current);if(!views.every(v=>JSON.stringify(v.memory.current)===memory))throw Error('Shared memory differs');
   return {version:snapshot.settings.appVersion,dataPath:snapshot.settings.dataPath,development:snapshot.settings.development,simulation:snapshot.settings.simulation,characters:snapshot.characters.map(c=>c.id),sessions:views.length,memoryItems:['traits','relationships','experiences','intentions'].reduce((n,c)=>n+views[0].memory.current[c].length,0)};
  },Object.keys(copy.baseline.sessions));
  assert.equal(result.version,'0.16.0');assert.equal(result.development,false);assert.equal(result.simulation,false);assert.equal(join(result.dataPath,'stomylos.sqlite3'),copy.source);assert.equal(result.characters.length,7);assert.equal(result.memoryItems,copy.passes[0].memoryItems);passes.push(result);
  const exited=new Promise(r=>app.process().once('exit',r));await page.evaluate(()=>window.stomylos.command('close'));await exited;app=null;
  assert.deepEqual(JSON.parse(execFileSync('python3',['-c',copy.inventoryCode+'\nprint(json.dumps(inventory(sys.argv[1])))',copy.source],{encoding:'utf8'})),copy.baseline);
 }
 assert.deepEqual(errors,[]);Object.assign(report,{status:'delivered_and_verified',normalLaunches:passes,errors,archiveSha256:archive.sha256});
 for(const path of [reportPath,join(report.backup,'delivery.json')])writeFileSync(path,JSON.stringify(report,null,2)+'\n',{mode:0o600,flush:true});
 console.log(JSON.stringify({status:report.status,version:'0.16.0',sessions:passes[0].sessions,memoryItems:passes[0].memoryItems,normalOpens:passes.length,backup:report.backup,modelRequests:0}));
}finally{await app?.close();}
