// Read-only source snapshot, explicit conversion of the copy, and packaged reopen.
// No normal data replacement, API key access, or inference is performed.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const source = join(homedir(), '.local/share/io.github.oukeidos.stomylos/stomylos.sqlite3');
mkdirSync('test-results', { recursive: true });
// One pending copy only. Resolve an unfinished run before replacing its evidence.
const directory = resolve('test-results/explain-copy');
mkdirSync(directory, { mode: 0o700 });
const file = join(directory, 'stomylos.sqlite3');
const python = String.raw`
import sqlite3,json,hashlib,sys,fcntl,os,shutil
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
`;
const py = (code, ...args) => JSON.parse(execFileSync('python3', ['-c', python + '\n' + code, ...args], { encoding: 'utf8' }));
const prepared = py(String.raw`
source=Path(sys.argv[1]);target=Path(sys.argv[2])
fd=os.open(source.parent/'stomylos.lock',os.O_RDONLY|os.O_NOFOLLOW);fcntl.lockf(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
for suffix in ['-wal','-shm','-journal']:
 p=Path(str(source)+suffix);assert not p.exists() or p.stat().st_size==0,'Source has uncheckpointed sidecars'
assert inventory(source)['version']==12
shutil.copy2(source,target);os.chmod(target,0o600)
assert sha(source)==sha(target)
print(json.dumps({'source_sha256':sha(source),'baseline':inventory(target)}));os.close(fd)
`, source, file);
const conversion = JSON.parse(execFileSync(require('electron'), ['scripts/convert-explain.mjs', file, '--expected-source-sha256', prepared.source_sha256], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8'
}));
const inventory = path => py('print(json.dumps(inventory(sys.argv[1])))', path);
const before = inventory(file); assert.equal(before.version, 13);
for (const [name, rows] of Object.entries(prepared.baseline.tables)) assert.deepEqual(before.tables[name], rows, name);
for (const name of ['explanations','explanation_attempts']) assert.equal(before.tables[name].count, 0);
const env = { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'stomylos-explain-copy-home-')), STOMYLOS_DATA_DIR: directory };
for (const name of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','STOMYLOS_TEST_ENDPOINT','STOMYLOS_PACKAGED_TEST','STOMYLOS_LIVE_VERIFY']) delete env[name];
const executablePath = resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/explain-candidate/linux-unpacked/stomylos');
let app; const errors = [], opens = [];
try {
  for (let i = 0; i < 2; i++) {
    app = await electron.launch({ executablePath, env, chromiumSandbox: true, timeout: 25000 });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const result = await page.evaluate(async ids => {
      const snapshot = await window.stomylos.command('snapshot');
      const views = await Promise.all(ids.map(sessionId => window.stomylos.command('loadSession', { sessionId })));
      if (views.some(v => v.partner.pending || v.partner.currentCharacter !== v.session.character || v.partner.currentModel !== v.session.model)) throw new Error('Historical partner identity changed');
      return { version: snapshot.settings.appVersion, keyPresent: snapshot.settings.keyPresent, sessions: views.length, requests: views.reduce((n,v) => n + v.requests.length, 0) };
    }, before.sessions);
    assert.equal(result.version, '0.20.0'); assert.equal(result.keyPresent, false); opens.push(result);
    const exited = new Promise(done => app.process().once('exit', done)); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await exited; app = null;
    assert.deepEqual(inventory(file), before, 'Opening the copied history must not change its rows');
  }
  assert.deepEqual(errors, []);
  const report = { status: 'passed', source, directory, conversion, baseline: prepared.baseline, converted: before, opens, errors, modelRequests: 0 };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  writeFileSync('test-results/explain-copy-acceptance.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: 'passed', originalRows: Object.values(prepared.baseline.tables).reduce((n,t) => n + t.count, 0), sessions: before.sessions.length, opens: opens.length, modelRequests: 0 }));
} finally { await app?.close().catch(() => undefined); }
