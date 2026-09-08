// Explicitly authorized normal installation + v11-to-v12 data cutover.
// Reuse the verified, unchanged data copy. Never dispatch inference for acceptance.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extractFile } from '@electron/asar';
import { _electron as electron } from 'playwright-core';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const hash = b => createHash('sha256').update(b).digest('hex');
const reportPath = 'test-results/model-switching-delivery.json';
assert(!existsSync(reportPath), 'Inspect the existing delivery report instead of repeating a cutover.');
assert(process.argv.includes('--deliver'), 'Explicit --deliver is required.');
assert(!existsSync('stomylos'), 'Unexpected source launcher override.');
const acceptance = read('test-results/model-switching-copy-acceptance.json');
const gate = read('test-results/model-switching-package-parity.json');
const audit = read('test-results/model-switching-archive.json');
assert.equal(acceptance.status, 'passed'); assert.equal(gate.status, 'passed');
for (const file of ['model-switching-native/report.json', 'model-switching-packaged/report.json', 'model-switching-install.json']) assert.equal(read('test-results/' + file).status, 'passed');
assert.equal(audit.status, 'audited-candidate'); assert.equal(hash(readFileSync(audit.archive)), gate.releaseSha256);
const candidate = resolve('release/model-switch-candidate/linux-unpacked'), active = resolve('release/linux-unpacked');
assert.equal(hash(readFileSync(join(candidate, 'resources/app.asar'))), gate.archiveSha256);
assert.equal(JSON.parse(extractFile(join(candidate, 'resources/app.asar'), 'package.json')).version, '0.19.0');
assert.equal(JSON.parse(extractFile(join(active, 'resources/app.asar'), 'package.json')).version, '0.18.0');
for (const [file, digest] of Object.entries(gate.files)) {
  assert.equal(hash(readFileSync(file)), digest, file);
  assert.equal(hash(extractFile(join(candidate, 'resources/app.asar'), file)), digest, file);
}
assert.equal(hash(readFileSync(join(candidate, 'README.md'))), gate.guideSha256);
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
const py = (code, ...args) => JSON.parse(execFileSync('python3', ['-c', python + '\n' + code, ...args], { encoding: 'utf8', maxBuffer: 2_000_000 }));
const result = py(String.raw`
root=Path.cwd();a=json.loads((root/'test-results/model-switching-copy-acceptance.json').read_text());gate=json.loads((root/'test-results/model-switching-package-parity.json').read_text())
source=Path(a['source']);data=source.parent;converted=Path(a['directory'])/'stomylos.sqlite3'
fd=os.open(data/'stomylos.lock',os.O_RDWR|os.O_NOFOLLOW);fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
assert source.is_file() and not source.is_symlink()
assert sha(source)==a['conversion']['source_sha256'] and inventory(source)==a['baseline'],'Source changed since copy acceptance'
assert a['baseline']['version']==11 and a['converted']['version']==12
assert sha(converted)==a['conversion']['target_sha256'] and inventory(converted)==a['converted'],'Verified copy changed'
for suffix in ['-journal','-wal','-shm']:
 p=Path(str(source)+suffix);assert not p.exists() or p.stat().st_size==0,'Unclean database'
candidate=root/'release/model-switch-candidate/linux-unpacked';active=root/'release/linux-unpacked'
selected=files(candidate);prior=files(active);assert selected['resources/app.asar']==gate['archiveSha256']
ident=str(uuid.uuid4());backups=data/'backups';assert not backups.is_symlink();backups.mkdir(mode=0o700,exist_ok=True)
backup=backups/('model-switching-delivery-'+ident);backup.mkdir(mode=0o700)
shutil.copy2(source,backup/'before-v11.sqlite3');os.chmod(backup/'before-v11.sqlite3',0o600);assert sha(backup/'before-v11.sqlite3')==a['conversion']['source_sha256']
shutil.copytree(active,backup/'before-0.18.0-bundle');assert files(backup/'before-0.18.0-bundle')==prior
for name in ['preferences.json','asr','speech']:
 p=data/name
 if p.is_dir():
  original=files(p);shutil.copytree(p,backup/name);assert files(backup/name)==original
 elif p.exists():
  assert not p.is_symlink();shutil.copy2(p,backup/name);assert sha(p)==sha(backup/name)
shutil.copytree(a['conversion']['archive'],backup/'conversion-evidence')
shutil.copy2(root/'scripts/deliver-model-switching.mjs',backup/'deliver-model-switching.mjs')
for p in backup.rglob('*'):
 if p.is_file() and 'before-0.18.0-bundle' not in p.parts:os.chmod(p,0o600)
 elif p.is_dir():os.chmod(p,0o700)
stage=root/'release'/('.model-switching-stage-'+ident);shutil.copytree(candidate,stage);assert files(stage)==selected
staged_db=data/('.model-switching-v12-'+ident+'.sqlite3');shutil.copy2(converted,staged_db);os.chmod(staged_db,0o600)
assert inventory(staged_db)==a['converted']
old=root/'release'/('before-model-switching-0.18.0-'+ident)
report={'status':'backed_up','backup':str(backup),'source':str(source),'candidate':str(candidate),'active':str(active),'priorBundle':str(old),
 'baseline':a['baseline'],'converted':a['converted'],'applicationSha256':gate['archiveSha256'],'archiveSha256':gate['releaseSha256'],
 'sourceSha256':a['conversion']['source_sha256'],'targetSha256':sha(staged_db),'priorFiles':prior,'modelRequests':0,
 'rollback':'Preserve newer data before restoring the matched before-0.18.0-bundle and before-v11.sqlite3 backup; prefer forward repair after v12 writes.'}
def save():
 for p in [backup/'delivery.json',root/'test-results/model-switching-delivery.json']:
  with open(p,'w') as f:json.dump(report,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
  os.chmod(p,0o600)
save();sync(backup);sync(stage)
with open(staged_db,'rb') as f:os.fsync(f.fileno())
assert sha(source)==a['conversion']['source_sha256'];assert files(active)==prior
active.rename(old);swapped=False
try:
 stage.rename(active);os.replace(staged_db,source);swapped=True
 assert files(active)==selected and inventory(source)==a['converted']
except:
 if swapped:
  restore=data/('.model-switching-rollback-'+ident+'.sqlite3');shutil.copy2(backup/'before-v11.sqlite3',restore);os.replace(restore,source)
 if active.exists():active.rename(stage)
 old.rename(active);report['status']='rolled_back_before_launch';save();raise
for folder in [data,root/'release',backup]:
 d=os.open(folder,os.O_RDONLY);os.fsync(d);os.close(d)
report['status']='converted_and_switched';save();os.close(fd)
print(json.dumps({'status':report['status'],'backup':str(backup)}))
`);
console.log(JSON.stringify(result));
const report = read(reportPath); report.normalLaunches = [];
const env = { ...process.env };
for (const name of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_DATA_DIR','STOMYLOS_TEST_ENDPOINT','STOMYLOS_PACKAGED_TEST','STOMYLOS_LIVE_VERIFY']) delete env[name];
let app;
try {
  for (let i = 0; i < 2; i++) {
    app = await electron.launch({ executablePath: resolve('run.sh'), env, chromiumSandbox: true, timeout: 30000 });
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    assert.equal(await app.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox')), false);
    const observed = await page.evaluate(async ids => {
      const snapshot = await window.stomylos.command('snapshot');
      const views = await Promise.all(ids.map(sessionId => window.stomylos.command('loadSession', { sessionId })));
      if (views.some(v => v.partner.pending || v.partner.currentCharacter !== v.session.character || v.partner.currentModel !== v.session.model)) throw new Error('Historical partner identity changed');
      return { version: snapshot.settings.appVersion, dataPath: snapshot.settings.dataPath, development: snapshot.settings.development,
        simulation: snapshot.settings.simulation, keyPresent: snapshot.settings.keyPresent, sessions: views.length,
        bookmarks: views.filter(v => v.bookmarked).length, requests: views.reduce((n,v) => n+v.requests.length,0),
        memoryItems: ['traits','relationships','experiences','intentions'].reduce((n,k) => n+views[0].memory.current[k].length,0) };
    }, acceptance.converted.sessions);
    assert.equal(observed.version, '0.19.0'); assert.equal(observed.development, false); assert.equal(observed.simulation, false);
    assert.equal(join(observed.dataPath, 'stomylos.sqlite3'), acceptance.source);
    const exited = new Promise(done => app.process().once('exit', done));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await exited; app = null;
    assert.deepEqual(errors, []);
    assert.deepEqual(py('print(json.dumps(inventory(sys.argv[1])))', acceptance.source), acceptance.converted, 'Normal launch changed database records');
    report.normalLaunches.push(observed);
  }
  report.status = 'delivered_and_verified';
  for (const p of [reportPath, join(report.backup, 'delivery.json')]) writeFileSync(p, JSON.stringify(report, null, 2)+'\n', { mode: 0o600, flush: true });
  console.log(JSON.stringify({ status: report.status, version: '0.19.0', schema: 12, sessions: report.normalLaunches[0].sessions,
    originalRows: Object.values(report.baseline.tables).reduce((n,t) => n+t.count,0), bookmarks: report.normalLaunches[0].bookmarks,
    memoryItems: report.normalLaunches[0].memoryItems, opens: report.normalLaunches.length, backup: report.backup, modelRequests: 0 }));
} catch (error) {
  report.status = 'switched_needs_attention'; report.failure = String(error);
  for (const p of [reportPath, join(report.backup, 'delivery.json')]) writeFileSync(p, JSON.stringify(report, null, 2)+'\n', { mode: 0o600, flush: true });
  throw error;
} finally { await app?.close().catch(() => undefined); }
execFileSync('python3', ['scripts/prune-artifacts.py', '--backup', report.backup, '--archive', audit.archive, '--apply'], { stdio: 'inherit' });
