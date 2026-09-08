// Explicit same-schema maintenance delivery. Retain one matched rollback set
// only after two normal launches preserve every database row without inference.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractFile } from '@electron/asar';
import { _electron as electron } from 'playwright-core';
import { createHash } from 'node:crypto';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
assert(process.argv.includes('--deliver'), 'Explicit --deliver is required');
const root = resolve('.'), version = read('package.json').version;
const candidate = resolve('release/maintenance-candidate/linux-unpacked');
const active = resolve('release/linux-unpacked');
const audit = read('test-results/maintenance-archive.json');
const reportPath = `test-results/maintenance-delivery-${version}.json`;
for (const file of ['maintenance-package.json', 'maintenance-install.json']) assert.equal(read('test-results/' + file).status, 'passed');
assert.equal(audit.status, 'audited-candidate');
assert.equal(read('test-results/maintenance-install.json').archiveSha256, audit.sha256);
assert.equal(hash(readFileSync(audit.archive)), audit.sha256);
const candidateHash = hash(readFileSync(join(candidate, 'resources/app.asar')));
assert.equal(audit.applicationSha256, candidateHash);
assert.equal(read('test-results/maintenance-package.json').applicationSha256, candidateHash);
assert.equal(JSON.parse(extractFile(join(candidate, 'resources/app.asar'), 'package.json')).version, version);
assert.equal(read('test-results/maintenance-package.json').executablePath, join(candidate, 'stomylos'));
const schemaVersion = read('test-results/maintenance-package.json').schemaVersion;
assert.ok(Number.isInteger(schemaVersion) && schemaVersion > 0);
function compare(folder) { for (const entry of readdirSync(folder, { withFileTypes: true })) { const path = join(folder, entry.name); if (entry.isDirectory()) compare(path); else assert.equal(hash(readFileSync(path)), hash(extractFile(join(candidate, 'resources/app.asar'), path)), path); } }
compare('out');
const priorVersion = JSON.parse(extractFile(join(active, 'resources/app.asar'), 'package.json')).version;
assert.notEqual(priorVersion, version, 'A maintenance release needs a distinct version');
assert(!existsSync(reportPath), 'Inspect the existing delivery record before repeating');
const python = String.raw`
import sqlite3,json,hashlib,sys,os,fcntl,shutil,uuid
from pathlib import Path
def sha(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def files(folder):
 assert not folder.is_symlink()
 out={}
 for p in folder.rglob('*'):
  assert not p.is_symlink(),'Symlink refused'
  if p.is_file():out[str(p.relative_to(folder))]=sha(p)
 return out
def inventory(p):
 c=sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True)
 assert c.execute('pragma integrity_check').fetchone()[0]=='ok'
 assert not c.execute('pragma foreign_key_check').fetchall()
 out={'schema':c.execute('pragma user_version').fetchone()[0],'tables':{}}
 for name, in c.execute("select name from sqlite_master where type='table' order by name"):
  rows=c.execute('select rowid,* from "'+name.replace('"','""')+'" order by rowid').fetchall()
  out['tables'][name]={'count':len(rows),'sha256':hashlib.sha256(json.dumps(rows,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()}
 c.close();return out
`;
const py = (code, ...args) => JSON.parse(execFileSync('python3', ['-c', python + '\n' + code, ...args], { encoding: 'utf8' }));
// Respect the same normal-data location as the product. Do not read the key.
const dataHome = process.env.XDG_DATA_HOME || join(process.env.HOME, '.local/share');
assert(dataHome.startsWith('/'));
const data = join(dataHome, 'io.github.oukeidos.stomylos');
const installed = join(process.env.HOME, '.local/opt/stomylos', version);
const priorInstalled = join(process.env.HOME, '.local/opt/stomylos', priorVersion);
const desktop = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim();
const report = py(String.raw`
root=Path(sys.argv[1]);data=Path(sys.argv[2]);prior_version=sys.argv[3];version=sys.argv[4]
schema=int(sys.argv[5]);installed=Path(sys.argv[6]);prior_installed=Path(sys.argv[7]);desktop=Path(sys.argv[8]);report_path=Path(sys.argv[9])
active=root/'release/linux-unpacked';candidate=root/'release/maintenance-candidate/linux-unpacked';source=data/'stomylos.sqlite3'
assert not installed.exists() and not installed.is_symlink()
fd=os.open(data/'stomylos.lock',os.O_RDWR|os.O_NOFOLLOW);fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
assert not data.is_symlink() and not source.is_symlink()
for suffix in ['-journal','-wal','-shm']:
 p=Path(str(source)+suffix);assert not p.exists() or p.stat().st_size==0,'Unclean database'
baseline=inventory(source);source_hash=sha(source);prior=files(active);selected=files(candidate)
assert files(prior_installed)==prior
entries=[data.parent/'applications/stomylos.desktop',desktop/'stomylos.desktop']
for p in entries:assert not p.is_symlink() and 'X-Stomylos-Managed=true' in p.read_text() and str(prior_installed/'run.sh') in p.read_text()
# This entry point never converts data. Candidate schema must match exactly.
assert baseline['schema']==schema
backups=data/'backups';assert not backups.is_symlink();backups.mkdir(mode=0o700,exist_ok=True)
ident=str(uuid.uuid4());backup=backups/('maintenance-delivery-'+ident);backup.mkdir(mode=0o700)
bundle_name='before-'+prior_version+'-bundle';db_name='before-v'+str(schema)+'.sqlite3'
shutil.copytree(active,backup/bundle_name);assert files(backup/bundle_name)==prior
shutil.copy2(source,backup/db_name);os.chmod(backup/db_name,0o600);assert sha(backup/db_name)==source_hash
assets={}
for name in ['preferences.json','asr','speech']:
 p=data/name
 if p.is_dir():
  assets[name]=files(p);shutil.copytree(p,backup/name);assert files(backup/name)==assets[name]
 elif p.exists():
  assert not p.is_symlink();assets[name]=sha(p);shutil.copy2(p,backup/name);assert sha(backup/name)==assets[name]
for i,p in enumerate(entries):shutil.copy2(p,backup/('launcher-'+str(i)+'.desktop'))
stage=root/'release'/('.maintenance-stage-'+ident);shutil.copytree(candidate,stage);assert files(stage)==selected
shutil.copytree(candidate,installed);assert files(installed)==selected
old=root/'release'/('before-maintenance-'+ident)
report={'status':'backed_up','version':version,'priorVersion':prior_version,'backup':str(backup),'backupBundle':bundle_name,'backupDatabase':db_name,
 'source':str(source),'sourceSha256':source_hash,'priorFiles':prior,'assetHashes':assets,'baseline':baseline,'applicationSha256':selected['resources/app.asar'],
 'installed':str(installed),'priorInstalled':str(prior_installed),'entries':[str(p) for p in entries],
 'rollback':'Restore the matched bundle, database, assets and launchers only after preserving newer data.'}
def save():
 for p in [backup/'delivery.json',report_path]:
  with open(p,'w') as f:json.dump(report,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
  os.chmod(p,0o600)
save()
for p in [*backup.rglob('*'),*stage.rglob('*'),*installed.rglob('*')]:
 if p.is_file():
  with open(p,'rb') as f:os.fsync(f.fileno())
assert sha(source)==source_hash and files(active)==prior
active.rename(old)
try:
 stage.rename(active)
 for p in entries:
  temp=p.with_suffix('.maintenance-new');temp.write_text(p.read_text().replace(str(prior_installed),str(installed)));os.chmod(temp,0o755);os.replace(temp,p)
except:
 if active.exists():active.rename(stage)
 old.rename(active)
 for i,p in enumerate(entries):shutil.copy2(backup/('launcher-'+str(i)+'.desktop'),p)
 report['status']='rolled_back_before_launch';save();raise
for p in [backup,backups,root/'release',installed.parent,*[p.parent for p in entries]]:
 d=os.open(p,os.O_RDONLY);os.fsync(d);os.close(d)
report['status']='switched';save();os.close(fd);print(json.dumps(report))
`, root, data, priorVersion, version, String(schemaVersion), installed, priorInstalled, desktop, resolve(reportPath));
report.normalLaunches = [];
const env = { ...process.env };
for (const name of Object.keys(env)) if (name.startsWith('STOMYLOS_') || name === 'ELECTRON_RUN_AS_NODE' || name === 'ELECTRON_RENDERER_URL') delete env[name];
let app;
const save = () => { for (const path of [reportPath, join(report.backup, 'delivery.json')]) writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flush: true }); };
try {
  for (let i = 0; i < 2; i++) {
    app = await electron.launch({ executablePath: join(installed, 'run.sh'), env, chromiumSandbox: true, timeout: 30000 });
    await app.evaluate(() => { globalThis.deliveryRequests = 0; globalThis.fetch = async () => { globalThis.deliveryRequests++; throw new Error('Provider requests are excluded from delivery acceptance'); }; });
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const observed = await page.evaluate(async () => {
      const snapshot = await window.stomylos.command('snapshot');
      return { version: snapshot.settings.appVersion, dataPath: snapshot.settings.dataPath, development: snapshot.settings.development, simulation: snapshot.settings.simulation };
    });
    assert.equal(observed.version, version); assert.equal(observed.dataPath, data);
    assert.equal(observed.development, false); assert.equal(observed.simulation, false);
    assert.equal(await app.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox')), false);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    for (const name of ['Voice', 'Memory', 'Connection & data']) { await page.getByRole('tab', { name, exact: true }).click(); if (name === 'Memory') await page.locator('.current-memory').waitFor(); }
    await page.keyboard.press('Escape');
    assert.equal(await app.evaluate(() => globalThis.deliveryRequests), 0);
    const exited = new Promise(done => app.process().once('exit', done));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await exited; app = null;
    assert.deepEqual(errors, []);
    assert.deepEqual(py('print(json.dumps(inventory(Path(sys.argv[1]))))', report.source), report.baseline);
    report.normalLaunches.push(observed);
  }
  for (const entry of report.entries) execFileSync('desktop-file-validate', [entry]);
  report.status = 'delivered_and_verified'; report.modelRequests = 0; report.archiveSha256 = audit.sha256; save();
  writeFileSync('test-results/release-audit.json', JSON.stringify(audit, null, 2) + '\n');
} catch (error) {
  report.status = 'switched_needs_attention'; report.failure = String(error); save(); throw error;
} finally { await app?.close().catch(() => undefined); }
// Failed delivery never prunes. A pruning failure leaves the verified delivery
// and both restore sets intact for inspection; it does not relabel the release.
execFileSync('python3', ['scripts/prune-artifacts.py', '--backup', report.backup, '--archive', audit.archive, '--apply'], { stdio: 'inherit' });
py("report=json.loads(Path(sys.argv[1]).read_text());old=Path(report['priorInstalled']);assert files(old)==report['priorFiles'];assert files(Path(report['backup'])/report['backupBundle'])==report['priorFiles'];shutil.rmtree(old);print(json.dumps({'retiredInstallationRemoved':True}))", resolve(reportPath));
console.log(JSON.stringify({ status: report.status, version, backup: report.backup, normalOpens: report.normalLaunches.length, modelRequests: 0 }));
