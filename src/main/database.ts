import { flattenMemory } from './memory-flat';
import { currentSchema, inspectMigration, migrateDatabase } from './database-migrations';
import { ExplainStore } from './explain-store';
import type { ExplainTarget } from '../shared/explain';
import { PartnerStore } from './partner-store';
import { PatternReportStore } from './pattern-report-store';
import type { PatternStatus } from '../shared/pattern-report';
import Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { captureTime, readMessageTime, temporalHash, timeSources, validateTime } from './time-context';
import type { RecordedTime } from '../shared/time';
import { conversationBody, conversationRequestSnapshot, conversationSystem, requestPartner } from './contracts';
import { chmodSync, closeSync, constants, openSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import schema from './schema.sql?raw';
import type { OpeningKind, Json, Message, RequestRecord, Role, Session, SessionView, Starter, GrammarUnit, SessionPage, SessionSummary, HistoryFilter } from '../shared/types';
import { AppFailure } from './errors';
import { budget, character, chooseStarter, config, conversationSnapshot, sessionRuntime, routerSnapshot, eligible, grammarSnapshot, hash, isLearner, leastUsed, transcriptJson, validateGrammar, routerScores } from './contracts';
import { lockDirectory } from './storage';
import { StarterStore } from './starter-store';
import { IntentionQuestionStore } from './intention-question-store';
import { MemoryStore } from './memory-store';
import { emptyMemory, memoryJson, memoryHash, sharedMemoryId } from './memory-updater';
import { openingVersion, parkedStarter, sessionOpening, validateOpeningSource } from './opening';
import type { DeletionAssets } from '../shared/types';
import { SearchStore } from './search-store';
import type { SearchMode } from '../shared/search';

const now = () => new Date().toISOString();
const normalizeSql = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
function signature(db: Database.Database) {
  return db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    .map((r: any) => ({ ...r, sql: normalizeSql(r.sql) }));
}
export class Store {
  private db!: Database.Database;
  private unlock: () => void;
  private closed = false;
  private starter!: StarterStore;
  private memory!: MemoryStore;
  private intentions!: IntentionQuestionStore;
  private patterns!: PatternReportStore;
  private search!: SearchStore;
  private partners!: PartnerStore;
  private explanations!: ExplainStore;
  constructor(directory: string, nativePath: string, pickGenerator: (n: number) => number = randomInt, private clock: () => RecordedTime = captureTime, externallyLocked = false) {
    this.unlock = externallyLocked ? () => undefined : lockDirectory(directory, nativePath);
    try {
      const file = join(directory, 'stomylos.sqlite3');
      let existing = existsSync(file) && statSync(file).size > 0;
      if (existing) {
        const inspection = new Database(file, { readonly: true, fileMustExist: true });
        try {
          const empty = inspection.pragma('user_version', { simple: true }) === 0
            && inspection.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length === 0;
          if (empty) existing = false;
          else { inspectMigration(inspection); new StarterStore(inspection).verify(); new MemoryStore(inspection).load(); }
        } finally { inspection.close(); }
      }
      const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      closeSync(fd); chmodSync(file, 0o600);
      this.db = new Database(file);
      if (existing) migrateDatabase(this.db, directory);
      this.starter = new StarterStore(this.db, pickGenerator);
      this.intentions = new IntentionQuestionStore(this.db, this.starter);
      this.memory = new MemoryStore(this.db);
      this.patterns = new PatternReportStore(this.db);
      this.search = new SearchStore(this.db);
      this.partners = new PartnerStore(this.db);
      this.explanations = new ExplainStore(this.db);
      this.db.pragma('busy_timeout = 3000');
      this.db.pragma('foreign_keys = ON');
      const version = this.db.pragma('user_version', { simple: true });
      if (version === 0 && this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length === 0) {
        this.db.transaction(() => {
          this.db.exec(schema); this.starter.initialize();
          const initial = memoryJson(flattenMemory(emptyMemory(sharedMemoryId)));
          this.run('INSERT INTO shared_memory VALUES(1,?,?)', initial, memoryHash(initial));
          this.db.pragma(`user_version = ${currentSchema}`);
        })();
      } else if (version !== currentSchema) throw new AppFailure('unsupported_schema_version');
      const expected = new Database(':memory:');
      try {
        expected.exec(schema);
        if (JSON.stringify(signature(expected)) !== JSON.stringify(signature(this.db))) throw new AppFailure('unsupported_schema_structure');
      } finally { expected.close(); }
      this.db.pragma('foreign_keys = ON'); this.db.pragma('synchronous = FULL');
      if (this.db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') throw new AppFailure('unexpected_journal_mode');
      this.memory.load();
      this.recover();
      this.starter.verify();
    } catch (e) { this.db?.close(); this.unlock(); throw e; }
  }
  private all<T>(sql: string, ...values: any[]): T[] { return this.db.prepare(sql).all(...values) as T[]; }
  private run(sql: string, ...values: any[]) { return this.db.prepare(sql).run(...values); }
  private transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  private recover() {
    this.transaction(() => {
      this.run("UPDATE model_requests SET status='interrupted',failure='interrupted_unknown_outcome',finished_at=? WHERE status='dispatched'", now());
      this.run("UPDATE model_requests SET status='interrupted',failure='queued_not_dispatched',finished_at=? WHERE status='queued'", now());
      this.run("UPDATE messages SET delivery='interrupted' WHERE delivery='streaming'");
      this.run("UPDATE sessions SET analysis_state=CASE WHEN (SELECT failure FROM model_requests WHERE session_id=sessions.id AND role='grammar' ORDER BY created_at DESC,rowid DESC LIMIT 1)='queued_not_dispatched' THEN 'pending' ELSE 'failed' END WHERE analysis_state='running'");
      this.starter.recover();
      this.memory.recover();
      // Dedicated Intention jobs are historical only. Release any legacy preparation locally.
      for (const row of this.all<{session_id: string}>("SELECT session_id FROM starter_preparations WHERE state='waiting'")) this.starter.release(this.session(row.session_id), this.messages(row.session_id), 'feature_removed');
      this.patterns.recover();
      this.search.recover();
      this.partners.recover();
      this.explanations.recover();
    });
  }
  explainPrepare(target: ExplainTarget) { return this.explanations.prepare(target); }
  explainList(id: string) { return this.explanations.list(id); }
  explainGet(id: string) { return this.explanations.get(id); }
  explainStart(id: string) { return this.explanations.start(id); }
  explainFinish(id: string, attempt: string, content: string | null, metadata: Json, failure: string | null) { return this.explanations.finish(id, attempt, content, metadata, failure); }
  sessions(): Session[] { return this.all('SELECT * FROM sessions ORDER BY created_at DESC,id DESC'); }
  pendingDeletions(): string[] { return this.all<{ session_id: string }>('SELECT session_id FROM session_deletions').map(row => row.session_id); }
  deletionAssets(id: string): DeletionAssets {
    return JSON.parse(this.all<{ assets: string }>('SELECT assets FROM session_deletions WHERE session_id=?', id)[0]?.assets ?? '{"speechKeys":[],"dictationIds":[]}');
  }
  finishDeletion(id: string) { this.run('DELETE FROM session_deletions WHERE session_id=?', id); }
  deleteSession(id: string, assets: DeletionAssets = { speechKeys: [], dictationIds: [] }) {
    this.transaction(() => {
      const session = this.all<Session>('SELECT * FROM sessions WHERE id=?', id)[0];
      if (!session) return; // Also safe after an acknowledged or lost-acknowledgement deletion.
      if (session.state !== 'ended') throw new AppFailure('delete_requires_ended');
      this.run('INSERT OR IGNORE INTO session_deletions VALUES(?,?,?)', id, now(), JSON.stringify(assets));
      // Cyclic selected-attempt and parent references are checked at commit, never disabled.
      this.db.pragma('defer_foreign_keys = ON');
      this.run(`UPDATE starter_questions SET origin='detached',attempt_id=NULL,ordinal=NULL WHERE attempt_id IN
        (SELECT a.id FROM starter_renewal_attempts a JOIN starter_renewal_jobs j ON j.id=a.job_id WHERE j.session_id=?)`, id);
      this.intentions.detach(id);
      this.run('DELETE FROM starter_event_details WHERE event_id IN (SELECT id FROM starter_events WHERE session_id=?)', id);
      this.run('DELETE FROM starter_renewal_attempts WHERE job_id IN (SELECT id FROM starter_renewal_jobs WHERE session_id=?)', id);
      this.run('DELETE FROM memory_attempts WHERE job_id IN (SELECT ordinal FROM memory_jobs WHERE session_id=?)', id);
      this.run('DELETE FROM message_times WHERE message_id IN (SELECT id FROM messages WHERE session_id=?)', id);
      this.search.delete(id);
      this.partners.delete(id);
      for (const table of ['grammar_units', 'route_decisions', 'starter_events', 'starter_skips', 'starter_renewal_jobs',
        'session_memories', 'memory_jobs', 'messages', 'model_requests', 'sessions']) this.run(`DELETE FROM ${table} WHERE ${table === 'sessions' ? 'id' : 'session_id'}=?`, id);
      this.memory.retireBridge();
      this.starter.verify();
    });
  }
  private summaryQuery() {
    return `SELECT id,state,starter_text,created_at,analysis_state,
      EXISTS(SELECT 1 FROM session_bookmarks WHERE session_id=sessions.id) bookmarked,
      EXISTS(SELECT 1 FROM messages WHERE session_id=sessions.id AND origin='learner') canBookmark,
      CASE WHEN opening_kind='starter' THEN starter_text ELSE COALESCE(
        (SELECT content FROM messages WHERE session_id=sessions.id AND origin='learner' ORDER BY sequence LIMIT 1),'New chat') END title FROM sessions`;
  }
  private summary(row: SessionSummary): SessionSummary {
    return { ...row, bookmarked: !!row.bookmarked, canBookmark: !!row.canBookmark };
  }
  sessionPage(offset = 0, filter: HistoryFilter = 'all'): SessionPage {
    if (!Number.isSafeInteger(offset) || offset < 0 || !['all', 'bookmarked'].includes(filter)) throw new AppFailure('invalid_command');
    return this.transaction(() => {
      const where = filter === 'bookmarked' ? ' WHERE EXISTS(SELECT 1 FROM session_bookmarks WHERE session_id=sessions.id)' : '';
      const query = () => this.all<SessionSummary>(`${this.summaryQuery()}${where} ORDER BY created_at DESC,id DESC LIMIT 41 OFFSET ?`, offset);
      let rows = query();
      if (!rows.length && offset) {
        const count = this.all<{ n: number }>(`SELECT COUNT(*) n FROM sessions${where}`)[0].n;
        offset = Math.max(0, Math.floor((count - 1) / 40) * 40); rows = query();
      }
      return { sessions: rows.slice(0, 40).map(row => this.summary(row)), hasMore: rows.length > 40, offset, filter };
    });
  }
  unfinished(): SessionSummary | null {
    const row = this.all<SessionSummary>(`${this.summaryQuery()} WHERE state!='ended'`)[0];
    return row ? this.summary(row) : null;
  }
  setSessionBookmark(id: string, bookmarked: boolean): boolean {
    return this.transaction(() => {
      this.session(id);
      if (typeof bookmarked !== 'boolean') throw new AppFailure('invalid_command');
      if (bookmarked) {
        if (!this.all("SELECT 1 FROM messages WHERE session_id=? AND origin='learner' LIMIT 1", id).length) throw new AppFailure('bookmark_requires_message');
        this.run('INSERT OR IGNORE INTO session_bookmarks(session_id) VALUES(?)', id);
      } else this.run('DELETE FROM session_bookmarks WHERE session_id=?', id);
      return bookmarked;
    });
  }
  session(id: string): Session {
    const found = this.all<Session>('SELECT * FROM sessions WHERE id=?', id)[0];
    if (!found) throw new AppFailure('session_not_found');
    return found;
  }
  messages(id: string, through?: number): Message[] {
    return this.all(`SELECT * FROM messages WHERE session_id=?${through === undefined ? '' : ' AND sequence<=?'} ORDER BY sequence`, id, ...(through === undefined ? [] : [through]));
  }
  requests(id: string): RequestRecord[] { return this.all('SELECT * FROM model_requests WHERE session_id=? ORDER BY created_at,rowid', id); }
  request(id: string): RequestRecord {
    const found = this.all<RequestRecord>('SELECT * FROM model_requests WHERE id=?', id)[0];
    if (!found) throw new AppFailure('request_not_found');
    return found;
  }
  units(id: string): GrammarUnit[] {
    return this.all('SELECT u.* FROM grammar_units u JOIN sessions s ON s.selected_analysis_id=u.analysis_attempt_id WHERE s.id=? ORDER BY u.ordinal', id);
  }
  view(id: string): SessionView { const session = this.session(id); return { session, endProcessing: this.endStatus(id), partner: this.partners.view(session, this.messages(id), this.requests(id)), bookmarked: !!this.all('SELECT 1 FROM session_bookmarks WHERE session_id=?', id).length, canBookmark: !!this.all("SELECT 1 FROM messages WHERE session_id=? AND origin='learner' LIMIT 1", id).length, messages: this.messages(id), requests: this.requests(id), units: this.units(id), renewal: this.starter.view(id), intentions: undefined, outdatedOpening: session.state === 'draft' && session.opening_kind === 'starter' && this.starter.outdated(session.starter_id), memory: this.memory.view(session), search: this.search.view(id), searches: this.search.history(id) }; }
  searchMode(id: string, mode: SearchMode) { this.transaction(() => this.search.setMode(this.session(id), this.messages(id), mode)); }
  searchView(id: string) { this.session(id); return this.search.view(id); }
  searchPrepare(id: string) { return this.search.prepare(id); }
  searchDispatch(id: string) { return this.search.dispatch(id); }
  searchFinish(id: string, content: string | null, metadata: Json, failure: string | null, interrupted = false) { return this.search.finish(id, content, metadata, failure, interrupted); }
  private event(id: string, kind: string, question: Starter) {
    const eventId = randomUUID();
    this.run('INSERT INTO starter_events VALUES(?,?,?,?,?,?,?)', eventId, id, kind, question.id, question.version, question.text, now());
    return eventId;
  }
  private insertStarter(id: string, question: Starter, messageId: string = randomUUID()) {
    this.run("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES(?,?,0,'assistant',?,'starter','complete')", messageId, id, question.text);
  }
  createSession(): Session {
    return this.transaction(() => {
      const active = this.all<Session>("SELECT * FROM sessions WHERE state!='ended'")[0];
      if (active) return active;
      if (this.endBlocker()) throw new AppFailure('end_processing_pending');
      const kind = this.all<{ kind: OpeningKind }>('SELECT kind FROM opening_preferences WHERE id=1')[0]?.kind;
      if (kind !== 'starter' && kind !== 'user') throw new AppFailure('unsupported_opening');
      const choice = kind === 'starter' ? this.starter.select() : null;
      const question = choice?.question; const id = randomUUID();
      this.run("INSERT INTO sessions(id,state,starter_id,starter_version,starter_text,created_at,chat_config,opening_kind,search_mode) VALUES(?,'draft',?,?,?,?,?,?,'auto')",
        id, question?.id ?? null, question?.version ?? null, question?.text ?? null, now(), JSON.stringify(conversationSnapshot(kind)), kind);
      if (question && choice) {
        this.insertStarter(id, question);
        this.starter.event(this.event(id, 'presented', question), { slot: question.slot, fallback: choice.fallback, relaxed: choice.relaxed });
      }
      return this.session(id);
    });
  }
  setOpening(id: string, operationId: string, expectedRevision: number, kind: OpeningKind): { revision: number } {
    return this.transaction(() => {
      const current = this.session(id); const saved = JSON.parse(current.chat_config);
      if (!saved.opening || !['starter', 'user'].includes(kind) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new AppFailure('unsupported_opening');
      const receipt = current.last_opening_operation ? JSON.parse(current.last_opening_operation) : null;
      if (receipt?.operationId === operationId) {
        if (receipt.expectedRevision !== expectedRevision || receipt.kind !== kind) throw new AppFailure('opening_operation_conflict');
        if (receipt.revision !== current.opening_revision) throw new AppFailure('opening_changed');
        return { revision: receipt.revision };
      }
      if (current.state !== 'draft' || this.requests(id).length) throw new AppFailure('opening_is_frozen');
      const messages = this.messages(id); validateOpeningSource(current, messages);
      if (current.opening_revision !== expectedRevision) throw new AppFailure('opening_changed');
      let question: Starter | null = current.opening_kind === 'starter'
        ? { id: current.starter_id!, version: current.starter_version!, text: current.starter_text! } : null;
      let parked = current.parked_starter;
      if (kind !== current.opening_kind) {
        if (kind === 'user') {
          parked = JSON.stringify({ question, message: messages[0] }); question = null;
          this.run("DELETE FROM messages WHERE session_id=? AND origin='starter'", id);
        } else {
          const restored = parkedStarter(current);
          if (restored && !this.starter.outdated(restored.question.id)) { question = restored.question; this.insertStarter(id, question, restored.message.id); }
          else {
            const choice = this.starter.select(undefined, id); question = choice.question; this.insertStarter(id, question);
            this.starter.event(this.event(id, 'presented', question), { slot: choice.question.slot, fallback: choice.fallback, relaxed: choice.relaxed });
          }
          parked = null;
        }
      }
      const revision = current.opening_revision + 1;
      saved.opening = { version: openingVersion, kind };
      this.run(`UPDATE sessions SET opening_kind=?,starter_id=?,starter_version=?,starter_text=?,parked_starter=?,chat_config=?,
        opening_revision=?,last_opening_operation=? WHERE id=?`, kind, question?.id ?? null, question?.version ?? null, question?.text ?? null,
        parked, JSON.stringify(saved), revision, JSON.stringify({ operationId, expectedRevision, kind, revision }), id);
      this.run('UPDATE opening_preferences SET kind=? WHERE id=1', kind);
      validateOpeningSource(this.session(id), this.messages(id));
      return { revision };
    });
  }
  replaceQuestion(id: string, operationId: string, expectedQuestionId: string, expectedRevision?: number) {
    this.transaction(() => {
      const previous = this.starter.previousSkip(operationId);
      if (previous) {
        if (previous.session_id !== id || previous.outgoing_id !== expectedQuestionId) throw new AppFailure('starter_skip_conflict');
        return;
      }
      const current = this.session(id);
      if (current.state !== 'draft') throw new AppFailure('opening_is_frozen');
      if (sessionOpening(current) !== 'starter') throw new AppFailure('opening_changed');
      if (JSON.parse(current.chat_config).opening && current.opening_revision !== expectedRevision) throw new AppFailure('opening_changed');
      if (current.starter_id !== expectedQuestionId) throw new AppFailure('starter_changed');
      const consumed = this.starter.consume(current.starter_id!, 'skipped');
      const choice = this.starter.select(current.starter_id!, id); const next = choice.question;
      this.run("UPDATE messages SET content=? WHERE session_id=? AND origin='starter'", next.text, id);
      this.run('UPDATE sessions SET starter_id=?,starter_version=?,starter_text=?,opening_revision=opening_revision+1,last_opening_operation=NULL WHERE id=?', next.id, next.version, next.text, id);
      this.starter.saveSkip(operationId, current, next);
      this.starter.event(this.event(id, 'replaced', next), { slot: next.slot, created: consumed.created, fallback: choice.fallback, relaxed: choice.relaxed });
    });
  }
  saveDraft(id: string, text: string) { this.run("UPDATE sessions SET draft=? WHERE id=? AND state!='ended'", text, id); }
  selectManual(id: string, partner: string | null) {
    if (partner !== null) character(partner, JSON.parse(this.session(id).chat_config));
    if (this.session(id).state !== 'draft') throw new AppFailure('opening_is_frozen');
    this.run('UPDATE sessions SET manual_character=? WHERE id=?', partner, id);
  }
  submit(id: string, text: string, messageId: string = randomUUID()): Message {
    return this.transaction(() => {
      const content = text === '//end' ? '/end' : text;
      const previous = this.all<Message>('SELECT * FROM messages WHERE id=?', messageId)[0];
      if (previous) {
        if (previous.session_id !== id || previous.content !== content || !isLearner(previous)) throw new AppFailure('submission_conflict');
        if (!readMessageTime(this.db, messageId)) throw new AppFailure('message_time_missing');
        return previous;
      }
      const current = this.session(id); const messages = this.messages(id);
      if (current.state === 'draft' && current.opening_kind === 'starter' && this.starter.outdated(current.starter_id)) throw new AppFailure('starter_outdated');
      if (current.state === 'ended' || !text.trim() || text === '/end') throw new AppFailure('invalid_submission');
      validateOpeningSource(current, messages);
      if (messages.length && (messages.at(-1)?.role === 'user' || messages.at(-1)?.delivery !== 'complete')) throw new AppFailure('reply_unresolved');
      if (!budget(messages, content).allowed) throw new AppFailure('session_limit');
      const message: Message = { id: messageId, session_id: id, sequence: (messages.at(-1)?.sequence ?? -1) + 1,
        role: 'user', content, origin: 'learner', delivery: 'complete', request_id: null };
      this.run("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES(?,?,?,'user',?,'learner','complete')", message.id, id, message.sequence, content);
      const sent = this.clock(); validateTime(sent);
      this.run('INSERT INTO message_times VALUES(?,?,?,?)', message.id, sent.utc, sent.timezone, sent.utc_offset_minutes);
      this.search.freeze(current, messages, message, sent.utc);
      if (current.state === 'draft' && current.opening_kind === 'starter') {
        const consumed = this.starter.consume(current.starter_id!, 'answered');
        this.starter.event(this.event(id, 'answered', { id: current.starter_id!, version: current.starter_version!, text: current.starter_text! }), consumed);
      }
      this.run("UPDATE sessions SET state='active',draft='',parked_starter=NULL WHERE id=?", id);
      this.starter.refill();
      this.partners.bind(this.session(id), this.messages(id));
      return message;
    });
  }
  commitRoute(id: string, scores: Record<string, number> | null, fallback: string | null, requestId: string | null): string | null {
    return this.transaction(() => {
      const old = this.all<{ character: string }>('SELECT character FROM route_decisions WHERE session_id=?', id)[0];
      if (old) return old.character;
      const current = this.session(id); if (current.state === 'ended') return null;
      const saved = JSON.parse(current.chat_config); const selected = sessionRuntime(saved);
      const pool = eligible(scores, saved);
      const counts = Object.fromEntries(this.all<{ character: string; n: number }>('SELECT character,COUNT(*) AS n FROM route_decisions GROUP BY character').map(r => [r.character, r.n]));
      const partner = current.manual_character ?? leastUsed(pool, counts); const model = character(partner, saved).model;
      const reason = current.manual_character ? 'manual_override' : fallback ? 'local_fallback' : Object.values(scores!).every(s => s <= 1) ? 'insufficient_signal' : 'strong_fit';
      const route = routerSnapshot(saved);
      this.run('INSERT INTO route_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, requestId, route.version,
        route.prompt_sha256, scores ? JSON.stringify(scores) : null, JSON.stringify(pool), partner, model, reason, fallback, now());
      this.run('UPDATE sessions SET character=?,model=? WHERE id=?', partner, model, id); return partner;
    });
  }
  changePartner(id: string, choice: string | null, operationId: string, expectedRevision: number) {
    this.transaction(() => this.partners.change(this.session(id), choice, operationId, expectedRevision));
  }
  preparePartner(id: string, kind: 'send' | 'different_model' | 'retry_selection', operationId: string): RequestRecord | null {
    return this.transaction(() => {
      const session = this.session(id);
      if (session.state !== 'active') throw new AppFailure('session_ended');
      const messages = this.messages(id), latest = messages.at(-1);
      if (!(latest?.role === 'user' || latest?.delivery === 'interrupted')) throw new AppFailure('reply_not_retryable');
      const op = this.partners.bind(session, messages);
      if (!op) { if (kind !== 'send') throw new AppFailure('partner_selection_missing'); return null; }
      if (op.state === 'ready') return null;
      if (op.state === 'failed' && kind !== 'retry_selection') throw new AppFailure('partner_selection_failed');
      if (!op.config || hash(op.config) !== op.config_hash) throw new AppFailure('partner_source_changed');
      if (op.router_request_id) {
        const prior = this.request(op.router_request_id);
        if (prior.status === 'queued') return prior;
        if (!['failed', 'interrupted'].includes(prior.status) || kind !== 'retry_selection') throw new AppFailure('partner_not_retryable');
      }
      const previous = this.all<RequestRecord>('SELECT * FROM model_requests WHERE id=?', operationId)[0];
      if (previous) return previous;
      const snapshot = { ...JSON.parse(op.config), selection_operation_id: op.id };
      const request = this.createRequest(id, 'router', snapshot, op.router_request_id, operationId);
      this.partners.routerRequest(session, request.id);
      return request;
    });
  }
  finishPartnerRoute(requestId: string, content: string, metadata: Json) {
    this.transaction(() => {
      const request = this.request(requestId), session = this.session(request.session_id);
      if (session.state !== 'active') throw new AppFailure('session_ended');
      if (request.status === 'succeeded') return;
      if (request.status !== 'dispatched' || hash(request.config) !== request.config_hash) throw new AppFailure('partner_source_changed');
      const scores = routerScores(content, JSON.parse(session.chat_config));
      this.partners.resolve(session, requestId, scores);
      this.finishRequest(requestId, content, metadata);
    });
  }
  prepareChat(id: string, operationId: string, kind: 'send' | 'retry' | 'different_model' | 'automatic' = 'automatic'): RequestRecord {
    return this.transaction(() => {
      const previous = this.all<RequestRecord>('SELECT * FROM model_requests WHERE id=?', operationId)[0];
      if (previous) {
        if (previous.session_id !== id || previous.role !== 'chat') throw new AppFailure('request_operation_conflict');
        this.chatBody(previous.id); return previous;
      }
      const session = this.session(id);
      if (session.state !== 'active' || !session.character) throw new AppFailure('session_ended');
      const messages = this.messages(id), user = messages.findLast(isLearner);
      if (!user || (messages.at(-1)?.role === 'assistant' && messages.at(-1)?.delivery === 'complete')) throw new AppFailure('reply_not_retryable');
      const source = messages.filter(m => m.sequence <= user.sequence);
      const last = this.requests(id).findLast(r => r.role === 'chat' && r.source_sequence === user.sequence);
      if (kind === 'automatic') kind = last && last.status !== 'succeeded' ? 'retry' : 'send';
      const parent = kind === 'retry' ? last ?? null : null;
      if (last && !['failed', 'interrupted'].includes(last.status)) throw new AppFailure('reply_not_retryable');
      const pending = kind === 'retry' ? null : this.partners.bind(session, messages);
      if (kind === 'different_model' && !pending) throw new AppFailure('partner_selection_missing');
      if (pending && pending.state !== 'ready') throw new AppFailure('partner_selection_pending');
      const memory = this.memory.snapshot(session);
      let snapshot = conversationRequestSnapshot(JSON.parse(session.chat_config));
      if (memory) snapshot.memory_context = memory;
      let target = pending?.selected_character ?? this.partners.state(session).current_character ?? session.character;
      if (parent) {
        if (parent.source_hash !== hash(transcriptJson(source)) || hash(parent.config) !== parent.config_hash) throw new AppFailure('retry_source_changed');
        snapshot = JSON.parse(parent.config);
        target = requestPartner(snapshot, session.character);
        if (snapshot.time_version && (!isDeepStrictEqual(snapshot.time_context?.sources, timeSources(source, messageId => readMessageTime(this.db, messageId))) ||
          !isDeepStrictEqual(snapshot.memory_context, memory))) throw new AppFailure('temporal_source_changed');
      } else {
        if (snapshot.time_version) {
          const sources = timeSources(source, messageId => readMessageTime(this.db, messageId));
          snapshot.time_context = { reply_reference: this.clock(), sources };
          snapshot.temporal_source_hash = temporalHash(sources);
          snapshot.system_sha256 = hash(conversationSystem(snapshot, source));
        }
        // Bind every new target independently of mutable UI selection. Old requests stay exact.
        snapshot.request_partner = { version: 'stomylos_request_partner_v1', target: character(target, snapshot),
          memory_owner_character: session.character, operation_id: pending?.id ?? null, kind,
          supersedes_request_id: kind === 'different_model' ? last?.id ?? null : null };
      }
      conversationBody(snapshot, target, session.starter_text, source);
      const request = this.createRequest(id, 'chat', snapshot, parent?.id ?? null, operationId);
      this.search.attach(request, user);
      if (pending) this.partners.apply(session, request);
      return request;
    });
  }
  chatBody(requestId: string): Json {
    const request = this.request(requestId), session = this.session(request.session_id);
    if (request.role !== 'chat' || session.state !== 'active' || !session.character || hash(request.config) !== request.config_hash) throw new AppFailure('request_source_changed');
    const all = this.messages(session.id), source = all.filter(m => m.sequence <= request.source_sequence);
    if (all.findLast(isLearner)?.sequence !== request.source_sequence || hash(transcriptJson(source)) !== request.source_hash) throw new AppFailure('request_source_changed');
    const snapshot = JSON.parse(request.config);
    if (snapshot.time_version && !isDeepStrictEqual(snapshot.time_context?.sources, timeSources(source, id => readMessageTime(this.db, id)))) throw new AppFailure('temporal_source_changed');
    return this.search.body(request, source.findLast(isLearner)!, conversationBody(snapshot, requestPartner(snapshot, session.character), session.starter_text, source));
  }
  createRequest(id: string, role: Role, snapshot: Json, parentId: string | null = null, requestId: string = randomUUID()): RequestRecord {
    return this.transaction(() => {
      const current = this.session(id); let messages = this.messages(id);
      if (role !== 'grammar' && current.state === 'ended') throw new AppFailure('session_ended');
      if (role === 'chat' || snapshot.purpose === 'partner_reselection') {
        const lastUser = messages.findLast(isLearner); if (!lastUser) throw new AppFailure('no_learner_source');
        messages = messages.filter(m => m.sequence <= lastUser.sequence);
      }
      if (role === 'grammar' && (current.state !== 'ended' || !['none', 'pending', 'failed', 'skipped'].includes(current.analysis_state))) throw new AppFailure('analysis_not_retryable');
      validateOpeningSource(current, this.messages(id));
      if (!messages.some(isLearner)) throw new AppFailure('no_learner_source');
      const sourceHash = hash(transcriptJson(messages));
      if (role === 'grammar' && sourceHash !== current.source_hash) throw new AppFailure('frozen_source_changed');
      const encoded = JSON.stringify(snapshot);
      this.run("INSERT INTO model_requests(id,session_id,role,parent_id,status,created_at,source_sequence,source_hash,config,config_hash) VALUES(?,?,?,?,'queued',?,?,?,?,?)", requestId, id, role, parentId, now(), messages.at(-1)!.sequence, sourceHash, encoded, hash(encoded));
      if (role === 'grammar') this.run("UPDATE sessions SET analysis_state='running',grammar_config=? WHERE id=?", encoded, id);
      return this.request(requestId);
    });
  }
  dispatch(id: string) {
    if (this.run("UPDATE model_requests SET status='dispatched',dispatched_at=? WHERE id=? AND status='queued'", now(), id).changes !== 1) throw new AppFailure('request_not_queued');
  }
  prepareReply(id: string, requestId: string): Message {
    return this.transaction(() => {
      if (this.session(id).state === 'ended') throw new AppFailure('session_ended');
      this.run("DELETE FROM messages WHERE session_id=? AND delivery='interrupted' AND origin='model'", id);
      const sequence = this.messages(id).at(-1)!.sequence + 1; const messageId = randomUUID();
      this.run("INSERT INTO messages VALUES(?,?,?,'assistant','','model','streaming',?)", messageId, id, sequence, requestId);
      return this.messages(id).at(-1)!;
    });
  }
  checkpoint(messageId: string, text: string, metadata?: Json) {
    this.transaction(() => {
      const message = this.all<Message>("SELECT * FROM messages WHERE id=? AND delivery='streaming'", messageId)[0];
      if (!message || this.session(message.session_id).state === 'ended') return;
      this.run('UPDATE messages SET content=? WHERE id=?', text, messageId);
      this.run('UPDATE model_requests SET response_content=? WHERE id=?', text, message.request_id);
      if (metadata) this.run('UPDATE model_requests SET metadata=? WHERE id=?', JSON.stringify(metadata), message.request_id);
    });
  }
  finishRequest(id: string, content: string, metadata: Json) {
    this.run("UPDATE model_requests SET status='succeeded',finished_at=?,response_content=?,metadata=? WHERE id=? AND status='dispatched'", now(), content, JSON.stringify(metadata), id);
  }
  finishReply(requestId: string, messageId: string, content: string, metadata: Json) {
    this.transaction(() => {
      const request = this.request(requestId);
      if (request.status === 'succeeded' && request.response_content === content) return;
      if (request.status !== 'dispatched' || this.session(request.session_id).state === 'ended') throw new AppFailure('reply_already_resolved');
      if (this.run("UPDATE messages SET content=?,delivery='complete' WHERE id=? AND request_id=? AND delivery='streaming'", content, messageId, requestId).changes !== 1) throw new AppFailure('reply_not_pending');
      this.finishRequest(requestId, content, metadata);
    });
  }
  failRequest(id: string, failure: string, content: string | null = null, metadata: Json = {}, interrupted = false) {
    this.transaction(() => {
      const request = this.request(id);
      if (!['queued', 'dispatched'].includes(request.status)) return;
      this.run('UPDATE model_requests SET status=?,finished_at=?,failure=?,response_content=COALESCE(?,response_content),metadata=? WHERE id=?', interrupted ? 'interrupted' : 'failed', now(), failure, content, JSON.stringify(metadata), id);
      this.partners.fail(id);
      if (request.role === 'grammar') this.run('UPDATE sessions SET analysis_state=? WHERE id=? AND selected_analysis_id IS NULL', failure === 'queued_not_dispatched' && request.dispatched_at === null ? 'pending' : 'failed', request.session_id);
      this.run("UPDATE messages SET delivery='interrupted',content=COALESCE(?,content) WHERE request_id=? AND delivery='streaming'", content, id);
    });
  }
  end(id: string, retainedDraft?: string): boolean {
    return this.transaction(() => {
      const current = this.session(id); if (current.state === 'ended') return false;
      this.run("UPDATE messages SET delivery='interrupted' WHERE session_id=? AND delivery='streaming'", id);
      const source = this.messages(id); validateOpeningSource(current, source); const analyze = source.some(isLearner);
      this.run("UPDATE sessions SET state='ended',parked_starter=NULL,ended_at=?,draft=?,source_hash=?,grammar_config=?,analysis_state=? WHERE id=?", now(), retainedDraft ?? current.draft, hash(transcriptJson(source)), null, analyze ? 'none' : 'skipped', id);
      this.run('INSERT INTO end_processing(session_id,created_at) VALUES(?,?)', id, now());
      for (const stage of ['grammar','starter','update','cleanup']) this.run('INSERT INTO end_stage_state(session_id,stage) VALUES(?,?)', id, stage);
      this.starter.freeze(this.session(id), source);
      this.memory.freeze(this.session(id), source);
      if (!this.memory.job(id)) this.starter.release(this.session(id), source, 'no_memory_update');
      return analyze;
    });
  }
  saveAnalysis(id: string, content: string, metadata: Json) {
    this.transaction(() => {
      const request = this.request(id); const current = this.session(request.session_id);
      if (request.status === 'succeeded' && current.selected_analysis_id === id && request.response_content === content) return;
      if (request.status !== 'dispatched' || current.selected_analysis_id !== null) throw new AppFailure('analysis_already_resolved');
      const source = this.messages(current.id);
      if (request.source_hash !== current.source_hash || hash(transcriptJson(source)) !== current.source_hash) throw new AppFailure('frozen_source_changed');
      if (hash(request.config) !== request.config_hash) throw new AppFailure('config_hash_mismatch');
      const units = validateGrammar(content, source, JSON.parse(request.config));
      for (const unit of units) this.run('INSERT INTO grammar_units(analysis_attempt_id,session_id,source_message_id,ordinal,text,corrected_text,explanation,changed,warnings) VALUES(?,?,?,?,?,?,?,?,?)', id, current.id, unit.source_message_id, unit.ordinal, unit.text, unit.corrected_text, unit.explanation, unit.changed, unit.warnings);
      this.finishRequest(id, content, metadata);
      this.run("UPDATE sessions SET analysis_state='completed',selected_analysis_id=? WHERE id=?", id, current.id);
    });
  }
  integrity() { return { integrity: this.db.pragma('integrity_check'), foreignKeys: this.db.pragma('foreign_key_check') }; }
  currentMemory() { return this.memory.load(); }
  freezeMemory(sessionId: string) { return this.transaction(() => this.memory.snapshot(this.session(sessionId))); }
  memoryJob(sessionId: string) { return this.memory.job(sessionId); }
  endStatus(id: string): Json | null {
    const record = this.all<Json>('SELECT * FROM end_processing WHERE session_id=?', id)[0];
    if (!record) return null;
    const session = this.session(id), memory = this.memory.job(id), candidate = this.memory.candidate(id), starter = this.starter.jobForSession(id);
    const stages = { starter: this.starter.catalogMode() ? 'skipped' : starter?.state ?? 'skipped',
      update: candidate ? 'completed' : memory?.state ?? 'skipped', cleanup: candidate?.state ?? 'skipped' };
    const attempts: Record<string, Json[]> = {
      grammar: this.all<Json>("SELECT failure,status FROM model_requests WHERE session_id=? AND role='grammar' ORDER BY rowid", id),
      starter: this.all<Json>('SELECT a.failure,a.status FROM starter_renewal_attempts a JOIN starter_renewal_jobs j ON j.id=a.job_id WHERE j.session_id=? ORDER BY a.rowid', id),
      update: this.all<Json>('SELECT a.failure,a.status FROM memory_attempts a JOIN memory_jobs j ON j.ordinal=a.job_id WHERE j.session_id=? ORDER BY a.rowid', id),
      cleanup: this.memory.cleanupAttempts(id)
    };
    const details = Object.fromEntries(Object.entries(attempts).map(([stage, rows]) => [stage, { attempts: rows.length, failure: rows.at(-1)?.failure ?? null }]));
    return { cancelled: !!record.cancelled_at, stages, details, retries: this.all<Json>('SELECT stage,automatic_retry_used FROM end_stage_state WHERE session_id=?', id),
      complete: !!record.cancelled_at || Object.values(stages).every(s => ['completed','skipped'].includes(s)) };
  }
  endBlockers(): { sessionId: string; title: string }[] {
    return this.all<{ sessionId: string; title: string }>(`SELECT s.id sessionId,
      COALESCE(s.starter_text,(SELECT content FROM messages WHERE session_id=s.id AND origin='learner' ORDER BY sequence LIMIT 1),'Chat') title
      FROM end_processing e JOIN sessions s ON s.id=e.session_id WHERE e.cancelled_at IS NULL ORDER BY e.created_at,s.id`)
      .filter(row => !this.endStatus(row.sessionId)?.complete);
  }
  endBlocker(): string | null { return this.endBlockers()[0]?.sessionId ?? null; }
  assertEndActive(id: string) {
    if (this.all('SELECT 1 FROM end_processing WHERE session_id=? AND cancelled_at IS NOT NULL', id).length) throw new AppFailure('end_processing_cancelled');
  }
  takeAutomaticRetry(id: string, stage: string): boolean {
    this.assertEndActive(id);
    return this.run('UPDATE end_stage_state SET automatic_retry_used=1 WHERE session_id=? AND stage=? AND automatic_retry_used=0', id, stage).changes === 1;
  }
  suppressAutomaticRetry(id: string, stage: string) { this.assertEndActive(id); this.run('UPDATE end_stage_state SET automatic_retry_used=1 WHERE session_id=? AND stage=?', id, stage); }
  receiveEndResponse(id: string, stage: string, attempt: string, content: string, metadata: Json) {
    if (stage !== 'grammar') this.assertEndActive(id);
    this.run('UPDATE end_stage_state SET response_id=?,response_content=?,response_metadata=? WHERE session_id=? AND stage=?', attempt, content, JSON.stringify(metadata), id, stage);
  }
  endResponse(id: string, stage: string): Json | null { return this.all<Json>('SELECT * FROM end_stage_state WHERE session_id=? AND stage=? AND response_content IS NOT NULL', id, stage)[0] ?? null; }
  clearEndResponse(id: string, stage: string) { this.run('UPDATE end_stage_state SET response_id=NULL,response_content=NULL,response_metadata=NULL WHERE session_id=? AND stage=?', id, stage); }
  resumeEndResponse(id: string, stage: string): boolean {
    if (stage === 'starter' && this.starter.catalogMode()) return false;
    if (stage !== 'grammar') this.assertEndActive(id);
    const saved = this.endResponse(id, stage); if (!saved) return false;
    try {
      this.transaction(() => {
        const metadata = JSON.parse(saved.response_metadata);
        if (stage === 'grammar') {
          this.run("UPDATE model_requests SET status='dispatched' WHERE id=? AND status='interrupted'", saved.response_id);
          this.saveAnalysis(saved.response_id, saved.response_content, metadata);
        } else if (stage === 'starter') {
          this.run("UPDATE starter_renewal_attempts SET status='dispatched' WHERE id=? AND status='interrupted'", saved.response_id);
          this.run("UPDATE starter_renewal_jobs SET state='running' WHERE session_id=? AND state='interrupted'", id);
          this.saveStarter(saved.response_id, saved.response_content, metadata);
        } else if (stage === 'update') {
          this.run("UPDATE memory_attempts SET status='dispatched' WHERE id=? AND status='interrupted'", saved.response_id);
          this.run("UPDATE memory_jobs SET state='running' WHERE session_id=? AND state='interrupted'", id);
          this.memory.save(saved.response_id, saved.response_content, metadata);
        }
        this.clearEndResponse(id, stage);
      });
      return true;
    } catch (error) {
      // Leave storage failures recoverable. Invalid output must not be replayed forever.
      if (error instanceof AppFailure) this.clearEndResponse(id, stage);
      throw error;
    }
  }
  cancelEnd(id: string) {
    return this.transaction(() => {
      this.run('UPDATE end_processing SET cancelled_at=COALESCE(cancelled_at,?) WHERE session_id=?', now(), id);
      this.run("UPDATE memory_attempts SET status='interrupted',failure='request_cancelled' WHERE job_id IN (SELECT ordinal FROM memory_jobs WHERE session_id=?) AND status IN ('queued','dispatched')", id);
      this.run("UPDATE memory_jobs SET state='skipped' WHERE session_id=? AND state!='completed'", id);
      this.run("UPDATE memory_candidates SET state='cancelled' WHERE session_id=? AND state!='completed'", id);
      this.memory.retireBridge();
      this.run("UPDATE memory_cleanup_attempts SET status='cancelled' WHERE session_id=? AND status IN ('queued','dispatched','received')", id);
      this.run("UPDATE starter_renewal_jobs SET state='failed' WHERE session_id=? AND state!='completed'", id);
      this.run("UPDATE starter_renewal_attempts SET status='interrupted',failure='request_cancelled' WHERE job_id IN (SELECT id FROM starter_renewal_jobs WHERE session_id=?) AND status IN ('queued','dispatched')", id);
    });
  }
  memoryCandidate(id: string) { return this.memory.candidate(id); }
  cleanupAttempts(id: string) { return this.memory.cleanupAttempts(id); }
  prepareCleanup(id: string, attempt: string) { return this.memory.prepareCleanup(id, attempt); }
  dispatchCleanup(id: string) { return this.memory.dispatchCleanup(id); }
  receiveCleanup(id: string, content: string, metadata: Json) { return this.memory.receiveCleanup(id, content, metadata); }
  acceptCleanup(id: string) { return this.memory.acceptCleanup(id); }
  failCleanup(id: string, failure: string, interrupted = false, evidence?: { content: string | null; metadata: Json }) { return this.memory.failCleanup(id, failure, interrupted, evidence); }
  memoryReady(sessionIds: string[]) { return this.memory.ready(sessionIds); }
  retryMemory(sessionId: string) { this.assertEndActive(sessionId); return this.memory.retry(sessionId); }
  skipMemory(sessionId: string) { return this.memory.skip(sessionId); }
  prepareMemory(sessionId: string, operationId: string) { return this.memory.prepare(sessionId, operationId); }
  dispatchMemory(id: string) { return this.memory.dispatch(id); }
  saveMemory(id: string, content: string, metadata: Json) { return this.memory.save(id, content, metadata); }
  failMemory(id: string, failure: string, content: string | null = null, metadata: Json = {}, interrupted = false) { return this.memory.fail(id, failure, content, metadata, interrupted); }
  advanceStarter(id: string) {
    return this.transaction(() => {
      this.intentions.expire(id);
      const p = this.starter.preparation(id);
      if (!p || p.state === 'released') return true;
      const memory = this.memory.job(id), view = this.memory.view(this.session(id));
      const blocking = view.blockedBy ? this.memory.job(view.blockedBy) : null;
      let reason: string | null = null;
      if (Date.parse(p.deadline) <= Date.now()) reason = 'preparation_deadline';
      else if (memory && ['failed', 'interrupted', 'skipped'].includes(memory.state)) reason = 'memory_' + memory.state;
      else if (blocking && ['failed', 'interrupted'].includes(blocking.state)) reason = 'memory_blocked';
      else if (!memory || memory.state === 'completed') {
        const jobs = this.intentions.jobs(id);
        if (!jobs.some(j => ['pending','running','received'].includes(j.state))) reason = jobs.some(j => ['failed','interrupted'].includes(j.state)) ? 'intention_partial' : 'synchronized';
      }
      if (reason) this.starter.release(this.session(id), this.messages(id), reason);
      return !!reason;
    });
  }
  intentionJobs(id: string) { return this.intentions.jobs(id); }
  intentionJob(id: string) { return this.intentions.job(id); }
  dispatchIntention(id: string, operationId: string) { return this.intentions.dispatch(id, operationId); }
  receiveIntention(id: string, content: string, metadata: Json) { return this.intentions.receive(id, content, metadata); }
  acceptIntention(id: string) { return this.intentions.accept(id); }
  failIntention(id: string, failure: string, content: string | null, metadata: Json, interrupted = false) { return this.intentions.fail(id, failure, content, metadata, interrupted); }
  retryIntentions(id: string) { this.session(id); return this.intentions.retry(id); }
  starterInventory() { return this.starter.inventory(); }
  starterJob(sessionId: string) { return this.starter.jobForSession(sessionId); }
  starterAttempt(id: string) { return this.starter.attempt(id); }
  starterAttempts(jobId: string) { return this.starter.attempts(jobId); }
  retryStarter(sessionId: string, operationId: string) { this.assertEndActive(sessionId); return this.starter.retry(sessionId, operationId); }
  dispatchStarter(id: string) { return this.starter.dispatch(id); }
  saveStarter(id: string, content: string, metadata: Json) { this.assertEndActive(this.starter.job(this.starter.attempt(id).job_id).session_id); return this.starter.save(id, content, metadata); }
  failStarter(id: string, failure: string, content: string | null = null, metadata: Json = {}, interrupted = false) { return this.starter.fail(id, failure, content, metadata, interrupted); }
  patternPreview(asOf?: string, selection?: import('../shared/pattern-report').PatternSelection) { return this.patterns.preview(asOf, selection); }
  patternCreate(fingerprint: string, operationId: string, asOf?: string, selection?: import('../shared/pattern-report').PatternSelection) { return this.patterns.create(fingerprint, operationId, asOf, selection); }
  patternAttempt(id: string) { return this.patterns.attempt(id); }
  patternDispatch(id: string) { return this.patterns.dispatch(id); }
  patternRetry(id: string, operationId: string) { return this.patterns.retry(id, operationId); }
  patternSave(id: string, html: string, metadata: Json) { return this.patterns.save(id, html, metadata); }
  patternFinish(id: string, status: Extract<PatternStatus, 'failed' | 'cancelled' | 'interrupted'>, failure: string, html: string | null, metadata: Json) { return this.patterns.finish(id, status, failure, html, metadata); }
  patternList(offset: number) { return this.patterns.list(offset); }
  patternDetail(id: string) { return this.patterns.detail(id); }
  patternHtml(id: string) { return this.patterns.html(id); }
  patternRelated(id: string) { return this.patterns.related(id); }
  patternAffected(id: string) { return this.patterns.affected(id); }
  patternDelete(id: string) { return this.patterns.delete(id); }
  close() { if (!this.closed) { this.db.close(); this.unlock(); this.closed = true; } }
}
export type StoreMethod = Exclude<{ [K in keyof Store]: Store[K] extends (...args: any[]) => any ? K : never }[keyof Store], never>;
