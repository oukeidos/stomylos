// Explicit 0.19.2/v12 -> 0.20.0/v13 local delivery; verified copy, matched rollback.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { extractFile } from '@electron/asar';
import { _electron as electron } from 'playwright-core';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const reportPath='test-results/explain-delivery.json';
assert(process.argv.includes('--deliver'));
assert(!existsSync(reportPath),'Inspect unfinished/prior delivery instead of repeating');
const audit=read('test-results/explain-archive.json'), acceptance=read('test-results/explain-copy-acceptance.json');
const candidate=resolve('release/explain-candidate/linux-unpacked');
assert.equal(read('test-results/explain-packaged/report.json').status,'passed');
for(const name of ['explain-package.json','explain-install.json','explain-copy-acceptance.json']) assert.equal(read('test-results/'+name).status,'passed');
assert.equal(audit.status,'audited-candidate');
assert.equal(hash(readFileSync(audit.archive)),audit.sha256);
assert.equal(read('test-results/explain-install.json').archiveSha256,audit.sha256);
assert.equal(read('test-results/explain-package.json').applicationSha256,audit.applicationSha256);
assert.equal(hash(readFileSync(join(candidate,'resources/app.asar'))),audit.applicationSha256);
assert.equal(JSON.parse(extractFile(join(candidate,'resources/app.asar'),'package.json')).version,'0.20.0');
// Prove all built application bytes belong to the tested candidate.
const { readdirSync } = await import('node:fs');
function compare(folder){for(const e of readdirSync(folder,{withFileTypes:true})){const p=join(folder,e.name);if(e.isDirectory())compare(p);else assert.equal(hash(readFileSync(p)),hash(extractFile(join(candidate,'resources/app.asar'),p)),p);}}
compare('out');
const python = String.raw`
import sqlite3,json,hashlib,sys,os,fcntl,shutil,uuid
from pathlib import Path
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def digest(v):return hashlib.sha256(json.dumps(v,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def quote(v):return '"'+v.replace('"','""')+'"'
def inventory(file):
 c=sqlite3.connect('file:'+str(file)+'?mode=ro',uri=True)
 assert c.execute('pragma integrity_check').fetchone()[0]=='ok'
 assert not c.execute('pragma foreign_key_check').fetchall()
 out={'version':c.execute('pragma user_version').fetchone()[0],'tables':{},'sessions':[r[0] for r in c.execute('select id from sessions order by id')]}
 for name, in c.execute("select name from sqlite_master where type='table' order by name"):
  rows=c.execute('select rowid,* from '+quote(name)+' order by rowid').fetchall()
  out['tables'][name]={'count':len(rows),'sha256':digest(rows)}
 c.close();return out
def files(folder):
 result={}
 assert not folder.is_symlink()
 for p in sorted(folder.rglob('*')):
  assert not p.is_symlink(),'Unexpected symlink in bundle or asset backup'
  if p.is_file():result[str(p.relative_to(folder))]=sha(p)
 return result
def sync(folder):
 for p in [x for x in folder.rglob('*') if x.is_file()]:
  with open(p,'rb') as f:os.fsync(f.fileno())
 for p in sorted([x for x in folder.rglob('*') if x.is_dir()],reverse=True)+[folder]:
  fd=os.open(p,os.O_RDONLY);os.fsync(fd);os.close(fd)
`;

const py=(code,...args)=>JSON.parse(execFileSync('python3',['-c',python+'\n'+code,...args],{encoding:'utf8',maxBuffer:4000000}));
const desktop=execFileSync('xdg-user-dir',['DESKTOP'],{encoding:'utf8'}).trim();
const installed=join(process.env.HOME,'.local/opt/stomylos/0.20.0');
const priorInstalled=join(process.env.HOME,'.local/opt/stomylos/0.19.2');
const report=py(String.raw`
a=json.loads(Path('test-results/explain-copy-acceptance.json').read_text());audit=json.loads(Path('test-results/explain-archive.json').read_text())
source=Path(a['source']);data=source.parent;root=Path.cwd();candidate=root/'release/explain-candidate/linux-unpacked';active=root/'release/linux-unpacked'
installed=Path(sys.argv[1]);prior_installed=Path(sys.argv[2]);desktop=Path(sys.argv[3]);converted=Path(a['directory'])/'stomylos.sqlite3'
assert not installed.exists() and not installed.is_symlink()
fd=os.open(data/'stomylos.lock',os.O_RDWR|os.O_NOFOLLOW);fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
assert sha(source)==a['conversion']['source_sha256'] and inventory(source)==a['baseline']
assert sha(converted)==a['conversion']['target_sha256'] and inventory(converted)==a['converted']
assert a['baseline']['version']==12 and a['converted']['version']==13
for suffix in ['-journal','-wal','-shm']:
 p=Path(str(source)+suffix);assert not p.exists() or p.stat().st_size==0
prior=files(prior_installed);assert files(active)==prior
selected=files(candidate);assert selected['resources/app.asar']==audit['applicationSha256']
entries=[Path.home()/'.local/share/applications/stomylos.desktop',desktop/'stomylos.desktop']
for p in entries:assert not p.is_symlink() and 'X-Stomylos-Managed=true' in p.read_text() and str(prior_installed/'run.sh') in p.read_text()
backup=data/'backups'/('explain-delivery-'+str(uuid.uuid4()));backup.mkdir(mode=0o700)
shutil.copytree(prior_installed,backup/'before-0.19.2-bundle');assert files(backup/'before-0.19.2-bundle')==prior
shutil.copy2(source,backup/'before-v12.sqlite3');os.chmod(backup/'before-v12.sqlite3',0o600);assert sha(backup/'before-v12.sqlite3')==sha(source)
assets={}
for name in ['preferences.json','asr','speech']:
 p=data/name
 if p.exists():
  assert not p.is_symlink()
  if p.is_dir():assets[name]=files(p);shutil.copytree(p,backup/name);assert files(backup/name)==assets[name]
  else:assets[name]=sha(p);shutil.copy2(p,backup/name);assert sha(backup/name)==assets[name]
for i,p in enumerate(entries):shutil.copy2(p,backup/('launcher-'+str(i)+'.desktop'))
shutil.copytree(a['conversion']['archive'],backup/'conversion-evidence')
shutil.copy2('scripts/deliver-explain.mjs',backup/'deliver-explain.mjs')
shutil.copytree(candidate,installed);assert files(installed)==selected
stage=root/'release'/'.explain-stage';assert not stage.exists();shutil.copytree(candidate,stage);assert files(stage)==selected
old=root/'release'/'before-explain-0.19.2';assert not old.exists()
staged=data/'.explain-v13.sqlite3';assert not staged.exists();shutil.copy2(converted,staged);os.chmod(staged,0o600)
report={'status':'backed_up','version':'0.20.0','priorVersion':'0.19.2','backup':str(backup),'backupBundle':'before-0.19.2-bundle','backupDatabase':'before-v12.sqlite3','source':str(source),'sourceSha256':sha(source),'baseline':a['baseline'],'converted':a['converted'],'priorFiles':prior,'assetHashes':assets,'applicationSha256':audit['applicationSha256'],'archiveSha256':audit['sha256'],'installed':str(installed),'priorInstalled':str(prior_installed),'entries':[str(p) for p in entries],'normalLaunches':[],'modelRequests':0}
def save():
 for p in [backup/'delivery.json',root/'test-results/explain-delivery.json']:
  with open(p,'w') as f:json.dump(report,f,indent=2);f.flush();os.fsync(f.fileno())
  os.chmod(p,0o600)
save();sync(backup);sync(installed);sync(stage)
with open(staged,'rb') as f:os.fsync(f.fileno())
assert sha(source)==a['conversion']['source_sha256']
active.rename(old)
try:
 stage.rename(active);os.replace(staged,source)
 for p in entries:
  text=p.read_text().replace(str(prior_installed),str(installed));tmp=p.with_suffix('.explain-new');tmp.write_text(text);os.chmod(tmp,0o755);os.replace(tmp,p)
 assert files(active)==selected and inventory(source)==a['converted']
except:
 restore=data/'.explain-restore.sqlite3';shutil.copy2(backup/'before-v12.sqlite3',restore);os.replace(restore,source)
 if active.exists():active.rename(stage)
 old.rename(active)
 for i,p in enumerate(entries):shutil.copy2(backup/('launcher-'+str(i)+'.desktop'),p)
 report['status']='rolled_back_before_launch';save();raise
for folder in [data,root/'release',installed.parent,*[p.parent for p in entries]]:
 d=os.open(folder,os.O_RDONLY);os.fsync(d);os.close(d)
report['status']='converted_and_switched';save();os.close(fd);print(json.dumps(report))
`,installed,priorInstalled,desktop);
const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('STOMYLOS_')||['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL'].includes(k))delete env[k];
let app;const save=()=>{for(const p of [reportPath,join(report.backup,'delivery.json')])writeFileSync(p,JSON.stringify(report,null,2)+'\n',{mode:0o600,flush:true});};
try{
 for(let i=0;i<2;i++){
  app=await electron.launch({executablePath:join(installed,'run.sh'),env,chromiumSandbox:true,timeout:30000});
  await app.evaluate(()=>{globalThis.fetch=async()=>{throw new Error('No provider calls during delivery verification');};});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
  const observed=await page.evaluate(async ids=>{const s=await window.stomylos.command('snapshot');for(const sessionId of ids){await window.stomylos.command('loadSession',{sessionId});await window.stomylos.command('explainList',{sessionId});}return {version:s.settings.appVersion,dataPath:s.settings.dataPath,development:s.settings.development,simulation:s.settings.simulation,sessions:ids.length};},acceptance.converted.sessions);
  assert.equal(observed.version,'0.20.0');assert.equal(join(observed.dataPath,'stomylos.sqlite3'),report.source);assert.equal(observed.simulation,false);assert.equal(observed.development,false);
  assert.equal(await app.evaluate(({app})=>app.commandLine.hasSwitch('no-sandbox')),false);
  const exited=new Promise(done=>app.process().once('exit',done));await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await exited;app=null;
  assert.deepEqual(errors,[]);assert.deepEqual(py('print(json.dumps(inventory(sys.argv[1])))',report.source),acceptance.converted);
  report.normalLaunches.push(observed);save();
 }
 for(const p of report.entries)execFileSync('desktop-file-validate',[p]);
 report.status='delivered_and_verified';save();writeFileSync('test-results/release-audit.json',JSON.stringify(audit,null,2));
 console.log(JSON.stringify({status:report.status,version:report.version,backup:report.backup,sessions:report.normalLaunches[0].sessions,opens:2,modelRequests:0}));
}catch(e){report.status='switched_needs_attention';report.failure=String(e);save();throw e;}finally{await app?.close().catch(()=>{});}
