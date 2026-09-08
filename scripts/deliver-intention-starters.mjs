// Explicitly authorized local deployment. Private data stays in ignored artifacts
// and owner-only backups. No conversation is sent and no model work is requested.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { extractFile } from '@electron/asar';
import { _electron as electron } from 'playwright-core';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const candidate = resolve('release/intention-candidate/linux-unpacked'), active = resolve('release/linux-unpacked');
const reportPath = resolve('test-results/intention-delivery.json');
const previousDelivery = read('test-results/deepseek-delivery.json');
const source = previousDelivery.source;
const gate = read('test-results/intention-package-parity.json');
assert.equal(gate.status, 'passed');
for (const name of ['intention-native-report.json','intention-packaged-report.json']) assert.equal(read('test-results/' + name).status, 'passed');
assert(!existsSync(reportPath), 'Inspect existing delivery evidence before another cutover');
assert(!existsSync('stomylos'), 'Unexpected launcher override');
const candidateAsar = join(candidate, 'resources/app.asar');
assert.equal(hash(readFileSync(candidateAsar)), gate.archiveSha256);
assert.equal(JSON.parse(extractFile(candidateAsar, 'package.json')).version, '0.17.0');
assert.equal(JSON.parse(extractFile(join(active, 'resources/app.asar'), 'package.json')).version, '0.16.0');
for (const [name, digest] of Object.entries(gate.files)) {
  assert.equal(hash(readFileSync(name)), digest, name);
  assert.equal(hash(extractFile(candidateAsar, name)), digest, name);
}
assert.equal(hash(readFileSync(join(candidate, 'README.md'))), hash(readFileSync('README.md')));
const inventoryPython = String.raw`
import sqlite3,json,hashlib,sys,os,fcntl,shutil,uuid
from pathlib import Path
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def digest(v): return hashlib.sha256(json.dumps(v,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def quote(v): return '"'+v.replace('"','""')+'"'
def inventory(file,columns=None):
 c=sqlite3.connect('file:'+str(file)+'?mode=ro',uri=True)
 assert c.execute('pragma integrity_check').fetchone()[0]=='ok'
 assert not c.execute('pragma foreign_key_check').fetchall()
 names=list(columns) if columns else [r[0] for r in c.execute("select name from sqlite_master where type='table' order by name")]
 result={'version':c.execute('pragma user_version').fetchone()[0],'tables':{},'sessions':[r[0] for r in c.execute('select id from sessions order by id')]}
 for name in names:
  cols=columns[name] if columns else ['rowid']+[r[1] for r in c.execute('pragma table_info('+quote(name)+')')]
  rows=c.execute('select '+','.join(map(quote,cols))+' from '+quote(name)+' order by rowid').fetchall()
  result['tables'][name]={'columns':cols,'count':len(rows),'sha256':digest(rows)}
 memory=json.loads(c.execute('select document from shared_memory where id=1').fetchone()[0])
 result['memoryItems']=sum(len(memory[k]) for k in ['traits','relationships','experiences','intentions'])
 result['intentions']=len(memory['intentions'])
 c.close();return result
`;
const py = (code, ...args) => JSON.parse(execFileSync('python3', ['-c', inventoryPython + '\n' + code, ...args], { encoding: 'utf8', maxBuffer: 2_000_000 }));
const prepared = py(String.raw`
source=Path(sys.argv[1]);root=Path.cwd()
fd=os.open(source.parent/'stomylos.lock',os.O_RDWR|os.O_NOFOLLOW);fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
for suffix in ['-wal','-shm','-journal']:
 p=Path(str(source)+suffix);assert not p.exists() or p.stat().st_size==0,'Unclean sidecar'
baseline=inventory(source);assert baseline['version']==9
folder=root/'test-results'/('intention-data-copy-'+str(uuid.uuid4()));folder.mkdir(mode=0o700)
copy=folder/'stomylos.sqlite3';shutil.copy2(source,copy);os.chmod(copy,0o600)
assert sha(copy)==sha(source)
result={'source':str(source),'sourceSha256':sha(source),'copy':str(copy),'baseline':baseline}
with open(folder/'source.json','w') as f:json.dump(result,f,indent=2)
os.chmod(folder/'source.json',0o600);os.close(fd);print(json.dumps(result))
`, source);
const runtime = createRequire(import.meta.url)('electron');
const converted = JSON.parse(execFileSync(runtime, ['scripts/convert-intention-starters.mjs', prepared.copy, '--expected-source-sha256', prepared.sourceSha256],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', maxBuffer: 2_000_000 }));
const before = py('print(json.dumps(inventory(sys.argv[1])))', prepared.copy);
assert.equal(before.version, 10);
const columns = Object.fromEntries(Object.entries(prepared.baseline.tables).map(([k,v]) => [k,v.columns]));
const preserved = py('print(json.dumps(inventory(sys.argv[1],json.loads(sys.argv[2]))))', prepared.copy, JSON.stringify(columns));
assert.deepEqual(preserved.tables, prepared.baseline.tables);
for (const name of ['starter_preparations','intention_question_state','intention_question_jobs','intention_question_attempts']) assert.equal(before.tables[name].count, 0);
const cleanedEnv = () => {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_DATA_DIR','STOMYLOS_TEST_ENDPOINT','STOMYLOS_PACKAGED_TEST','STOMYLOS_LIVE_VERIFY']) delete env[key];
  return env;
};
async function inspectLaunch(executablePath, env, expected, normal) {
  let app; const errors = [];
  try {
    app = await electron.launch({ executablePath, env, chromiumSandbox: true, timeout: 30000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    assert.equal(await app.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox')), false);
    const result = await page.evaluate(async ids => {
      const snapshot = await window.stomylos.command('snapshot');
      const views = await Promise.all(ids.map(sessionId => window.stomylos.command('loadSession', { sessionId })));
      const memory = JSON.stringify(views[0].memory.current);
      if (!views.every(v => JSON.stringify(v.memory.current) === memory)) throw new Error('Shared memories differ');
      return { version: snapshot.settings.appVersion, dataPath: snapshot.settings.dataPath, development: snapshot.settings.development,
        simulation: snapshot.settings.simulation, keyPresent: snapshot.settings.keyPresent, sessions: views.length,
        memoryItems: ['traits','relationships','experiences','intentions'].reduce((n,k) => n + views[0].memory.current[k].length, 0),
        intentionJobs: views.reduce((n,v) => n + (v.intentions?.jobs.length ?? 0), 0) };
    }, expected.sessions);
    assert.equal(result.version, '0.17.0'); assert.equal(result.development, !normal); assert.equal(result.simulation, false);
    assert.equal(join(result.dataPath, 'stomylos.sqlite3'), normal ? source : prepared.copy);
    if (!normal) assert.equal(result.keyPresent, false);
    assert.equal(result.memoryItems, expected.memoryItems); assert.equal(result.intentionJobs, 0);
    const exited = new Promise(r => app.process().once('exit', r));
    await page.evaluate(() => window.stomylos.command('close')); await exited; app = null;
    assert.deepEqual(errors, []); return result;
  } finally { if (app) await app.close(); }
}
const copyPasses = [];
for (let i=0;i<2;i++) {
  copyPasses.push(await inspectLaunch(join(candidate, 'stomylos'), { ...cleanedEnv(), STOMYLOS_DATA_DIR: resolve(prepared.copy, '..') }, before, false));
  assert.deepEqual(py('print(json.dumps(inventory(sys.argv[1])))', prepared.copy), before, 'Copy startup/history/close changed records');
}
const acceptance = { status: 'passed', ...prepared, conversion: converted, converted: before, copyPasses, applicationSha256: gate.archiveSha256, modelRequests: 0 };
writeFileSync('test-results/intention-copy-acceptance.json', JSON.stringify(acceptance, null, 2) + '\n', { mode: 0o600, flush: true });
console.log(JSON.stringify({ status: 'copy_verified', sessions: before.sessions.length, originalRows: Object.values(prepared.baseline.tables).reduce((n,v) => n + v.count, 0), memoryItems: before.memoryItems }));
if (process.argv.includes('--deliver')) {
  const result = py(String.raw`
root=Path.cwd();a=json.loads((root/'test-results/intention-copy-acceptance.json').read_text());source=Path(a['source']);data=source.parent
fd=os.open(data/'stomylos.lock',os.O_RDWR|os.O_NOFOLLOW);fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
assert sha(source)==a['sourceSha256'] and inventory(source)==a['baseline'],'Source changed since copy acceptance'
for suffix in ['-journal','-wal','-shm']:
 p=Path(str(source)+suffix);assert not p.exists() or p.stat().st_size==0,'Unclean database'
converted=Path(a['copy']);assert inventory(converted)==a['converted']
candidate=root/'release/intention-candidate/linux-unpacked';active=root/'release/linux-unpacked'
def files(folder):
 result={}
 for p in sorted(folder.rglob('*')):
  assert not p.is_symlink(),'Unexpected bundle symlink'
  if p.is_file(): result[str(p.relative_to(folder))]=sha(p)
 return result
selected=files(candidate);prior=files(active);assert selected['resources/app.asar']==a['applicationSha256']
ident=str(uuid.uuid4());backup=data/'backups'/('intention-delivery-'+ident);backup.mkdir(mode=0o700)
shutil.copy2(source,backup/'before-v9.sqlite3');os.chmod(backup/'before-v9.sqlite3',0o600);assert sha(backup/'before-v9.sqlite3')==a['sourceSha256']
for name in ['preferences.json','asr','speech']:
 p=data/name
 if p.is_dir():shutil.copytree(p,backup/name)
 elif p.exists():shutil.copy2(p,backup/name)
shutil.copytree(a['conversion']['archive'],backup/'conversion-evidence')
shutil.copy2(root/'scripts/deliver-intention-starters.mjs',backup/'deliver-intention-starters.mjs')
stage=root/'release'/('.intention-stage-'+ident);shutil.copytree(candidate,stage);assert files(stage)==selected
staged_db=data/('.intention-v10-'+ident+'.sqlite3');shutil.copy2(converted,staged_db);os.chmod(staged_db,0o600)
assert inventory(staged_db)==a['converted']
old=root/'release'/('before-intention-0.16.0-'+ident)
report={'status':'backed_up','backup':str(backup),'source':str(source),'candidate':str(candidate),'active':str(active),'priorBundle':str(old),
 'baseline':a['baseline'],'converted':a['converted'],'applicationSha256':a['applicationSha256'],'sourceSha256':a['sourceSha256'],
 'targetSha256':sha(staged_db),'priorFiles':prior,'modelRequests':0,
 'rollback':'Preserve newer data first. A matched pre-delivery 0.16.0/v9 restore is in priorBundle and before-v9.sqlite3; prefer forward repair after v10 writes.'}
def save():
 for p in [backup/'delivery.json',root/'test-results/intention-delivery.json']:
  with open(p,'w') as f:json.dump(report,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
  os.chmod(p,0o600)
save()
for p in [x for x in backup.rglob('*') if x.is_file()]+[x for x in stage.rglob('*') if x.is_file()]+[staged_db]:
 with open(p,'rb') as f:os.fsync(f.fileno())
assert sha(source)==a['sourceSha256'];assert files(active)==prior
active.rename(old);swapped=False
try:
 stage.rename(active);os.replace(staged_db,source);swapped=True
 assert files(active)==selected and inventory(source)==a['converted']
except:
 if swapped:
  rollback=data/('.intention-rollback-'+ident+'.sqlite3');shutil.copy2(backup/'before-v9.sqlite3',rollback);os.replace(rollback,source)
 if active.exists():active.rename(stage)
 old.rename(active)
 report['status']='rolled_back_before_launch';save();raise
for folder in [data,root/'release',backup]:
 d=os.open(folder,os.O_RDONLY);os.fsync(d);os.close(d)
report['status']='converted_and_switched';save();os.close(fd)
print(json.dumps({'status':report['status'],'backup':str(backup)}))
`);
  console.log(JSON.stringify(result));
  const report = read(reportPath); report.normalLaunches = [];
  for (let i=0;i<2;i++) {
    report.normalLaunches.push(await inspectLaunch(resolve('run.sh'), cleanedEnv(), before, true));
    assert.deepEqual(py('print(json.dumps(inventory(sys.argv[1])))', source), before, 'Normal launcher changed database records');
  }
  report.status = 'delivered_and_verified';
  for (const path of [reportPath, join(report.backup, 'delivery.json')]) writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flush: true });
  console.log(JSON.stringify({ status: report.status, version: '0.17.0', schema: 10, sessions: before.sessions.length, memoryItems: before.memoryItems, opens: report.normalLaunches.length, backup: report.backup, modelRequests: 0 }));
}
