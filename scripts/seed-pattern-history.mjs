// Reconstruct v1 rows only in the native verifier's disposable DB while the app is closed.
import Database from 'better-sqlite3';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const [directory, ...ids] = process.argv.slice(2);
assert.ok(realpathSync(directory).startsWith('/tmp/stomylos-pattern-native-'));
const db = new Database(join(directory, 'stomylos.sqlite3'));
const hash = s => createHash('sha256').update(s).digest('hex');
const oldContract = JSON.parse(readFileSync('tests/fixtures/pattern-reports/contract-v1.json', 'utf8'));
try {
  for (const id of ids) {
    const report = db.prepare('SELECT * FROM pattern_reports WHERE id=?').get(id);
    const sources = db.prepare('SELECT * FROM pattern_report_sources WHERE report_id=? ORDER BY ordinal').all(id);
    const attempts = db.prepare('SELECT * FROM pattern_report_attempts WHERE report_id=? ORDER BY rowid').all(id);
    assert.equal(attempts.length, 1);
    const saved = JSON.parse(report.snapshot), body = JSON.parse(attempts[0].request);
    body.messages[0].content = readFileSync('tests/fixtures/pattern-reports/system-v1.txt', 'utf8');
    saved.contract = oldContract;
    saved.scope.estimate = Buffer.byteLength(JSON.stringify(body)) + 1024;
    report.snapshot = JSON.stringify(saved);
    report.fingerprint = hash(JSON.stringify({ sources: saved.sources, body,
      limits: { sessions:20, days:90, minimum:5, recurrence:3, input:20000, html:524288 },
      estimator:'utf8-request-plus-1024-v1', version:oldContract.version }));
    attempts[0].request = JSON.stringify(body); attempts[0].request_hash = hash(attempts[0].request);
    db.transaction(() => {
      db.prepare('DELETE FROM pattern_reports WHERE id=?').run(id);
      for (const [table, rows] of [['pattern_reports',[report]],['pattern_report_sources',sources],['pattern_report_attempts',attempts]]) {
        for (const row of rows) db.prepare(`INSERT INTO ${table} (${Object.keys(row)}) VALUES (${Object.keys(row).map(()=>'?')})`).run(...Object.values(row));
      }
    })();
  }
  assert.equal(db.pragma('integrity_check', {simple:true}), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
} finally { db.close(); }
