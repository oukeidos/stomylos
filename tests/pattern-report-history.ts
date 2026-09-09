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
    saved.sources = saved.sources.map((s: any) => {
      const session = db.prepare('SELECT selected_analysis_id FROM sessions WHERE id=?').get(s.session_id) as any;
      const units = (db.prepare('SELECT * FROM grammar_units WHERE session_id=? AND analysis_attempt_id=? ORDER BY ordinal').all(s.session_id, session.selected_analysis_id) as any[]).map(u => ({
        source_id: 'E-' + hash(JSON.stringify([s.session_id, session.selected_analysis_id, u.source_message_id])).slice(0,24),
        message_id: u.source_message_id, ordinal: u.ordinal, original: u.text, corrected: u.corrected_text, explanation: u.explanation }));
      return {session_id: s.session_id, analysis_id: session.selected_analysis_id, ended_at: s.ended_at, units, source_hash: hash(JSON.stringify(units))};
    }).reverse();
    const body = {...historicalPatternContract.parameters, messages: [{role:'system',content:''}, {role:'user',content: JSON.stringify({evidence_kind:'Stored compact conversation evidence; suggestions are unreviewed.', sessions: [...saved.sources].reverse().map((s:any)=>({session_id:s.session_id,ended_at:s.ended_at,units:s.units.map((u:any)=>({source_id:u.source_id,text:u.original,corrected_text:u.corrected,explanation:u.explanation}))}))})}]};
    body.messages[0].content = readFileSync('tests/fixtures/pattern-reports/system-v1.txt', 'utf8');
    saved.contract = historicalPatternContract;
    const fingerprint = hash(JSON.stringify({ sources: saved.sources, body,
      limits: { sessions: 20, days: 90, minimum: 5, recurrence: 3, input: 20000, html: 524288 },
      estimator: 'utf8-request-plus-1024-v1', version: historicalPatternContract.version }));
    saved.scope.estimate = Buffer.byteLength(JSON.stringify(body)) + 1024;
    const request = JSON.stringify(body);
    const report = db.prepare('SELECT * FROM pattern_reports WHERE id=?').get(id) as Record<string, any>;
    const sources = saved.sources.map((s:any,ordinal:number)=>({report_id:id,session_id:s.session_id,analysis_id:s.analysis_id,evidence_kind:'grammar',source_hash:s.source_hash,ordinal}));
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
