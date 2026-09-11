// Frozen schema-28 data transition. Do not import evolving memory reducers.
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
export function migrate28Data(db: Database.Database) {
  const digest = (s: string) => createHash('sha256').update(s).digest('hex');
  const saved = db.prepare('SELECT document,document_hash FROM shared_memory WHERE id=1').get() as {document:string;document_hash:string};
  if (!saved || digest(saved.document) !== saved.document_hash) throw new Error('memory_cutover_hash');
  const doc = JSON.parse(saved.document);
  if (!Array.isArray(doc.database_records)) throw new Error('memory_cutover_document');
  db.prepare('INSERT INTO memory_cutover_archive(id,document,document_hash,created_at) VALUES(1,?,?,?)').run(saved.document,saved.document_hash,new Date().toISOString());
  const count = () => Array.from(doc.database_records.map((r: {text:string}) => '- '+r.text.replace(/\r\n?/g,'\n').trim()).join('\n') || '- None recorded.').length;
  let removed = 0;
  while (count() > 4000) { doc.database_records.shift(); removed++; }
  if (removed) doc.revision++;
  const encoded = JSON.stringify(doc);
  db.prepare('UPDATE shared_memory SET document=?,document_hash=? WHERE id=1').run(encoded,digest(encoded));
  doc.database_records.forEach((r: {id:string},i:number) => db.prepare("INSERT INTO memory_item_metadata VALUES(?,0,?,NULL,NULL,NULL,'legacy')").run(r.id,removed+i));
  const jobs = db.prepare(`SELECT j.* FROM memory_jobs j WHERE j.state NOT IN ('completed','skipped') OR EXISTS
    (SELECT 1 FROM memory_candidates c WHERE c.session_id=j.session_id AND c.state NOT IN ('completed','cancelled'))`).all() as any[];
  for (const job of jobs) {
    const all = (sql:string) => db.prepare(sql).all(job.session_id);
    const evidence = {job,attempts:db.prepare('SELECT * FROM memory_attempts WHERE job_id=?').all(job.ordinal),
      candidates:all('SELECT * FROM memory_candidates WHERE session_id=?'),cleanup:all('SELECT * FROM memory_cleanup_attempts WHERE session_id=?'),
      responses:all("SELECT * FROM end_stage_state WHERE session_id=? AND stage IN ('update','cleanup')")};
    db.prepare('INSERT INTO memory_retired_jobs VALUES(?,?)').run(job.session_id,JSON.stringify(evidence));
    db.prepare("UPDATE memory_attempts SET status='interrupted',failure='retired_add_fifo' WHERE job_id=? AND status IN ('queued','dispatched')").run(job.ordinal);
    db.prepare("UPDATE memory_cleanup_attempts SET status='cancelled',failure='retired_add_fifo' WHERE session_id=? AND status IN ('queued','dispatched','received')").run(job.session_id);
    db.prepare("UPDATE memory_candidates SET state='cancelled' WHERE session_id=? AND state!='completed'").run(job.session_id);
    db.prepare("UPDATE memory_jobs SET state='skipped' WHERE ordinal=? AND state!='completed'").run(job.ordinal);
    db.prepare("UPDATE end_stage_state SET response_id=NULL,response_content=NULL,response_metadata=NULL WHERE session_id=? AND stage IN ('update','cleanup')").run(job.session_id);
  }
}
