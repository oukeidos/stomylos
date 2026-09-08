// Read-only packaged acceptance of the private, externally converted data copy.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve('test-results/shared-memory-copy');
const file = join(root, 'stomylos.sqlite3');
const archive = join(root, 'backups', readdirSync(join(root, 'backups')).find(n => n.startsWith('shared-memory-v9-')));
const conversion = JSON.parse(readFileSync(join(archive, 'manifest.json'), 'utf8'));
export const inventoryPython = String.raw`
import sqlite3,json,hashlib,sys
from pathlib import Path
def digest(value): return hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
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
const inventory = path => JSON.parse(execFileSync('python3', ['-c', inventoryPython + '\nprint(json.dumps(inventory(sys.argv[1])))', path], { encoding: 'utf8' }));
const original = inventory(join(archive, 'before-v8.sqlite3')), before = inventory(file);
assert.equal(before.version, 9);
for (const [table, rows] of Object.entries(original.tables)) assert.deepEqual(before.tables[table], rows, table);
assert.equal(before.tables.shared_memory.count, 1); assert.deepEqual(before.sessions, original.sessions);
const env = { ...process.env, HOME: mkdtempSync('/tmp/stomylos-shared-copy-home-'), STOMYLOS_DATA_DIR: root };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_TEST_ENDPOINT', 'STOMYLOS_PACKAGED_TEST', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
const executablePath = resolve('release/shared-memory-candidate/linux-unpacked/stomylos');
let app; const errors = [], passes = [];
try {
  for (let i = 0; i < 2; i++) {
    app = await electron.launch({ executablePath, env, chromiumSandbox: true, timeout: 30000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const result = await page.evaluate(async ids => {
      const snapshot = await window.stomylos.command('snapshot');
      const views = await Promise.all(ids.map(sessionId => window.stomylos.command('loadSession', { sessionId })));
      const first = JSON.stringify(views[0].memory.current);
      if (!views.every(v => JSON.stringify(v.memory.current) === first)) throw new Error('Memories differ between models');
      if (views.some(v => v.memory.current.character_id !== 'shared')) throw new Error('Missing shared ownership');
      return { version: snapshot.settings.appVersion, keyPresent: snapshot.settings.keyPresent, sessions: views.length,
        items: ['traits', 'relationships', 'experiences', 'intentions'].reduce((n, c) => n + views[0].memory.current[c].length, 0) };
    }, Object.keys(before.sessions));
    assert.equal(result.version, '0.15.0'); assert.equal(result.keyPresent, false);
    assert.equal(result.items, conversion.merge.sharedItems); passes.push(result);
    await page.getByRole('button', { name: 'More options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Conversation details', exact: true }).click();
    await page.getByRole('button', { name: /^Shared memory/ }).click();
    await page.getByText('All partners use the same shared memory.', { exact: false }).waitFor();
    await page.keyboard.press('Escape');
    const exited = new Promise(r => app.process().once('exit', r)); await page.evaluate(() => window.stomylos.command('close')); await exited; app = null;
    assert.deepEqual(inventory(file), before, 'Reading/closing the copy must not change database rows');
  }
  assert.deepEqual(errors, []);
  const report = { status: 'passed', source: JSON.parse(readFileSync(join(root, 'source.json'), 'utf8')), copy: file, archive,
    baseline: original, converted: before, merge: conversion.merge, passes, errors, modelRequests: 0 };
  writeFileSync('test-results/shared-memory-copy-acceptance.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, sessions: passes[0].sessions, originalRows: Object.values(original.tables).reduce((n, x) => n + x.count, 0), merge: report.merge, opens: passes.length, modelRequests: 0 }));
} finally { if (app) await app.close(); }
