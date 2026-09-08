import type Database from 'better-sqlite3';
import type { Json, Message, Session } from '../shared/types';
import type { MemoryAttempt, MemoryDocument, MemoryJob, MemoryPacket, MemoryView } from '../shared/memory';
import { readMessageTime } from './time-context';
import { AppFailure } from './errors';
import { memoryChanges } from './memory-history';
import { applyMemory, memoryBody, memoryConfig, memoryHash, memoryJson, memoryLimits, memoryVersion, sharedMemoryVersion, sharedMemoryId, sharedUpdaterVersion, memorySupported, validateMemory } from './memory-updater';

const now = () => new Date().toISOString();
function fail(code: string): never { throw new AppFailure('memory_' + code); }
export class MemoryStore {
  constructor(private db: Database.Database, private synchronized?: (sessionId: string, before: MemoryDocument, after: MemoryDocument) => void) {}
  private row<T>(sql: string, ...args: any[]) { return this.db.prepare(sql).get(...args) as T | undefined; }
  private run(sql: string, ...args: any[]) { return this.db.prepare(sql).run(...args); }
  load(): MemoryDocument {
    const saved = this.row<{ document: string; document_hash: string }>('SELECT * FROM shared_memory WHERE id=1');
    if (!saved) fail('shared_missing');
    if (memoryHash(saved.document) !== saved.document_hash) fail('document_hash');
    const doc = JSON.parse(saved.document); validateMemory(doc);
    if (doc.character_id !== sharedMemoryId) fail('character_mismatch');
    return doc;
  }
  snapshot(session: Session): MemoryDocument | null {
    if (!memorySupported(JSON.parse(session.chat_config).memory_version)) return null;
    if (!session.character) return null;
    const saved = this.row<{ document: string; document_hash: string; character_id: string }>('SELECT * FROM session_memories WHERE session_id=?', session.id);
    if (saved) {
      if (memoryHash(saved.document) !== saved.document_hash || saved.character_id !== session.character) fail('snapshot_changed');
      const doc = JSON.parse(saved.document); validateMemory(doc);
      if (doc.character_id !== (JSON.parse(session.chat_config).memory_version === sharedMemoryVersion ? sharedMemoryId : session.character)) fail('character_mismatch');
      return doc;
    }
    if (session.state === 'ended') return null;
    const doc = this.load();
    // Historical conversation contracts retain their original wrapper and ownership field.
    if (JSON.parse(session.chat_config).memory_version !== sharedMemoryVersion) doc.character_id = session.character;
    const encoded = memoryJson(doc);
    this.run('INSERT INTO session_memories VALUES(?,?,?,?)', session.id, session.character, encoded, memoryHash(encoded));
    return doc;
  }
  freeze(session: Session, messages: Message[]) {
    if (!memorySupported(JSON.parse(session.chat_config).memory_version) || !session.character || !messages.some(m => m.role === 'user' && m.origin === 'learner' && m.delivery === 'complete')) return;
    const temporal = [memoryVersion, sharedMemoryVersion].includes(JSON.parse(session.chat_config).memory_version);
    const source = memoryJson({ id: session.id, character_id: session.character, ended_at: session.ended_at,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      messages: messages.map(({ id, role, origin, delivery, content }) => {
        const sent_time = temporal && role === 'user' && origin === 'learner' && delivery === 'complete' ? readMessageTime(this.db, id) : null;
        if (temporal && role === 'user' && origin === 'learner' && !sent_time) fail('source_time');
        return { id, role, origin, delivery, content, sent_time };
      }) });
    const config = memoryJson(memoryConfig(sharedUpdaterVersion));
    this.run("INSERT INTO memory_jobs(session_id,character_id,source,source_hash,config,config_hash,created_at,state) VALUES(?,?,?,?,?,?,?,'pending')", session.id, session.character, source, memoryHash(source), config, memoryHash(config), now());
  }
  job(sessionId: string) { return this.row<MemoryJob>('SELECT * FROM memory_jobs WHERE session_id=?', sessionId) ?? null; }
  attempt(id: string) { return this.row<MemoryAttempt>('SELECT * FROM memory_attempts WHERE id=?', id) ?? fail('attempt_missing'); }
  attempts(jobId: number) { return this.db.prepare('SELECT * FROM memory_attempts WHERE job_id=? ORDER BY rowid').all(jobId) as MemoryAttempt[]; }
  private blocker(job: MemoryJob) {
    return this.row<{ session_id: string }>("SELECT session_id FROM memory_jobs WHERE ordinal<? AND state NOT IN ('completed','skipped') ORDER BY ordinal LIMIT 1", job.ordinal)?.session_id ?? null;
  }
  ready(ids: string[]): string | null {
    if (!ids.length) return null;
    for (const row of this.db.prepare("SELECT * FROM memory_jobs WHERE state='pending' ORDER BY ordinal").all() as MemoryJob[]) if (ids.includes(row.session_id) && !this.blocker(row)) return row.session_id;
    return null;
  }
  retry(sessionId: string) {
    this.db.transaction(() => {
      const job = this.job(sessionId);
      if (!job || !['pending', 'failed', 'interrupted'].includes(job.state)) fail('not_retryable');
      if (this.blocker(job!)) fail('waiting_for_earlier_session');
      this.run("UPDATE memory_jobs SET state='pending' WHERE ordinal=?", job!.ordinal);
    })();
  }
  skip(sessionId: string) {
    this.db.transaction(() => {
      const job = this.job(sessionId);
      if (job?.state === 'skipped') return;
      if (!job || !['pending', 'failed', 'interrupted'].includes(job.state)) fail('not_skippable');
      this.run("UPDATE memory_jobs SET state='skipped' WHERE ordinal=?", job!.ordinal);
    })();
  }
  prepare(sessionId: string, id: string): MemoryAttempt {
    return this.db.transaction(() => {
      const previous = this.row<MemoryAttempt>('SELECT * FROM memory_attempts WHERE id=?', id);
      const job = this.job(sessionId);
      if (previous) { if (previous.job_id !== job?.ordinal) fail('duplicate_job'); return previous; }
      if (!job || job.state !== 'pending' || this.blocker(job)) fail('not_ready');
      if (memoryHash(job.source) !== job.source_hash || memoryHash(job.config) !== job.config_hash) fail('source_changed');
      if (JSON.parse(job.config).version !== sharedUpdaterVersion) fail('legacy_job_requires_resolution');
      const older = this.attempts(job.ordinal).at(-1);
      const packet: MemoryPacket = older ? JSON.parse(older.input_json) : { current_memory: this.load(), session: JSON.parse(job.source), limits: { ...memoryLimits } };
      if (packet.session.id !== sessionId || memoryJson(packet.session) !== job.source || memoryJson(packet.current_memory) !== memoryJson(this.load())) fail('stale_input');
      const input = memoryJson(packet); if (older && memoryHash(input) !== older.input_hash) fail('input_changed');
      this.run("INSERT INTO memory_attempts(id,job_id,parent_id,input_json,input_hash,status,created_at) VALUES(?,?,?,?,?,'queued',?)", id, job.ordinal, older?.id ?? null, input, memoryHash(input), now());
      this.run("UPDATE memory_jobs SET state='running' WHERE ordinal=?", job.ordinal);
      return this.attempt(id);
    })();
  }
  dispatch(id: string) {
    if (this.attempt(id).status === 'dispatched') return;
    if (this.run("UPDATE memory_attempts SET status='dispatched',dispatched_at=? WHERE id=? AND status='queued'", now(), id).changes !== 1) fail('not_queued');
  }
  save(id: string, content: string, metadata: Json): MemoryDocument {
    return this.db.transaction(() => {
      const attempt = this.attempt(id);
      const job = this.row<MemoryJob>('SELECT * FROM memory_jobs WHERE ordinal=?', attempt.job_id)!;
      if (attempt.status === 'succeeded' && job.selected_attempt_id === id && attempt.response_content === content) return JSON.parse(attempt.result!);
      if (attempt.status !== 'dispatched' || job.state !== 'running' || this.blocker(job)) fail('already_resolved');
      if (memoryHash(attempt.input_json) !== attempt.input_hash || memoryHash(job.source) !== job.source_hash || memoryHash(job.config) !== job.config_hash) fail('source_changed');
      const packet: MemoryPacket = JSON.parse(attempt.input_json);
      if (packet.session.id !== job.session_id || packet.session.character_id !== job.character_id || memoryJson(packet.session) !== job.source || memoryJson(packet.current_memory) !== memoryJson(this.load())) fail('stale_input');
      memoryBody(JSON.parse(job.config), packet);
      const doc = applyMemory(packet, content, true), encoded = memoryJson(doc);
      this.run('UPDATE shared_memory SET document=?,document_hash=? WHERE id=1', encoded, memoryHash(encoded));
      this.synchronized?.(job.session_id, packet.current_memory, doc);
      this.run("UPDATE memory_attempts SET status='succeeded',finished_at=?,response_content=?,result=?,metadata=? WHERE id=?", now(), content, encoded, JSON.stringify(metadata), id);
      this.run("UPDATE memory_jobs SET state='completed',selected_attempt_id=? WHERE ordinal=?", id, job.ordinal);
      return doc;
    })();
  }
  fail(id: string, failure: string, content: string | null, metadata: Json, interrupted = false) {
    this.db.transaction(() => {
      const attempt = this.attempt(id);
      if (!['queued', 'dispatched'].includes(attempt.status)) return;
      const state = interrupted ? 'interrupted' : 'failed';
      this.run('UPDATE memory_attempts SET status=?,finished_at=?,failure=?,response_content=?,metadata=? WHERE id=?', state, now(), failure, content, JSON.stringify(metadata), id);
      this.run('UPDATE memory_jobs SET state=? WHERE ordinal=?', state, attempt.job_id);
    })();
  }
  recover() {
    this.run("UPDATE memory_attempts SET status='interrupted',failure=CASE WHEN status='queued' THEN 'queued_not_dispatched' ELSE 'interrupted_unknown_outcome' END,finished_at=? WHERE status IN ('queued','dispatched')", now());
    this.run("UPDATE memory_jobs SET state='interrupted' WHERE state='running'");
  }
  view(session: Session): MemoryView {
    const saved = this.row<{ document: string }>('SELECT document FROM session_memories WHERE session_id=?', session.id);
    const job = this.job(session.id);
    return { current: this.load(),
      changes: job ? memoryChanges(job, job.state === 'completed' && job.selected_attempt_id
        ? this.row<MemoryAttempt>('SELECT * FROM memory_attempts WHERE id=?', job.selected_attempt_id) : undefined) : null,
      snapshot: saved ? JSON.parse(saved.document) : null,
      job: job ? { state: job.state, created_at: job.created_at, character_id: job.character_id } : null,
      blockedBy: job ? this.blocker(job) : null,
      attempts: job ? this.attempts(job.ordinal).map(({ input_json, response_content, result, ...rest }) => rest) : [] };
  }
}
