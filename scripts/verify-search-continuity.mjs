// Explicit external preparation and read-only packaged acceptance. Never sends text.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), mode = process.argv[2];
const source = join(homedir(), '.local/share/io.github.oukeidos.stomylos/stomylos.sqlite3');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
const locationFile = 'test-results/search-copy-location.json';
if (mode === 'prepare') {
  const manifest = JSON.parse(execFileSync(require('electron'), ['scripts/convert-search.mjs', source, '--prepare-only'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }));
  assert.equal(manifest.status, 'prepared'); assert.equal(hash(source), manifest.source_sha256);
  const directory = mkdtempSync('/tmp/stomylos-search-copy-');
  copyFileSync(join(manifest.archive, 'verified-v8.sqlite3'), join(directory, 'stomylos.sqlite3'));
  save(locationFile, { directory, manifest });
  console.log(JSON.stringify({ status: 'prepared', directory, source_sha256: manifest.source_sha256, counts: manifest.counts }));
} else if (mode === 'copy' || mode === 'normal') {
  const location = read(locationFile), normal = mode === 'normal';
  const accepted = normal ? read('test-results/search-copy-acceptance.json') : null;
  if (normal) assert.equal(read('test-results/search-cutover-report.json').status, 'converted_and_switched');
  const executablePath = resolve(normal ? 'run.sh' : 'release/search-final/linux-unpacked/stomylos');
  const directory = normal ? source.slice(0, source.lastIndexOf('/')) : location.directory;
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'STOMYLOS_DATA_DIR', 'STOMYLOS_TEST_ENDPOINT', 'STOMYLOS_PACKAGED_TEST', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[name];
  if (!normal) env.STOMYLOS_DATA_DIR = directory;
  const passes = [], errors = []; let app, firstHash;
  try {
    for (let pass = 0; pass < 2; pass++) {
      app = await electron.launch({ executablePath, env, chromiumSandbox: true, timeout: 20000 });
      const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
      await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
      const state = await page.evaluate(async () => {
        const snapshot = await window.stomylos.command('snapshot'), views = [];
        for (let offset = 0;; offset += 40) {
          const list = await window.stomylos.command('listSessions', { offset });
          for (const session of list.sessions) views.push(await window.stomylos.command('loadSession', { sessionId: session.id }));
          if (!list.hasMore) break;
        }
        return { views, settings: snapshot.settings, reports: await window.stomylos.command('patternList', { offset: 0 }) };
      });
      assert.equal(state.settings.appVersion, version); assert.equal(state.settings.dataPath, directory);
      if (!normal) assert.equal(state.settings.keyPresent, false);
      assert.ok(state.views.every(v => v.session.search_mode === 'off' && !v.search && !(v.searches?.length)));
      const viewHash = createHash('sha256').update(JSON.stringify(state.views)).digest('hex');
      if (firstHash) assert.equal(viewHash, firstHash, 'History must survive clean reopen'); else firstHash = viewHash;
      if (accepted) assert.equal(viewHash, accepted.passes[0].view_sha256, 'Normal history must match accepted copy');
      await page.getByRole('button', { name: 'Web search: Off', exact: true }).waitFor();
      await page.getByRole('button', { name: 'More options', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Learning', exact: true }).click();
      await page.getByRole('heading', { name: 'Recent conversations', exact: true }).waitFor();
      passes.push({ version, sessions: state.views.length, view_sha256: viewHash, reports: state.reports.reports.length, keyPresent: state.settings.keyPresent });
      const exited = new Promise(r => app.process().once('exit', r));
      await page.evaluate(() => window.stomylos.command('close')); await exited; app = null;
    }
    assert.deepEqual(errors, []);
    const audit = JSON.parse(execFileSync('python3', ['-c', `
import sqlite3,json,sys
old=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
new=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True)
assert old.execute('pragma user_version').fetchone()[0]==7
assert new.execute('pragma user_version').fetchone()[0]==8
assert new.execute('pragma integrity_check').fetchone()[0]=='ok'
assert not new.execute('pragma foreign_key_check').fetchall()
counts={}
for (table,) in old.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
 q='SELECT rowid,* FROM "'+table+'" ORDER BY rowid'
 before=old.execute(q).fetchall();after=new.execute(q).fetchall()
 if table=='sessions':
  assert all(r[-1]=='off' for r in after)
  after=[r[:-1] for r in after]
 assert before==after, 'Original row changed in '+table
 counts[table]=len(before)
for table in ['search_turns','search_router_attempts','chat_search_context']:
 assert new.execute('SELECT count(*) FROM '+table).fetchone()[0]==0
print(json.dumps({'status':'passed','originalRows':sum(counts.values()),'counts':counts,'integrity':'ok','searchBackfill':0}))
`, join(location.manifest.archive, 'before-v7.sqlite3'), join(directory, 'stomylos.sqlite3')], { encoding: 'utf8' }));
    const report = { status: 'passed', directory, passes, audit, errors, inferenceActions: 0,
      bundle_sha256: hash(normal ? 'release/linux-unpacked/resources/app.asar' : 'release/search-final/linux-unpacked/resources/app.asar') };
    save(`test-results/search-${normal ? 'normal-launcher' : 'copy-acceptance'}.json`, report);
    console.log(JSON.stringify(report));
  } finally { if (app) await app.evaluate(({ app }) => app.exit()); }
} else throw new Error('Use prepare, copy, or normal explicitly');
