import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { AppFailure } from './errors';
import { patternBody, patternContract, patternHash, resolvePatternContract, selectPatternScope, validatePatternHtml } from './pattern-report';
import type { PatternAttempt, PatternCard, PatternDetail, PatternSource, PatternStatus } from '../shared/pattern-report';
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
  private selection(asOf: string) {
    const cutoff = new Date(Date.parse(asOf) - 90 * 86400_000).toISOString();
    const rows = this.all<{ id: string; selected_analysis_id: string }>(`SELECT s.id,s.selected_analysis_id FROM sessions s
      JOIN model_requests r ON r.id=s.selected_analysis_id AND r.session_id=s.id
      WHERE s.state='ended' AND julianday(s.ended_at) BETWEEN julianday(?) AND julianday(?)
      AND s.analysis_state='completed' AND r.status='succeeded'
      AND EXISTS(SELECT 1 FROM grammar_units u WHERE u.analysis_attempt_id=r.id AND u.session_id=s.id)
      ORDER BY julianday(s.ended_at) DESC,s.id DESC`, cutoff, asOf);
    // Only the first twenty need their full evidence loaded; retain the eligible count separately.
    const sources = rows.slice(0, 20).map(({ id, selected_analysis_id }): PatternSource => {
      const session = this.get<{ ended_at: string }>('SELECT ended_at FROM sessions WHERE id=?', id)!;
      const units = this.sourceUnits(id, selected_analysis_id);
      return { session_id: id, analysis_id: selected_analysis_id, ended_at: session.ended_at, units, source_hash: patternHash(JSON.stringify(units)) };
    });
    const recent = this.get<{ n: number }>("SELECT count(*) n FROM sessions WHERE state='ended' AND julianday(ended_at) BETWEEN julianday(?) AND julianday(?)", cutoff, asOf)!.n;
    const older = this.get<{ n: number }>("SELECT count(*) n FROM sessions WHERE state='ended' AND julianday(ended_at)<julianday(?)", cutoff)!.n;
    const selected = selectPatternScope(sources, asOf, recent - rows.length, older);
    selected.preview.unavailableSessions = this.all(`SELECT s.id,s.ended_at,s.analysis_state AS state FROM sessions s
      WHERE s.state='ended' AND julianday(s.ended_at) BETWEEN julianday(?) AND julianday(?) AND NOT EXISTS(
        SELECT 1 FROM model_requests r WHERE r.id=s.selected_analysis_id AND r.session_id=s.id AND r.status='succeeded'
        AND s.analysis_state='completed' AND EXISTS(SELECT 1 FROM grammar_units u WHERE u.analysis_attempt_id=r.id AND u.session_id=s.id))
      ORDER BY julianday(s.ended_at) DESC,s.id DESC LIMIT 20`, cutoff, asOf);
    selected.preview.scope.eligible = rows.length;
    selected.preview.scope.excluded.overCount = Math.max(0, rows.length - 20);
    selected.preview.existingId = this.get<{ id: string }>('SELECT id FROM pattern_reports WHERE fingerprint=?', selected.preview.fingerprint)?.id ?? null;
    return selected;
  }
  preview(asOf = now()) { return this.db.transaction(() => this.selection(asOf).preview)(); }
  create(fingerprint: string, operationId: string, asOf = now()) {
    return this.db.transaction(() => {
      const receipt = this.get<Report>('SELECT * FROM pattern_reports WHERE id=?', operationId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail('operation_conflict');
        const queued = this.get<PatternAttempt>("SELECT * FROM pattern_report_attempts WHERE report_id=? AND status='queued'", receipt.id);
        return { id: receipt.id, reused: !queued, attemptId: queued?.id ?? null };
      }
      const s = this.selection(asOf);
      if (s.preview.fingerprint !== fingerprint) fail('scope_changed');
      if (s.preview.blocked) fail(s.preview.blocked);
      if (s.preview.existingId) return { id: s.preview.existingId, reused: true, attemptId: null };
      if (this.active()) fail('busy');
      const snapshot = JSON.stringify({ scope: s.preview.scope, sources: s.sources, contract: patternContract });
      this.run('INSERT INTO pattern_reports(id,created_at,fingerprint,snapshot) VALUES(?,?,?,?)', operationId, now(), fingerprint, snapshot);
      s.sources.forEach((source, ordinal) => this.run('INSERT INTO pattern_report_sources VALUES(?,?,?,?,?)', operationId, source.session_id, source.analysis_id, source.source_hash, ordinal));
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
    const sources = this.all<{session_id: string; analysis_id: string; source_hash: string}>('SELECT * FROM pattern_report_sources WHERE report_id=?', reportId);
    for (const source of sources) {
      const session = this.get<{selected_analysis_id: string}>('SELECT selected_analysis_id FROM sessions WHERE id=?', source.session_id);
      if (!session) fail('source_deleted');
      if (session!.selected_analysis_id !== source.analysis_id || patternHash(JSON.stringify(this.sourceUnits(source.session_id, source.analysis_id))) !== source.source_hash) fail('source_changed');
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
    validatePatternHtml(html);
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
    return { id: r.id, created_at: r.created_at, scope: JSON.parse(r.snapshot).scope, selected_attempt_id: r.selected_attempt_id,
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
