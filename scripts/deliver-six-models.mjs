// Deliver the accepted six-model bundle with a matched backup and read-only normal UI checks.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { extractFile } from '@electron/asar';
import { _electron as electron } from 'playwright-core';

assert.equal(process.argv[2], '--deliver', 'Explicit delivery argument required.');
const read = name => JSON.parse(readFileSync(name, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reportPath = 'test-results/six-delivery.json';
assert(!existsSync(reportPath), 'Delivery evidence exists; inspect it instead of replaying.');
const copy = read('test-results/six-normal-copy.json');
assert.equal(read('test-results/six-copy-acceptance.json').status, 'passed');
assert.equal(read('test-results/six-live-20260906/quality-review.json').status, 'accepted_with_operational_limitation');
assert(read('test-results/six-suite-packaged.json').results.every(x => x.exitCode === 0));
assert.equal(read('test-results/package-report.json').status, 'passed');
assert.equal(read('test-results/install-report.json').status, 'passed');
const candidate = resolve('release/six-candidate/linux-unpacked');
const active = resolve('release/linux-unpacked');
assert(!existsSync('stomylos'), 'Unexpected launcher override.');
assert.equal(JSON.parse(extractFile(join(candidate, 'resources/app.asar'), 'package.json').toString()).version, '0.14.0');
assert.equal(JSON.parse(extractFile(join(active, 'resources/app.asar'), 'package.json').toString()).version, '0.13.1');
assert.equal(hash(readFileSync(join(candidate, 'resources/app.asar'))), read('test-results/six-asar-parity.json').sha256);
const archive = 'release/stomylos-linux-x64-0.14.0.tar.gz';
assert.equal(hash(readFileSync(archive)), read('test-results/install-report.json').archiveSha256);
const gate = read('test-results/six-live-20260906/gate.json');
for (const [path, expected] of Object.entries(gate.hashes)) assert.equal(hash(readFileSync(path)), expected, path);

const inventoryPython = String.raw`
import sqlite3,json,hashlib,sys
from pathlib import Path
def sha(file): return hashlib.sha256(Path(file).read_bytes()).hexdigest()
def digest(value): return hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def inventory(file):
 c=sqlite3.connect('file:'+str(file)+'?mode=ro',uri=True)
 assert c.execute('pragma user_version').fetchone()[0]==8
 assert c.execute('pragma integrity_check').fetchone()[0]=='ok'
 assert not c.execute('pragma foreign_key_check').fetchall()
 tables=[x[0] for x in c.execute("select name from sqlite_master where type='table' order by name")]
 result={'schema':digest(c.execute('select type,name,tbl_name,sql from sqlite_master order by type,name').fetchall()),'tables':{}}
 for table in tables:
  rows=c.execute('select rowid,* from "'+table+'" order by rowid').fetchall()
  result['tables'][table]={'count':len(rows),'sha256':digest(rows)}
 result['sessions']={r[0]:digest(r[1]) for r in c.execute('select id,chat_config from sessions')}
 c.close()
 return result
`;
const deliveryPython = inventoryPython + String.raw`
import fcntl,os,shutil,uuid
root=Path.cwd(); prepared=json.loads((root/'test-results/six-normal-copy.json').read_text())
source=Path(prepared['source']); data=source.parent
assert sha(prepared['original'])==prepared['original_sha256']
expected=inventory(prepared['original'])
fd=os.open(data/'stomylos.lock',os.O_RDWR|os.O_NOFOLLOW)
fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
assert inventory(source)==expected,'Normal data changed since copy acceptance; stop before delivery.'
candidate=root/'release/six-candidate/linux-unpacked'; active=root/'release/linux-unpacked'
def files(folder):
 out={}
 for p in sorted(folder.rglob('*')):
  assert not p.is_symlink(),'Unexpected bundle symlink'
  if p.is_file(): out[str(p.relative_to(folder))]=sha(p)
 return out
prior=files(active); selected=files(candidate)
assert prior==json.loads((root/'test-results/six-old-bundle.json').read_text())['files']
ident=str(uuid.uuid4()); backup=data/'backups'/('six-models-'+ident)
backup.mkdir(mode=0o700)
conn=sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True)
target=sqlite3.connect(str(backup/'stomylos.sqlite3'));conn.backup(target);target.close();conn.close()
os.chmod(backup/'stomylos.sqlite3',0o600)
assert inventory(backup/'stomylos.sqlite3')==expected
for name in ['preferences.json','asr','speech']:
 p=data/name
 if p.is_dir(): shutil.copytree(p,backup/name)
 elif p.exists(): shutil.copy2(p,backup/name)
shutil.copytree(active,backup/'linux-unpacked-0.13.1')
assert files(backup/'linux-unpacked-0.13.1')==prior
stage=root/'release'/('.six-delivery-'+ident)
shutil.copytree(candidate,stage)
assert files(stage)==selected
old=root/'release'/('before-six-0.13.1-'+ident)
report={'status':'backed_up','backup':str(backup),'source':str(source),'launcher':str(root/'run.sh'),
 'candidate':str(candidate),'active':str(active),'priorBundle':str(old),'candidateFiles':selected,
 'previousFiles':prior,'baseline':expected,'schemaVersion':8,'databaseMigration':False,'modelRequests':0,
 'rollback':'Keep the matched 0.13.1 bundle, DB, preferences and voice assets. After new v6 writes, archive all newer data before any explicitly agreed restore; prefer a forward fix.'}
def save():
 for p in [backup/'delivery.json',root/'test-results/six-delivery.json']:
  with open(p,'w') as f: json.dump(report,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
  os.chmod(p,0o600)
save()
for p in [x for x in backup.rglob('*') if x.is_file()]+[x for x in stage.rglob('*') if x.is_file()]:
 with open(p,'rb') as f:os.fsync(f.fileno())
assert inventory(source)==expected
active.rename(old)
try: stage.rename(active)
except:
 old.rename(active)
 raise
assert files(active)==selected and files(old)==prior
assert inventory(source)==expected
df=os.open(root/'release',os.O_RDONLY);os.fsync(df);os.close(df)
report['status']='bundle_switched';save();os.close(fd)
print(json.dumps({'status':report['status'],'backup':str(backup),'preservedRows':sum(x['count'] for x in expected['tables'].values())}))
`;
console.log(execFileSync('python3', ['-c', deliveryPython], { encoding: 'utf8', maxBuffer: 2000000 }).trim());
const delivery = read(reportPath), passes = [], errors = [];
const env = { ...process.env };
for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_DATA_DIR', 'STOMYLOS_TEST_ENDPOINT', 'STOMYLOS_PACKAGED_TEST', 'STOMYLOS_LIVE_VERIFY']) delete env[name];
let app;
try {
  for (let pass = 0; pass < 2; pass++) {
    app = await electron.launch({ executablePath: resolve('run.sh'), env, chromiumSandbox: true, timeout: 30000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const result = await page.evaluate(async ids => {
      const snapshot = await window.stomylos.command('snapshot');
      const configs = {};
      for (const sessionId of ids) configs[sessionId] = (await window.stomylos.command('loadSession', { sessionId })).session.chat_config;
      return { settings: snapshot.settings, configs, unfinished: snapshot.unfinished };
    }, Object.keys(delivery.baseline.sessions));
    assert.equal(result.settings.appVersion, '0.14.0');
    assert.equal(result.settings.development, false); assert.equal(result.settings.simulation, false);
    assert.equal(join(result.settings.dataPath, 'stomylos.sqlite3'), copy.source);
    for (const [id, text] of Object.entries(result.configs)) assert.equal(hash(JSON.stringify(text)), delivery.baseline.sessions[id]);
    assert(result.unfinished, 'The existing unsent draft must remain.');
    assert.equal(JSON.parse(result.configs[result.unfinished.id]).version, 'stomylos_conversation_v5');
    await page.getByRole('button', { name: 'Partner: Automatic', exact: true }).click();
    assert.equal(await page.getByRole('menuitemradio').count(), 5); await page.keyboard.press('Escape');
    passes.push({ version: result.settings.appVersion, sessions: Object.keys(result.configs).length,
      keyPresent: result.settings.keyPresent, oldDraftVersion: 'stomylos_conversation_v5', menuChoices: 5, inferenceActions: 0 });
    const exited = new Promise(resolve => app.process().once('exit', resolve));
    await page.evaluate(() => window.stomylos.command('close')); await exited; app = null;
    const after = JSON.parse(execFileSync('python3', ['-c', inventoryPython + '\nprint(json.dumps(inventory(sys.argv[1])))', copy.source], { encoding: 'utf8' }));
    assert.deepEqual(after, delivery.baseline, 'Normal read/close must retain every database row.');
  }
  assert.deepEqual(errors, []);
  delivery.status = 'delivered_and_verified'; delivery.normalLauncherPasses = passes; delivery.errors = errors;
  delivery.applicationSha256 = hash(readFileSync(join(active, 'resources/app.asar')));
  delivery.archiveSha256 = hash(readFileSync(archive));
  for (const path of [reportPath, join(delivery.backup, 'delivery.json')]) writeFileSync(path, JSON.stringify(delivery, null, 2) + '\n', { mode: 0o600, flush: true });
  console.log(JSON.stringify({ status: delivery.status, version: '0.14.0', backup: delivery.backup, normalLaunches: passes.length,
    sessionsPreserved: Object.keys(delivery.baseline.sessions).length, modelRequests: 0 }));
} finally { if (app) await app.close(); }
