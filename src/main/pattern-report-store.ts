import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { AppFailure } from './errors';
import { patternBody, patternContract, patternHash, resolvePatternContract, validatePatternHtml, directPatternEstimate, directPatternEstimator, directPatternLimit, patternInputCost } from './pattern-report';
import type { PatternAttempt, PatternCard, PatternDetail, PatternSource, PatternStatus, PatternSelection, PatternPreview } from '../shared/pattern-report';
import type { Json } from '../shared/types';

type Report = { id: string; created_at: string; fingerprint: string; snapshot: string; selected_attempt_id: string | null };
const now = () => new Date().toISOString();
const fail = (code: string): never => { throw new AppFailure('pattern_' + code); };
export class PatternReportStore {
  constructor(private db: Database.Database) {}
  private get<T>(sql: string, ...args: unknown[]) { return this.db.prepare(sql).get(...args) as T | undefined; }
  private all<T>(sql: string, ...args: unknown[]) { return this.db.prepare(sql).all(...args) as T[]; }
  private run(sql: string, ...args: unknown[]) { return this.db.prepare(sql).run(...args); }
  private report(id: string) { return this.get<Report>('SELECT * FROM pattern_reports WHERE id=?', id) ?? fail('missing'); }
  attempt(id: string) { return this.get<PatternAttempt>('SELECT * FROM pattern_report_attempts WHERE id=?', id) ?? fail('attempt_missing'); }
  private active() { return this.get<PatternAttempt>("SELECT * FROM pattern_report_attempts WHERE status IN ('queued','dispatched')"); }
  private sourceUnits(id: string, selected_analysis_id: string) {
    return this.all<{ source_message_id: string; ordinal: number; text: string; corrected_text: string; explanation: string }>(
      'SELECT * FROM grammar_units WHERE session_id=? AND analysis_attempt_id=? ORDER BY ordinal', id, selected_analysis_id)
      .map(u => ({ source_id: 'E-' + patternHash(JSON.stringify([id, selected_analysis_id, u.source_message_id])).slice(0, 24),
        message_id: u.source_message_id, ordinal: u.ordinal, original: u.text, corrected: u.corrected_text, explanation: u.explanation }));
  }
  private learnerUnits(id: string) {
    return this.all<{id: string; content: string; sequence: number}>(
      "SELECT id,content,sequence FROM messages WHERE session_id=? AND role='user' AND origin='learner' ORDER BY sequence", id)
      .map((m, ordinal) => ({ source_id: m.id, message_id: m.id, ordinal, original: m.content, corrected: '', explanation: '' }));
  }
  private selection(asOf: string, chosen?: PatternSelection) {
    const selection = chosen ?? { from: new Date(Date.parse(asOf) - 7 * 86400_000).toISOString(), to: asOf, timezone: 'UTC', excludeCovered: false };
    if (!Number.isFinite(Date.parse(selection.from)) || !Number.isFinite(Date.parse(selection.to)) || Date.parse(selection.from) >= Date.parse(selection.to)) fail('time');
    const rows = this.all<{id: string; ended_at: string; covered: number}>(`SELECT s.id,s.ended_at,
      EXISTS(SELECT 1 FROM pattern_report_sources ps JOIN pattern_reports p ON p.id=ps.report_id
      WHERE ps.session_id=s.id AND p.selected_attempt_id IS NOT NULL) covered FROM sessions s
      WHERE s.state='ended' AND julianday(s.ended_at)>=julianday(?) AND julianday(s.ended_at)<julianday(?)
      AND EXISTS(SELECT 1 FROM messages m WHERE m.session_id=s.id AND m.role='user' AND m.origin='learner')
      ORDER BY julianday(s.ended_at),s.id`, selection.from, selection.to);
    const sources: PatternSource[] = rows.filter(r => !selection.excludeCovered || !r.covered).map(r => {
      const units = this.learnerUnits(r.id);
      return {session_id: r.id, analysis_id: null, evidence_kind: 'learner', ended_at: r.ended_at, units, source_hash: patternHash(JSON.stringify(units))};
    });
    const body = patternBody(sources), estimate = directPatternEstimate(body);
    const fingerprint = patternHash(JSON.stringify({sources, body, contract: patternContract, estimator: directPatternEstimator}));
    const existingId = this.get<{id: string}>('SELECT id FROM pattern_reports WHERE fingerprint=?', fingerprint)?.id ?? null;
    const preview: PatternPreview = {fingerprint, existingId, unavailableSessions: [],
      blocked: estimate > directPatternLimit ? 'input_limit' as const : sources.length < 5 ? 'insufficient' as const : null,
      scope: {asOf, cutoff: selection.from, selection, count: sources.length, records: sources.reduce((n,s)=>n+s.units.length,0),
        from: sources[0]?.ended_at ?? null, to: sources.at(-1)?.ended_at ?? null, eligible: rows.length,
        covered: rows.filter(r=>r.covered).length, excluded: {unavailable:0, older:0, overCount:0, overBudget:0},
        estimate, estimator: directPatternEstimator, limit: directPatternLimit, ...patternInputCost(estimate)}};
    return {sources, body, preview};
  }
  preview(asOf = now(), selection?: PatternSelection) { return this.db.transaction(() => this.selection(asOf, selection).preview)(); }
  create(fingerprint: string, operationId: string, asOf = now(), selection?: PatternSelection) {
    return this.db.transaction(() => {
      const receipt = this.get<Report>('SELECT * FROM pattern_reports WHERE id=?', operationId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail('operation_conflict');
        const queued = this.get<PatternAttempt>("SELECT * FROM pattern_report_attempts WHERE report_id=? AND status='queued'", receipt.id);
        return { id: receipt.id, reused: !queued, attemptId: queued?.id ?? null };
      }
      const s = this.selection(asOf, selection);
      if (s.preview.fingerprint !== fingerprint) fail('scope_changed');
      if (s.preview.blocked) fail(s.preview.blocked);
      if (s.preview.existingId) return { id: s.preview.existingId, reused: true, attemptId: null };
      if (this.active()) fail('busy');
      const snapshot = JSON.stringify({ scope: s.preview.scope, sources: s.sources, contract: patternContract });
      this.run('INSERT INTO pattern_reports(id,created_at,fingerprint,snapshot) VALUES(?,?,?,?)', operationId, now(), fingerprint, snapshot);
      s.sources.forEach((source, ordinal) => this.run('INSERT INTO pattern_report_sources(report_id,session_id,analysis_id,evidence_kind,source_hash,ordinal) VALUES(?,?,?,?,?,?)', operationId, source.session_id, source.analysis_id, 'learner', source.source_hash, ordinal));
      const attempt = this.insertAttempt(operationId, randomUUID(), null, JSON.stringify(s.body));
      return { id: operationId, reused: false, attemptId: attempt.id };
    })();
  }
  private insertAttempt(reportId: string, id: string, parent: string | null, request: string) {
    this.run("INSERT INTO pattern_report_attempts(id,report_id,parent_id,request,request_hash,status,created_at) VALUES(?,?,?,?,?,'queued',?)",
      id, reportId, parent, request, patternHash(request), now());
    return this.attempt(id);
  }
  private assertSources(reportId: string) {
    const sources = this.all<{session_id: string; analysis_id: string | null; evidence_kind: string; source_hash: string}>('SELECT * FROM pattern_report_sources WHERE report_id=?', reportId);
    for (const source of sources) {
      const session = this.get<{selected_analysis_id: string}>('SELECT selected_analysis_id FROM sessions WHERE id=?', source.session_id);
      if (!session) fail('source_deleted');
      if (source.evidence_kind === 'learner') {
        if (patternHash(JSON.stringify(this.learnerUnits(source.session_id))) !== source.source_hash) fail('source_changed');
      } else if (session!.selected_analysis_id !== source.analysis_id || patternHash(JSON.stringify(this.sourceUnits(source.session_id, source.analysis_id!))) !== source.source_hash) fail('source_changed');
    }
  }
  private sourcesPresent(reportId: string) {
    try { this.assertSources(reportId); return true; }
    catch (error) { if (error instanceof AppFailure && ['pattern_source_deleted','pattern_source_changed'].includes(error.message)) return false; throw error; }
  }
  retry(reportId: string, operationId: string) {
    return this.db.transaction(() => {
      const receipt = this.get<PatternAttempt>('SELECT * FROM pattern_report_attempts WHERE id=?', operationId);
      if (receipt) { if (receipt.report_id !== reportId) fail('operation_conflict'); return receipt; }
      const report = this.report(reportId);
      if (report.selected_attempt_id || this.active()) fail('not_retryable');
      this.assertSources(reportId);
      const prior = this.all<PatternAttempt>('SELECT * FROM pattern_report_attempts WHERE report_id=? ORDER BY rowid DESC LIMIT 1', reportId)[0];
      if (!prior || !['failed', 'cancelled', 'interrupted'].includes(prior.status)) fail('not_retryable');
      this.assertRequest(prior);
      return this.insertAttempt(reportId, operationId, prior.id, prior.request);
    })();
  }
  private assertRequest(a: PatternAttempt) {
    if (patternHash(a.request) !== a.request_hash) fail('request_changed');
    const saved = JSON.parse(this.report(a.report_id).snapshot);
    const contract = resolvePatternContract(saved.contract);
    if (JSON.stringify(JSON.parse(a.request)) !== JSON.stringify(patternBody(saved.sources, contract))) fail('request_changed');
    return contract;
  }
  private requestSupported(a: PatternAttempt) {
    try { this.assertRequest(a); return true; }
    catch (error) {
      if (error instanceof AppFailure && ['pattern_unsupported_contract', 'pattern_request_changed'].includes(error.message)) return false;
      throw error;
    }
  }
  dispatch(id: string) {
    return this.db.transaction(() => {
      const a = this.attempt(id), contract = this.assertRequest(a);
      if (a.status !== 'queued') fail('already_dispatched');
      this.assertSources(a.report_id);
      this.run("UPDATE pattern_report_attempts SET status='dispatched',dispatched_at=? WHERE id=?", now(), id);
      return { ...this.attempt(id), contract };
    })();
  }
  save(id: string, html: string, metadata: Json) {
    validatePatternHtml(html, this.assertRequest(this.attempt(id)));
    return this.db.transaction(() => {
      const a = this.attempt(id), report = this.report(a.report_id);
      if (a.status === 'succeeded' && report.selected_attempt_id === id && a.html === html) return;
      if (a.status !== 'dispatched' || report.selected_attempt_id) fail('already_resolved');
      this.assertSources(a.report_id);
      this.run("UPDATE pattern_report_attempts SET status='succeeded',html=?,html_hash=?,metadata=?,finished_at=? WHERE id=?",
        html, patternHash(html), JSON.stringify(metadata), now(), id);
      this.run('UPDATE pattern_reports SET selected_attempt_id=? WHERE id=?', id, a.report_id);
    })();
  }
  finish(id: string, status: Extract<PatternStatus, 'failed' | 'cancelled' | 'interrupted'>, failure: string, html: string | null, metadata: Json) {
    const a = this.attempt(id);
    if (!['queued', 'dispatched'].includes(a.status)) return;
    this.run('UPDATE pattern_report_attempts SET status=?,failure=?,html=?,html_hash=?,metadata=?,finished_at=? WHERE id=?',
      status, failure, html, html === null ? null : patternHash(html), JSON.stringify(metadata), now(), id);
  }
  recover() {
    this.run("UPDATE pattern_report_attempts SET failure=CASE WHEN status='queued' THEN 'queued_not_dispatched' ELSE 'interrupted_unknown_outcome' END,status='interrupted',finished_at=? WHERE status IN ('queued','dispatched')", now());
  }
  private card(r: Report): PatternCard {
    const a = this.all<PatternAttempt>('SELECT * FROM pattern_report_attempts WHERE report_id=? ORDER BY rowid DESC LIMIT 1', r.id)[0];
    const reportedCost = JSON.parse(a.metadata).usage?.cost;
    return { cost: typeof reportedCost === 'number' && Number.isFinite(reportedCost) && reportedCost >= 0 ? reportedCost : null, id: r.id, created_at: r.created_at, scope: JSON.parse(r.snapshot).scope, selected_attempt_id: r.selected_attempt_id,
      last_attempt_id: a.id, status: a.status, failure: a.failure };
  }
  list(offset = 0) {
    const rows = this.all<Report>('SELECT * FROM pattern_reports ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET ?', offset);
    return { reports: rows.slice(0, 20).map(r => this.card(r)), hasMore: rows.length > 20 };
  }
  detail(id: string): PatternDetail {
    const r = this.report(id), snapshot = JSON.parse(r.snapshot), card = this.card(r);
    return { ...card, model: snapshot.contract.parameters.model, sources: snapshot.sources.map((s: PatternSource) =>
      ({ ...s, deleted: !this.get('SELECT id FROM sessions WHERE id=?', s.session_id) })),
      attempts: this.all<PatternAttempt>('SELECT * FROM pattern_report_attempts WHERE report_id=? ORDER BY rowid', id).map(({ html, request, ...a }) => a),
      canRetry: !r.selected_attempt_id && ['failed', 'cancelled', 'interrupted'].includes(card.status) && this.sourcesPresent(id) && this.requestSupported(this.attempt(card.last_attempt_id)) };
  }
  html(id: string) {
    const r = this.report(id); if (!r.selected_attempt_id) fail('not_ready');
    const a = this.attempt(r.selected_attempt_id!);
    if (a.status !== 'succeeded' || !a.html || patternHash(a.html) !== a.html_hash) fail('output_changed');
    return { html: a.html!, createdAt: r.created_at };
  }
  related(sessionId: string) {
    const reports = this.all<Report>(`SELECT r.* FROM pattern_reports r JOIN pattern_report_sources s ON s.report_id=r.id
      WHERE s.session_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 20`, sessionId).map(r => this.card(r));
    const total = this.get<{ n: number }>('SELECT count(*) n FROM pattern_report_sources WHERE session_id=?', sessionId)!.n;
    return { reports, total };
  }
  affected(sessionId: string) { return this.all<{ report_id: string }>('SELECT report_id FROM pattern_report_sources WHERE session_id=?', sessionId).map(r => r.report_id); }
  delete(id: string) {
    this.db.transaction(() => {
      if (this.get("SELECT id FROM pattern_report_attempts WHERE report_id=? AND status IN ('queued','dispatched')", id)) fail('busy');
      this.run('DELETE FROM pattern_reports WHERE id=?', id);
    })();
  }
}
