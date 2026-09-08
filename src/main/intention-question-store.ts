import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { IntentionAttempt, IntentionJob, IntentionView } from '../shared/intention';
import type { MemoryDocument } from '../shared/memory';
import type { Json } from '../shared/types';
import { hash } from './contracts';
import { AppFailure } from './errors';
import { intentionBody, intentionConfig, intentionDiff, intentionFallback, intentionPolicy, parseIntentionQuestion } from './intention-questions';
import type { StarterStore } from './starter-store';

const now = () => new Date().toISOString();
type Item = { item_id: string; epoch: number; text: string | null; text_hash: string | null; last_question: string | null };
export class IntentionQuestionStore {
  constructor(private db: Database.Database, private starter: StarterStore) {}
  private rows<T>(sql: string, ...args: any[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  private run(sql: string, ...args: any[]) { return this.db.prepare(sql).run(...args); }
  job(id: string) { const job = this.rows<IntentionJob>('SELECT * FROM intention_question_jobs WHERE id=?', id)[0]; if (!job) throw new AppFailure('intention_job_missing'); return job; }
  jobs(sessionId: string) { return this.rows<IntentionJob>('SELECT * FROM intention_question_jobs WHERE session_id=? ORDER BY rowid', sessionId); }
  attempts(jobId: string) { return this.rows<IntentionAttempt>('SELECT * FROM intention_question_attempts WHERE job_id=? ORDER BY rowid', jobId); }
  private item(id: string) { return this.rows<Item>('SELECT * FROM intention_question_state WHERE item_id=?', id)[0]; }
  current(job: IntentionJob) { const item = this.item(job.item_id); return !!item?.text && item.epoch === job.epoch && item.text_hash === job.text_hash; }
  // Called inside the same transaction that commits the shared-memory update.
  synchronize(sessionId: string, before: MemoryDocument, after: MemoryDocument) {
    const changes = intentionDiff(before.intentions, after.intentions);
    for (const item of after.intentions) if (!this.item(item.id) && !changes.some(c => c.id === item.id)) changes.push({ id: item.id, previous: null, text: item.text });
    for (const change of changes) {
      const prior = this.item(change.id), epoch = (prior?.epoch ?? 0) + 1;
      this.starter.invalidateIntention(change.id);
      this.run("UPDATE intention_question_attempts SET status='interrupted',finished_at=?,failure='superseded' WHERE job_id IN (SELECT id FROM intention_question_jobs WHERE item_id=?) AND status IN ('dispatched','received')", now(), change.id);
      this.run("UPDATE intention_question_jobs SET state='superseded' WHERE item_id=? AND state IN ('pending','running','received','failed','interrupted')", change.id);
      this.run(`INSERT INTO intention_question_state(item_id,epoch,text,text_hash,last_question) VALUES(?,?,?,?,?)
        ON CONFLICT(item_id) DO UPDATE SET epoch=excluded.epoch,text=excluded.text,text_hash=excluded.text_hash`, change.id, epoch, change.text, change.text === null ? null : hash(change.text), prior?.last_question ?? null);
      if (change.text === null) continue;
      const input = JSON.stringify(change.previous && prior?.last_question
        ? { operation: 'update', previous_intention: change.previous, intention: change.text, existing_question: prior.last_question }
        : { operation: 'add', intention: change.text });
      const config = JSON.stringify(intentionConfig()), time = now();
      this.run(`INSERT INTO intention_question_jobs(id,item_id,epoch,text_hash,session_id,input_json,input_hash,config,config_hash,created_at,deadline,state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending')`, randomUUID(), change.id, epoch, hash(change.text), sessionId, input, hash(input), config, hash(config), time, new Date(Date.now() + intentionPolicy.batchMs).toISOString());
    }
  }
  dispatch(id: string, attemptId: string): IntentionAttempt | null {
    return this.db.transaction(() => {
      const previous = this.rows<IntentionAttempt>('SELECT * FROM intention_question_attempts WHERE id=?', attemptId)[0];
      if (previous) { if (previous.job_id !== id) throw new AppFailure('intention_attempt_conflict'); return previous; }
      const job = this.job(id);
      if (!this.current(job) || job.state !== 'pending') return null;
      if (Date.parse(job.deadline) <= Date.now()) { this.expire(job.session_id!); return null; }
      if (hash(job.input_json) !== job.input_hash || hash(job.config) !== job.config_hash) throw new AppFailure('intention_source_changed');
      const route = this.attempts(id).filter(a => a.run === job.run).length;
      intentionBody(JSON.parse(job.config), job.input_json, route);
      this.run("INSERT INTO intention_question_attempts(id,job_id,run,route,status,dispatched_at) VALUES(?,?,?,?,'dispatched',?)", attemptId, id, job.run, route, now());
      this.run("UPDATE intention_question_jobs SET state='running' WHERE id=?", id);
      return this.attempts(id).at(-1)!;
    })();
  }
  receive(id: string, content: string, metadata: Json) {
    this.db.transaction(() => {
      const a = this.rows<IntentionAttempt>('SELECT * FROM intention_question_attempts WHERE id=?', id)[0];
      if (!a) throw new AppFailure('intention_attempt_missing');
      if (['received', 'succeeded'].includes(a.status) && a.response_content === content) return;
      if (a.status !== 'dispatched') {
        // A superseding memory commit can arrive before the provider response.
        // Retain any returned usage without reviving the cancelled work.
        if (a.status === 'interrupted' && a.response_content === null) this.run('UPDATE intention_question_attempts SET response_content=?,metadata=? WHERE id=?', content, JSON.stringify(metadata), id);
        return;
      }
      const job = this.job(a.job_id);
      if (!this.current(job) || Date.parse(job.deadline) <= Date.now()) {
        this.run("UPDATE intention_question_attempts SET status='interrupted',finished_at=?,response_content=?,metadata=?,failure='stale_or_expired' WHERE id=?", now(), content, JSON.stringify(metadata), id);
        this.run("UPDATE intention_question_jobs SET state=? WHERE id=?", this.current(job) ? 'interrupted' : 'superseded', job.id); return;
      }
      parseIntentionQuestion(content);
      this.run("UPDATE intention_question_attempts SET status='received',finished_at=?,response_content=?,metadata=? WHERE id=?", now(), content, JSON.stringify(metadata), id);
      this.run("UPDATE intention_question_jobs SET state='received' WHERE id=?", job.id);
    })();
  }
  accept(id: string) {
    this.db.transaction(() => {
      const job = this.job(id); if (job.state !== 'received' || !this.current(job)) return;
      const attempt = this.attempts(id).find(a => a.status === 'received'); if (!attempt) throw new AppFailure('intention_response_missing');
      const text = parseIntentionQuestion(attempt.response_content!);
      const saved = this.starter.insertIntention(id, text);
      this.run("UPDATE intention_question_attempts SET status='succeeded' WHERE id=?", attempt.id);
      this.run('UPDATE intention_question_jobs SET state=?,question_id=? WHERE id=?', saved.duplicate ? 'duplicate' : 'accepted', saved.id, id);
      this.run('UPDATE intention_question_state SET last_question=? WHERE item_id=? AND epoch=?', text, job.item_id, job.epoch);
    })();
  }
  fail(id: string, failure: string, content: string | null, metadata: Json, interrupted = false) {
    this.db.transaction(() => {
      const a = this.rows<IntentionAttempt>('SELECT * FROM intention_question_attempts WHERE id=?', id)[0]; if (!a) return;
      if (a.status !== 'dispatched') {
        if (a.status === 'interrupted' && a.response_content === null && (content !== null || Object.keys(metadata).length)) this.run('UPDATE intention_question_attempts SET response_content=?,metadata=? WHERE id=?', content, JSON.stringify(metadata), id);
        return;
      }
      const job = this.job(a.job_id);
      this.run('UPDATE intention_question_attempts SET status=?,finished_at=?,failure=?,response_content=?,metadata=? WHERE id=?', interrupted ? 'interrupted' : 'failed', now(), failure, content, JSON.stringify(metadata), id);
      const state = !this.current(job) ? 'superseded' : interrupted ? 'interrupted' : a.route < 2 && intentionFallback(failure) && Date.parse(job.deadline) > Date.now() ? 'pending' : 'failed';
      this.run('UPDATE intention_question_jobs SET state=? WHERE id=?', state, job.id);
    })();
  }
  expire(sessionId: string) {
    this.db.transaction(() => {
      const time = now();
      this.run("UPDATE intention_question_attempts SET status='interrupted',finished_at=?,failure='batch_deadline' WHERE status='dispatched' AND job_id IN (SELECT id FROM intention_question_jobs WHERE session_id=? AND deadline<=?)", time, sessionId, time);
      this.run("UPDATE intention_question_jobs SET state='interrupted' WHERE session_id=? AND state IN ('pending','running') AND deadline<=?", sessionId, time);
    })();
  }
  retry(sessionId: string) {
    this.db.transaction(() => {
      for (const job of this.jobs(sessionId)) if (this.current(job) && ['failed', 'interrupted'].includes(job.state)) {
        this.run("UPDATE intention_question_jobs SET state='pending',run=run+1,deadline=? WHERE id=?", new Date(Date.now() + intentionPolicy.batchMs).toISOString(), job.id);
      }
    })();
  }
  recover() {
    this.run("UPDATE intention_question_attempts SET status='interrupted',finished_at=?,failure='interrupted_unknown_outcome' WHERE status='dispatched'", now());
    this.run("UPDATE intention_question_jobs SET state='interrupted' WHERE state IN ('pending','running')");
    for (const job of this.rows<IntentionJob>("SELECT * FROM intention_question_jobs WHERE state='received'")) this.accept(job.id);
  }
  detach(sessionId: string) {
    this.run("UPDATE intention_question_attempts SET status='interrupted',finished_at=?,failure='source_deleted' WHERE status IN ('dispatched','received') AND job_id IN (SELECT id FROM intention_question_jobs WHERE session_id=?)", now(), sessionId);
    this.run("UPDATE intention_question_jobs SET state='superseded' WHERE session_id=? AND state IN ('pending','running','received','failed','interrupted')", sessionId);
  }
  view(sessionId: string): IntentionView {
    const p = this.starter.preparation(sessionId);
    return { preparation: p ? { state: p.state, reason: p.reason, deadline: p.deadline } : null,
      jobs: this.jobs(sessionId).map(job => ({ id: job.id, state: job.state, attempts: this.attempts(job.id).map(({ response_content: _, ...a }) => a) })) };
  }
}
