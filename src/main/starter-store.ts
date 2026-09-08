import type Database from 'better-sqlite3';
import { randomInt, randomUUID } from 'node:crypto';
import type { Json, Message, RenewalAttempt, RenewalJob, RenewalView, Session, Starter } from '../shared/types';
import { hash, isLearner, starters, transcriptJson } from './contracts';
import { AppFailure } from './errors';
import { intentionPolicy } from './intention-questions';
import type { StarterPreparation } from '../shared/intention';
import { sessionOpening } from './opening';
import { parseStarterQuestions, questionKey, selectStarter, starterBody, starterContext, starterPolicy, starterSnapshot, renewalV2, renewalV3, renewalV4, type SlotQuestion } from './starter-renewal';

const now = () => new Date().toISOString();
type Question = Starter & { normalized_text: string; state: string; created_at: string; expires_at: string | null };
type Skip = { operation_id: string; session_id: string; outgoing_id: string; outgoing_version: string;
  outgoing_text: string; normalized_text: string; incoming_id: string; created_at: string };

// Uses the Store's connection and worker; parent session mutations share its transaction.
export class StarterStore {
  constructor(private db: Database.Database, private pickGenerator: (n: number) => number = randomInt) {}
  private rows<T>(sql: string, ...args: any[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  private run(sql: string, ...args: any[]) { return this.db.prepare(sql).run(...args); }
  initialize() {
    const time = now();
    for (const [i, q] of starters.entries()) {
      this.run("INSERT INTO starter_questions(id,version,text,normalized_text,origin,state,created_at) VALUES(?,?,?,?,'seed','active',?)",
        q.id, q.version, q.text, questionKey(q.text), time);
      this.run('INSERT INTO starter_slots(slot,question_id,initialized_at) VALUES(?,?,?)', i + 1, q.id, time);
    }
  }
  verify() {
    const count = this.rows<{ n: number }>('SELECT COUNT(*) n FROM starter_slots')[0].n;
    const mismatch = this.rows("SELECT q.id FROM starter_questions q LEFT JOIN starter_slots s ON s.question_id=q.id WHERE (q.state='active')!=(s.slot IS NOT NULL)");
    if (count !== starterPolicy.slots || mismatch.length) throw new AppFailure('starter_pool_corrupt');
  }
  recover() {
    const time = now();
    this.run("UPDATE starter_renewal_attempts SET status='interrupted',failure='interrupted_unknown_outcome',finished_at=? WHERE status='dispatched'", time);
    this.run("UPDATE starter_renewal_jobs SET state='interrupted' WHERE state='running'");
    // Queued work remains durable and undispatched until an explicit user action.
  }
  slots(): SlotQuestion[] {
    return this.rows('SELECT q.id,q.version,q.text,s.slot,s.pending_since FROM starter_slots s JOIN starter_questions q ON q.id=s.question_id ORDER BY s.slot');
  }
  queue(): Question[] { return this.rows("SELECT * FROM starter_questions WHERE state='available' ORDER BY created_at,rowid"); }
  private session(id: string): Session {
    const session = this.rows<Session>('SELECT * FROM sessions WHERE id=?', id)[0];
    if (!session) throw new AppFailure('session_not_found');
    return session;
  }
  private reference(): Session | undefined {
    return this.rows<Session>("SELECT * FROM sessions ORDER BY (state!='ended') DESC,rowid DESC LIMIT 1")[0];
  }
  private used(reference?: Session): { question: string; ended_at: string }[] {
    return this.rows(`SELECT starter_text question,ended_at FROM sessions s WHERE state='ended' AND id!=?
      AND julianday(ended_at)<=julianday(?) AND opening_kind='starter'
      AND EXISTS(SELECT 1 FROM messages WHERE session_id=s.id AND origin='learner')
      AND (EXISTS(SELECT 1 FROM starter_events WHERE session_id=s.id AND kind='answered' AND question_id=s.starter_id)
        OR json_extract(s.chat_config,'$.opening') IS NULL)
      ORDER BY julianday(ended_at) DESC,s.rowid DESC LIMIT ?`, reference?.id ?? '', reference?.ended_at ?? now(), starterPolicy.usedLimit);
  }
  private skips(reference?: Session): Skip[] {
    const ids = this.rows<{ id: string }>(`SELECT id FROM sessions WHERE state='ended' AND id!=? AND julianday(ended_at)<=julianday(?)
      ORDER BY julianday(ended_at) DESC,rowid DESC LIMIT ?`, reference?.id ?? '', reference?.ended_at ?? now(), starterPolicy.skipSessions).map(s => s.id);
    if (reference) ids.push(reference.id);
    if (!ids.length) return [];
    return this.rows(`SELECT * FROM (SELECT *,rowid order_id,ROW_NUMBER() OVER(PARTITION BY session_id,normalized_text ORDER BY rowid DESC) occurrence
      FROM starter_skips WHERE session_id IN (${ids.map(() => '?').join(',')}) AND julianday(created_at)<=julianday(?))
      WHERE occurrence=1 ORDER BY order_id DESC LIMIT ?`, ...ids, reference?.ended_at ?? now(), starterPolicy.skipLimit);
  }
  private excluded(): Set<string> {
    const ref = this.reference();
    return new Set([...this.slots().map(q => questionKey(q.text)), ...this.used(ref).map(q => questionKey(q.question)),
      ...this.skips(ref).map(q => q.normalized_text), ...(ref?.starter_text ? [questionKey(ref.starter_text)] : [])]);
  }
  refill(): { expired: number; promoted: number; duplicate: number; evicted: number } {
    const time = now();
    const expired = this.run("UPDATE starter_questions SET state='expired',disposition_at=? WHERE state='available' AND julianday(expires_at)<=julianday(?)", time, time).changes;
    const pending = this.rows<{ slot: number; question_id: string }>('SELECT slot,question_id FROM starter_slots WHERE pending_since IS NOT NULL ORDER BY pending_since,slot');
    const excluded = this.excluded(); let promoted = 0; let duplicate = 0;
    for (const q of this.queue()) {
      if (excluded.has(q.normalized_text)) {
        this.run("UPDATE starter_questions SET state='duplicate',disposition_at=? WHERE id=?", time, q.id); duplicate++; continue;
      }
      const slot = pending.shift(); if (!slot) break;
      this.run("UPDATE starter_questions SET state='retired',disposition_at=? WHERE id=?", time, slot.question_id);
      this.run("UPDATE starter_questions SET state='active',disposition_at=? WHERE id=?", time, q.id);
      this.run('UPDATE starter_slots SET question_id=?,pending_since=NULL,pending_reason=NULL WHERE slot=? AND question_id=?', q.id, slot.slot, slot.question_id);
      excluded.add(q.normalized_text); promoted++;
    }
    const overflow = this.queue().slice(0, Math.max(0, this.queue().length - starterPolicy.queueLimit));
    for (const q of overflow) this.run("UPDATE starter_questions SET state='evicted',disposition_at=? WHERE id=?", time, q.id);
    this.verify(); return { expired, promoted, duplicate, evicted: overflow.length };
  }
  select(current?: string) {
    this.refill();
    const recent = this.rows<{ question_id: string }>("SELECT question_id FROM starter_events WHERE kind IN ('presented','replaced') ORDER BY rowid DESC LIMIT ?", starterPolicy.recentPresentations);
    return selectStarter(this.slots(), recent.map(r => r.question_id), current);
  }
  consume(id: string, reason: 'answered' | 'skipped') {
    const slot = this.rows<{ slot: number; pending_since: string | null }>('SELECT slot,pending_since FROM starter_slots WHERE question_id=?', id)[0];
    const created = !!slot && slot.pending_since === null;
    if (created) this.run('UPDATE starter_slots SET pending_since=?,pending_reason=? WHERE question_id=? AND pending_since IS NULL', now(), reason, id);
    return { slot: slot?.slot ?? null, created };
  }
  event(eventId: string, details: { slot: number | null; created?: boolean; fallback?: boolean; relaxed?: boolean }) {
    this.run('INSERT INTO starter_event_details VALUES(?,?,?,?,?)', eventId, details.slot, Number(!!details.created), Number(!!details.fallback), Number(!!details.relaxed));
  }
  previousSkip(operationId: string): Skip | undefined { return this.rows<Skip>('SELECT * FROM starter_skips WHERE operation_id=?', operationId)[0]; }
  saveSkip(operationId: string, session: Session, incoming: Starter) {
    this.run('INSERT INTO starter_skips VALUES(?,?,?,?,?,?,?,?)', operationId, session.id, session.starter_id, session.starter_version,
      session.starter_text, questionKey(session.starter_text!), incoming.id, now());
  }
  private packet(session: Session, messages: Message[]): Json {
    const since = this.rows<{ initialized_at: string }>('SELECT initialized_at FROM starter_slots ORDER BY slot LIMIT 1')[0].initialized_at;
    const kind = sessionOpening(session);
    return { session_context: starterContext(session.starter_text, messages, JSON.parse(session.chat_config).opening ? kind : undefined),
      active_questions: this.slots().map(({ id, version, text }) => ({ id, text, version })),
      just_used_question_id: kind === 'starter' && messages.some(isLearner) ? session.starter_id : null,
      recent_used_questions: this.used(session),
      recent_skips: this.skips(session).map(q => ({ question_id: q.outgoing_id, version: q.outgoing_version, question: q.outgoing_text, skipped_at: q.created_at, count: 1 })),
      skip_history_status: { status: 'observed_since_initialization', since, earlier_history: 'unavailable' },
      queued_candidates: this.queue().map(q => q.text) };
  }
  jobForSession(id: string): RenewalJob | null { return this.rows<RenewalJob>('SELECT * FROM starter_renewal_jobs WHERE session_id=?', id)[0] ?? null; }
  job(id: string): RenewalJob {
    const job = this.rows<RenewalJob>('SELECT * FROM starter_renewal_jobs WHERE id=?', id)[0];
    if (!job) throw new AppFailure('starter_job_not_found'); return job;
  }
  attempt(id: string): RenewalAttempt {
    const attempt = this.rows<RenewalAttempt>('SELECT * FROM starter_renewal_attempts WHERE id=?', id)[0];
    if (!attempt) throw new AppFailure('starter_attempt_not_found'); return attempt;
  }
  attempts(jobId: string): RenewalAttempt[] { return this.rows('SELECT * FROM starter_renewal_attempts WHERE job_id=? ORDER BY rowid', jobId); }
  view(sessionId: string): RenewalView | null {
    const job = this.jobForSession(sessionId); if (!job) return null;
    const attempts = this.attempts(job.id).map(({ response_content: _, ...attempt }) => attempt);
    return { id: job.id, state: job.state, model: job.model, created_at: job.created_at,
      accepted_count: attempts.find(a => a.id === job.selected_attempt_id)?.accepted_count ?? 0, attempts };
  }
  preparation(id: string) { return this.rows<StarterPreparation>('SELECT * FROM starter_preparations WHERE session_id=?', id)[0] ?? null; }
  prepare(session: Session, source: Message[]) {
    if (this.preparation(session.id) || this.jobForSession(session.id)) return;
    if (!source.some(isLearner) && !this.rows('SELECT 1 FROM starter_skips WHERE session_id=? LIMIT 1', session.id).length) return;
    const config = JSON.stringify(starterSnapshot(this.pickGenerator, JSON.parse(session.chat_config).time_version ? renewalV4 : JSON.parse(session.chat_config).opening ? renewalV2 : starterPolicy.version));
    this.run("INSERT INTO starter_preparations VALUES(?,?,?,?,?,?, 'waiting',NULL)", session.id, now(), new Date(Date.now() + intentionPolicy.preparationMs).toISOString(), session.source_hash, config, hash(config));
  }
  release(session: Session, source: Message[], reason: string) {
    const prepared = this.preparation(session.id);
    if (!prepared || prepared.state === 'released') return;
    if (prepared.source_hash !== session.source_hash || hash(prepared.config) !== prepared.config_hash) throw new AppFailure('starter_source_changed');
    this.freeze(session, source, JSON.parse(prepared.config));
    this.run("UPDATE starter_preparations SET state='released',reason=? WHERE session_id=?", reason, session.id);
  }
  insertIntention(jobId: string, text: string): { id: string; duplicate: boolean } {
    this.refill(); const excluded = this.excluded(); for (const q of this.queue()) excluded.add(q.normalized_text);
    const duplicate = excluded.has(questionKey(text)), id = randomUUID(), time = now();
    this.run(`INSERT INTO starter_questions(id,version,text,normalized_text,origin,intention_job_id,state,created_at,expires_at,disposition_at)
      VALUES(?,'stomylos_intention_questions_v1',?,?,'intention',?,?,?,?,?)`, id, text, questionKey(text), jobId,
      duplicate ? 'duplicate' : 'available', time, new Date(Date.now() + starterPolicy.queueDays * 86400000).toISOString(), duplicate ? time : null);
    this.refill(); return { id, duplicate };
  }
  invalidateIntention(itemId: string) {
    const live = this.rows<{ id: string; slot: number | null }>(`SELECT q.id,s.slot FROM starter_questions q
      JOIN intention_question_jobs j ON j.id=q.intention_job_id LEFT JOIN starter_slots s ON s.question_id=q.id
      WHERE j.item_id=? AND q.state IN ('active','available')`, itemId);
    // Retire every stale occupant first. Seed placeholders preserve non-null slots
    // within this transaction; normal FIFO refill then replaces them if possible.
    for (const q of live) {
      if (q.slot !== null) {
        const keys = new Set(this.slots().map(x => questionKey(x.text)));
        const seed = starters.find(x => !keys.has(questionKey(x.text)));
        if (!seed) throw new AppFailure('starter_pool_unavailable');
        const id = randomUUID(), time = now();
        this.run("INSERT INTO starter_questions(id,version,text,normalized_text,origin,state,created_at) VALUES(?,?,?,?,'seed','active',?)", id, seed.version, seed.text, questionKey(seed.text), time);
        this.run("UPDATE starter_slots SET question_id=?,pending_since=?,pending_reason='source_changed' WHERE slot=?", id, time, q.slot);
      }
      this.run("UPDATE starter_questions SET state='invalidated',disposition_at=? WHERE id=?", now(), q.id);
    }
    this.refill();
  }
  outdated(id: string | null): boolean {
    return !!id && !!this.rows(`SELECT 1 FROM starter_questions q JOIN intention_question_jobs j ON j.id=q.intention_job_id
      JOIN intention_question_state i ON i.item_id=j.item_id WHERE q.id=? AND (i.text IS NULL OR i.epoch!=j.epoch OR i.text_hash!=j.text_hash)`, id).length;
  }
  freeze(session: Session, source: Message[], selected?: Json) {
    if (session.state !== 'ended' || this.jobForSession(session.id)) return;
    if (!source.some(isLearner) && !this.rows('SELECT 1 FROM starter_skips WHERE session_id=? LIMIT 1', session.id).length) return;
    this.refill();
    const sourceHash = hash(transcriptJson(source));
    if (sourceHash !== session.source_hash) throw new AppFailure('frozen_source_changed');
    const snapshot = selected ?? starterSnapshot(this.pickGenerator, JSON.parse(session.chat_config).time_version ? renewalV4 : JSON.parse(session.chat_config).opening ? renewalV2 : starterPolicy.version); const config = JSON.stringify(snapshot);
    const input = JSON.stringify(this.packet(session, source)); starterBody(snapshot, input); const jobId = randomUUID();
    if (!source.length && snapshot.version !== renewalV2 && snapshot.version !== renewalV3 && snapshot.version !== renewalV4) throw new AppFailure('starter_source_changed');
    this.run(`INSERT INTO starter_renewal_jobs(id,session_id,created_at,source_sequence,source_hash,source_messages,input_json,input_hash,config,config_hash,model,state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending')`, jobId, session.id, now(), (source.at(-1)?.sequence ?? -1), sourceHash,
      JSON.stringify(source.map(m => ({ id: m.id, sequence: m.sequence, origin: m.origin, delivery: m.delivery }))), input, hash(input), config, hash(config), snapshot.parameters.model);
    this.newAttempt(jobId, randomUUID(), null);
  }
  private newAttempt(jobId: string, id: string, parent: string | null): RenewalAttempt {
    this.run("INSERT INTO starter_renewal_attempts(id,job_id,parent_id,status,created_at) VALUES(?,?,?,'queued',?)", id, jobId, parent, now());
    return this.attempt(id);
  }
  retry(sessionId: string, operationId: string): RenewalAttempt {
    return this.db.transaction(() => {
      const job = this.jobForSession(sessionId); if (!job) throw new AppFailure('starter_not_retryable');
      const previous = this.rows<RenewalAttempt>('SELECT * FROM starter_renewal_attempts WHERE id=?', operationId)[0];
      if (previous) {
        if (previous.job_id !== job.id) throw new AppFailure('starter_retry_conflict');
        return previous;
      }
      if (!['pending', 'failed', 'interrupted'].includes(job.state)) throw new AppFailure('starter_not_retryable');
      const last = this.attempts(job.id).at(-1)!;
      if (last.status === 'queued') return last;
      this.run("UPDATE starter_renewal_jobs SET state='pending' WHERE id=?", job.id);
      return this.newAttempt(job.id, operationId, last.id);
    })();
  }
  dispatch(id: string) {
    this.db.transaction(() => {
      const attempt = this.attempt(id); const job = this.job(attempt.job_id);
      if (job.state === 'running' && attempt.status === 'dispatched') return;
      if (job.state !== 'pending' || attempt.status !== 'queued') throw new AppFailure('starter_not_queued');
      this.verifySource(job);
      this.run("UPDATE starter_renewal_attempts SET status='dispatched',dispatched_at=? WHERE id=?", now(), id);
      this.run("UPDATE starter_renewal_jobs SET state='running' WHERE id=?", job.id);
    })();
  }
  private verifySource(job: RenewalJob) {
    const session = this.session(job.session_id);
    const messages = this.rows<Message>('SELECT * FROM messages WHERE session_id=? ORDER BY sequence', job.session_id);
    if (session.state !== 'ended' || session.source_hash !== job.source_hash || hash(transcriptJson(messages)) !== job.source_hash ||
        (messages.at(-1)?.sequence ?? -1) !== job.source_sequence || hash(job.config) !== job.config_hash || hash(job.input_json) !== job.input_hash) throw new AppFailure('starter_source_changed');
    if (!messages.length && ![renewalV2, renewalV3, renewalV4].includes(JSON.parse(job.config).version)) throw new AppFailure('starter_source_changed');
    starterBody(JSON.parse(job.config), job.input_json);
  }
  save(id: string, content: string, metadata: Json) {
    this.db.transaction(() => {
      const attempt = this.attempt(id); const job = this.job(attempt.job_id);
      if (attempt.status === 'succeeded' && job.selected_attempt_id === id && attempt.response_content === content) return;
      if (attempt.status !== 'dispatched' || job.state !== 'running' || job.selected_attempt_id !== null) throw new AppFailure('starter_already_resolved');
      this.verifySource(job); const questions = parseStarterQuestions(content);
      const before = this.refill(); const excluded = this.excluded();
      for (const q of this.queue()) excluded.add(q.normalized_text);
      const time = now(); const expiry = new Date(Date.now() + starterPolicy.queueDays * 86400_000).toISOString(); let accepted = 0;
      for (const [ordinal, text] of questions.entries()) {
        const key = questionKey(text); const duplicate = excluded.has(key); if (!duplicate) { accepted++; excluded.add(key); }
        this.run(`INSERT INTO starter_questions(id,version,text,normalized_text,origin,attempt_id,ordinal,state,created_at,expires_at,disposition_at)
          VALUES(?,'stomylos_generated_starters_v1',?,?,'generated',?,?,?,?,?,?)`, randomUUID(), text, key, id, ordinal,
          duplicate ? 'duplicate' : 'available', time, expiry, duplicate ? time : null);
      }
      const after = this.refill();
      const counts = Object.fromEntries(Object.keys(before).map(k => [k, before[k as keyof typeof before] + after[k as keyof typeof after]]));
      this.run(`UPDATE starter_renewal_attempts SET status='succeeded',finished_at=?,response_content=?,metadata=?,accepted_count=? WHERE id=?`,
        now(), content, JSON.stringify({ ...metadata, renewal: { ...counts, accepted, rejected_duplicates: 2 - accepted } }), accepted, id);
      this.run("UPDATE starter_renewal_jobs SET state='completed',selected_attempt_id=? WHERE id=?", id, job.id);
    })();
  }
  fail(id: string, failure: string, content: string | null = null, metadata: Json = {}, interrupted = false) {
    this.db.transaction(() => {
      const attempt = this.attempt(id);
      if (!['queued', 'dispatched'].includes(attempt.status)) return;
      const pending = attempt.dispatched_at === null && interrupted;
      this.run('UPDATE starter_renewal_attempts SET status=?,finished_at=?,failure=?,response_content=?,metadata=? WHERE id=?',
        interrupted ? 'interrupted' : 'failed', now(), failure, content, JSON.stringify(metadata), id);
      this.run('UPDATE starter_renewal_jobs SET state=? WHERE id=? AND selected_attempt_id IS NULL',
        pending ? 'pending' : interrupted ? 'interrupted' : 'failed', attempt.job_id);
    })();
  }
  inventory() {
    return { slots: this.slots(), queued: this.queue(),
      counts: this.rows<{ state: string; count: number }>('SELECT state,COUNT(*) count FROM starter_questions GROUP BY state'),
      events: this.rows<{ replacements: number; fallbacks: number; relaxed: number }>('SELECT COALESCE(SUM(replacement_created),0) replacements,COALESCE(SUM(fallback),0) fallbacks,COALESCE(SUM(repeat_relaxed),0) relaxed FROM starter_event_details')[0] };
  }
}
