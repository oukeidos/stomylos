// Development-only cutover audit. It never prints conversation text or credentials.
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { openSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
const [directory, backupFile, nativeModule] = process.argv.slice(2);
const fd = openSync(join(directory, 'stomylos.lock'), constants.O_RDWR | constants.O_NOFOLLOW);
createRequire(import.meta.url)(nativeModule).lock(fd);
let previous; let current;
try {
  previous = new Database(backupFile, { readonly: true, fileMustExist: true });
  current = new Database(join(directory, 'stomylos.sqlite3'), { readonly: true, fileMustExist: true });
  for (const db of [previous, current]) {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) throw new Error('Cutover integrity check failed');
  }
  const tables = { sessions: ['id'], messages: ['id'], starter_events: ['id'], model_requests: ['id'], route_decisions: ['session_id'], grammar_units: ['analysis_attempt_id', 'source_message_id'] };
  if (previous.pragma('user_version', { simple: true }) === 2) Object.assign(tables, {
    starter_questions: ['id'], starter_slots: ['slot'], starter_skips: ['operation_id'],
    starter_renewal_jobs: ['id'], starter_renewal_attempts: ['id'], starter_event_details: ['event_id']
  });
  const counts = {}; let recoveredRequests = 0;
  for (const [table, keys] of Object.entries(tables)) {
    const before = previous.prepare(`SELECT * FROM ${table}`).all(); const after = current.prepare(`SELECT * FROM ${table}`).all();
    const identity = row => JSON.stringify(keys.map(key => row[key]));
    const lookup = new Map(after.map(row => [identity(row), row]));
    if (['model_requests', 'starter_renewal_jobs', 'starter_renewal_attempts'].includes(table) && before.length !== after.length) throw new Error('Startup created unexpected model work');
    for (const row of before) {
      const expected = { ...row }; const found = lookup.get(identity(row));
      if (!found) throw new Error(`A preserved ${table} record is missing`);
      if (table === 'model_requests' && ['queued', 'dispatched'].includes(row.status)) {
        expected.status = 'interrupted'; expected.failure = row.status === 'queued' ? 'queued_not_dispatched' : 'interrupted_unknown_outcome';
        if (typeof found.finished_at !== 'string' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(found.finished_at)) throw new Error('Recovery timestamp missing');
        expected.finished_at = found.finished_at; recoveredRequests++;
      }
      if (table === 'messages' && row.delivery === 'streaming') expected.delivery = 'interrupted';
      if (table === 'starter_renewal_attempts' && row.status === 'dispatched') {
        expected.status = 'interrupted'; expected.failure = 'interrupted_unknown_outcome'; expected.finished_at = found.finished_at;
        if (typeof found.finished_at !== 'string') throw new Error('Renewal recovery timestamp missing');
      }
      if (table === 'starter_renewal_jobs' && row.state === 'running') expected.state = 'interrupted';
      if (table === 'sessions' && row.analysis_state === 'running') {
        const last = previous.prepare("SELECT status FROM model_requests WHERE session_id=? AND role='grammar' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(row.id);
        expected.analysis_state = last?.status === 'queued' ? 'pending' : 'failed';
      }
      for (const field of Object.keys(expected)) if (expected[field] !== found[field]) throw new Error(`Preserved ${table}.${field} changed unexpectedly`);
    }
    counts[table] = { before: before.length, after: after.length };
  }
  console.log(JSON.stringify({ status: 'passed', counts, recoveredRequests, integrity: 'ok', foreignKeys: 'ok', automaticRequests: 0 }));
} finally { previous?.close(); current?.close(); closeSync(fd); }
