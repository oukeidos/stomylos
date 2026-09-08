import type Database from 'better-sqlite3';
/** Frozen transformation for the first public upgrade. Do not use current stores. */
export function migrate14Data(db: Database.Database) {
  const time = new Date().toISOString();
  const live = db.prepare("SELECT s.slot,q.id FROM starter_slots s JOIN starter_questions q ON q.id=s.question_id WHERE q.origin='intention'").all() as { slot: number; id: string }[];
  for (const { slot } of live) {
    const seed = db.prepare("SELECT version,text,normalized_text FROM starter_questions WHERE origin='seed' AND normalized_text NOT IN (SELECT q.normalized_text FROM starter_slots s JOIN starter_questions q ON q.id=s.question_id) ORDER BY rowid LIMIT 1").get() as { version: string; text: string; normalized_text: string } | undefined;
    if (!seed) throw new Error('migration_starter_seed_missing');
    const id = `migration14_seed_${slot}`;
    db.prepare("INSERT INTO starter_questions(id,version,text,normalized_text,origin,state,created_at) VALUES(?,?,?,?,'seed','active',?)").run(id, seed.version, seed.text, seed.normalized_text, time);
    db.prepare("UPDATE starter_slots SET question_id=?,pending_since=NULL,pending_reason=NULL WHERE slot=?").run(id, slot);
  }
  db.prepare("UPDATE starter_questions SET state='invalidated',disposition_at=? WHERE origin='intention' AND state IN ('active','available')").run(time);
  db.prepare("UPDATE intention_question_attempts SET status='interrupted',failure='feature_removed',finished_at=? WHERE status IN ('dispatched','received')").run(time);
  db.exec("UPDATE intention_question_jobs SET state='superseded' WHERE state IN ('pending','running','received','failed','interrupted')");
  // Preserve submitted openings; only an untouched parked proposal is retired.
  db.exec("UPDATE sessions SET parked_starter=NULL WHERE parked_starter IS NOT NULL AND json_extract(parked_starter,'$.question.id') IN (SELECT id FROM starter_questions WHERE origin='intention')");
  db.prepare(`INSERT INTO end_processing(session_id,created_at)
    SELECT id,? FROM sessions WHERE state='ended' AND (analysis_state IN ('pending','running','failed')
    OR id IN (SELECT session_id FROM memory_jobs WHERE state NOT IN ('completed','skipped'))
    OR id IN (SELECT session_id FROM starter_renewal_jobs WHERE state!='completed')
    OR id IN (SELECT session_id FROM starter_preparations WHERE state='waiting'))`).run(time);
  for (const stage of ['grammar','starter','update','cleanup']) db.prepare('INSERT INTO end_stage_state(session_id,stage) SELECT session_id,? FROM end_processing').run(stage);
}
