// Guarded local cutover after offline/package/copy acceptance. No model requests.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractFile } from '@electron/asar';
import { _electron as electron } from 'playwright-core';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = read('test-results/shared-memory-copy-acceptance.json');
const gates = read('test-results/shared-memory-release-gates.json');
const candidate = resolve('release/shared-memory-candidate/linux-unpacked'), active = resolve('release/linux-unpacked');
const reportPath = 'test-results/shared-memory-delivery.json';
assert.equal(copy.status, 'passed'); assert.equal(gates.status, 'passed');
assert.equal(read('test-results/memory-native-report.json').status, 'passed');
assert.equal(read('test-results/shared-memory-package-report.json').status, 'passed');
assert.equal(read('test-results/install-report.json').status, 'passed');
assert(!existsSync(reportPath), 'Existing delivery evidence requires inspection, not replay');
assert(!existsSync('stomylos'), 'Unexpected launcher override');
const candidateAsar = join(candidate, 'resources/app.asar');
assert.equal(hash(readFileSync(candidateAsar)), gates.applicationSha256);
assert.equal(JSON.parse(extractFile(candidateAsar, 'package.json').toString()).version, '0.15.0');
assert.equal(JSON.parse(extractFile(join(active, 'resources/app.asar'), 'package.json').toString()).version, '0.14.0');
function verifyOut(folder) {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) verifyOut(path);
    else assert.equal(hash(extractFile(candidateAsar, relative(process.cwd(), path))), hash(readFileSync(path)), path);
  }
}
verifyOut(resolve('out'));
assert.equal(hash(readFileSync(join(candidate, 'README.md'))), hash(readFileSync('README.md')));
const archive = read('test-results/release-audit.json');
assert.equal(archive.version, '0.15.0'); assert.equal(hash(readFileSync(archive.archive)), archive.sha256);
assert.equal(read('test-results/install-report.json').archiveSha256, archive.sha256);
if (!process.argv.includes('--deliver')) {
  console.log(JSON.stringify({ status: 'ready', version: '0.15.0', applicationSha256: gates.applicationSha256, source: copy.source.source,
    originalRows: Object.values(copy.baseline.tables).reduce((n, r) => n + r.count, 0), merge: copy.merge, destination: active }));
  process.exit(0);
}
const inventoryPython = String.raw`
import sqlite3,json,hashlib,sys
from pathlib import Path
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def inventory(file):
 c=sqlite3.connect('file:'+str(file)+'?mode=ro',uri=True)
 assert c.execute('pragma integrity_check').fetchone()[0]=='ok'
 assert not c.execute('pragma foreign_key_check').fetchall()
 result={'version':c.execute('pragma user_version').fetchone()[0], 'schema':digest(c.execute('select type,name,tbl_name,sql from sqlite_master order by type,name').fetchall()),'tables':{}}
 for table, in c.execute("select name from sqlite_master where type='table' order by name"):
  rows=c.execute('select rowid,* from "'+table+'" order by rowid').fetchall()
  result['tables'][table]={'count':len(rows),'sha256':digest(rows)}
 result['sessions']={r[0]:digest(r[1]) for r in c.execute('select id,chat_config from sessions')}
 c.close();return result
`;
const cutoverPython = inventoryPython + String.raw`
import os,fcntl,shutil,uuid
root=Path.cwd(); acceptance=json.loads((root/'test-results/shared-memory-copy-acceptance.json').read_text())
source=Path(acceptance['source']['source']);data=source.parent
fd=os.open(data/'stomylos.lock',os.O_RDWR|os.O_NOFOLLOW)
fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
assert sha(source)==acceptance['source']['source_sha256'],'Normal history changed since copy acceptance'
assert inventory(source)==acceptance['baseline']
for suffix in ['-journal','-wal','-shm']:
 p=Path(str(source)+suffix);assert not p.exists() or p.stat().st_size==0,'Unclean database sidecar'
converted=Path(acceptance['copy']);assert inventory(converted)==acceptance['converted']
candidate=root/'release/shared-memory-candidate/linux-unpacked';active=root/'release/linux-unpacked'
def files(folder):
 result={}
 for p in sorted(folder.rglob('*')):
  assert not p.is_symlink(),'Unexpected bundle symlink'
  if p.is_file():result[str(p.relative_to(folder))]=sha(p)
 return result
selected=files(candidate);prior=files(active);ident=str(uuid.uuid4())
backup=data/'backups'/('shared-memory-delivery-'+ident);backup.mkdir(mode=0o700)
shutil.copy2(source,backup/'before-v8.sqlite3');os.chmod(backup/'before-v8.sqlite3',0o600)
assert sha(backup/'before-v8.sqlite3')==sha(source)
for name in ['preferences.json','asr','speech']:
 p=data/name
 if p.is_dir():shutil.copytree(p,backup/name)
 elif p.exists():shutil.copy2(p,backup/name)
shutil.copytree(active,backup/'linux-unpacked-0.14.0');assert files(backup/'linux-unpacked-0.14.0')==prior
shutil.copytree(acceptance['archive'],backup/'conversion-evidence')
shutil.copy2(root/'scripts/convert-shared-memory.mjs',backup/'convert-shared-memory.mjs')
stage=root/'release'/('.shared-memory-stage-'+ident);shutil.copytree(candidate,stage);assert files(stage)==selected
staged_db=data/('.shared-memory-v9-'+ident+'.sqlite3');shutil.copy2(converted,staged_db);os.chmod(staged_db,0o600)
assert inventory(staged_db)==acceptance['converted']
old=root/'release'/('before-shared-memory-0.14.0-'+ident)
report={'status':'backed_up','backup':str(backup),'source':str(source),'candidate':str(candidate),'active':str(active),'priorBundle':str(old),
 'baseline':acceptance['baseline'],'converted':acceptance['converted'],'merge':acceptance['merge'],
 'sourceSha256':sha(source),'targetSha256':sha(staged_db),'applicationSha256':selected['resources/app.asar'],'modelRequests':0,
 'rollback':'Preserve any later data before an explicitly agreed matched 0.14.0/v8 restore. Prefer a forward fix after new v9 writes.'}
def save():
 for p in [backup/'delivery.json',root/'test-results/shared-memory-delivery.json']:
  with open(p,'w') as f:json.dump(report,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
  os.chmod(p,0o600)
save()
for p in [x for x in backup.rglob('*') if x.is_file()]+[x for x in stage.rglob('*') if x.is_file()]+[staged_db]:
 with open(p,'rb') as f:os.fsync(f.fileno())
assert sha(source)==acceptance['source']['source_sha256']
active.rename(old)
try:
 stage.rename(active)
 os.replace(staged_db,source)
except:
 if active.exists():active.rename(stage)
 old.rename(active)
 raise
assert files(active)==selected and inventory(source)==acceptance['converted']
for folder in [data,root/'release',backup]:
 d=os.open(folder,os.O_RDONLY);os.fsync(d);os.close(d)
report['status']='converted_and_switched';save();os.close(fd)
print(json.dumps({'status':report['status'],'backup':str(backup)}))
`;
console.log(execFileSync('python3', ['-c', cutoverPython], { encoding: 'utf8', maxBuffer: 2000000 }).trim());
const report = read(reportPath), passes = [], errors = [];
const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_DATA_DIR', 'STOMYLOS_TEST_ENDPOINT', 'STOMYLOS_PACKAGED_TEST', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
let app;
try {
  for (let i = 0; i < 2; i++) {
    app = await electron.launch({ executablePath: resolve('run.sh'), env, chromiumSandbox: true, timeout: 30000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const result = await page.evaluate(async ids => {
      const snapshot = await window.stomylos.command('snapshot');
      const views = await Promise.all(ids.map(sessionId => window.stomylos.command('loadSession', { sessionId })));
      const shared = JSON.stringify(views[0].memory.current);
      if (!views.every(v => JSON.stringify(v.memory.current) === shared)) throw new Error('Different current memories');
      return { version: snapshot.settings.appVersion, dataPath: snapshot.settings.dataPath, development: snapshot.settings.development,
        simulation: snapshot.settings.simulation, sessions: views.length, items: ['traits','relationships','experiences','intentions'].reduce((n,c) => n + views[0].memory.current[c].length, 0) };
    }, Object.keys(report.baseline.sessions));
    assert.equal(result.version, '0.15.0'); assert.equal(result.development, false); assert.equal(result.simulation, false);
    assert.equal(join(result.dataPath, 'stomylos.sqlite3'), report.source); assert.equal(result.items, report.merge.sharedItems);
    passes.push(result);
    const exited = new Promise(r => app.process().once('exit', r)); await page.evaluate(() => window.stomylos.command('close')); await exited; app = null;
    const after = JSON.parse(execFileSync('python3', ['-c', inventoryPython + '\nprint(json.dumps(inventory(sys.argv[1])))', report.source], { encoding: 'utf8' }));
    assert.deepEqual(after, report.converted, 'Normal read/close changed database records');
  }
  assert.deepEqual(errors, []); report.status = 'delivered_and_verified'; report.normalLaunches = passes; report.errors = errors; report.archiveSha256 = archive.sha256;
  for (const p of [reportPath, join(report.backup, 'delivery.json')]) writeFileSync(p, JSON.stringify(report, null, 2), { mode: 0o600, flush: true });
  console.log(JSON.stringify({ status: report.status, version: '0.15.0', sessions: passes[0].sessions, memoryItems: passes[0].items, opens: passes.length, backup: report.backup, modelRequests: 0 }));
} finally { if (app) await app.close(); }
