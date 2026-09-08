// Build synthetic historical rows from immutable public v1 prompt/contract fixtures.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const historicalPatternContract = JSON.parse(readFileSync('tests/fixtures/pattern-reports/contract-v1.json', 'utf8'));
export function makePatternHistorical(directory: string, id: string) {
  const db = new Database(join(directory, 'stomylos.sqlite3'));
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  try {
    const row = db.prepare('SELECT snapshot FROM pattern_reports WHERE id=?').get(id) as { snapshot: string };
    const saved = JSON.parse(row.snapshot);
    const a = db.prepare('SELECT id,request FROM pattern_report_attempts WHERE report_id=? ORDER BY rowid LIMIT 1').get(id) as { id: string; request: string };
    const body = JSON.parse(a.request);
    body.messages[0].content = readFileSync('tests/fixtures/pattern-reports/system-v1.txt', 'utf8');
    saved.contract = historicalPatternContract;
    const fingerprint = hash(JSON.stringify({ sources: saved.sources, body,
      limits: { sessions: 20, days: 90, minimum: 5, recurrence: 3, input: 20000, html: 524288 },
      estimator: 'utf8-request-plus-1024-v1', version: historicalPatternContract.version }));
    saved.scope.estimate = Buffer.byteLength(JSON.stringify(body)) + 1024;
    const request = JSON.stringify(body);
    const report = db.prepare('SELECT * FROM pattern_reports WHERE id=?').get(id) as Record<string, any>;
    const sources = db.prepare('SELECT * FROM pattern_report_sources WHERE report_id=?').all(id) as Record<string, any>[];
    const attempts = db.prepare('SELECT * FROM pattern_report_attempts WHERE report_id=? ORDER BY rowid').all(id) as Record<string, any>[];
    report.snapshot = JSON.stringify(saved); report.fingerprint = fingerprint;
    attempts[0].request = request; attempts[0].request_hash = hash(request);
    db.transaction(() => {
      db.prepare('DELETE FROM pattern_reports WHERE id=?').run(id);
      for (const [table, rows] of [['pattern_reports', [report]], ['pattern_report_sources', sources], ['pattern_report_attempts', attempts]] as const) {
        for (const row of rows) db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      }
    })();
    return { request, snapshot: JSON.stringify(saved), fingerprint };
  } finally { db.close(); }
}
