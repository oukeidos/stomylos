import type { DatabaseClient } from './db-client';
import type { Store, StoreMethod } from './database';
import type { Gateway } from './transport';
import { CompletionFailure } from './transport';
import { AppFailure, failureCode } from './errors';
import { patternLimits, validatePatternHtml, patternResponsePolicy } from './pattern-report';
import type { PatternCommandArgs, PatternCommandResults, PatternState } from '../shared/pattern-report';
import type { Json } from '../shared/types';

interface Hooks {
  write<K extends StoreMethod>(method: K, ...args: Parameters<Store[K]>): Promise<ReturnType<Store[K]>>;
  publish(state: PatternState): void;
  open(id: string, html: string, createdAt: string): Promise<void>;
  closeViewer(id?: string): void;
  retrySave(): Promise<void>;
}
export class PatternReportController {
  get backupBusy() { return this.flight !== null || ['saving', 'save_failed'].includes(this.state.phase); }
  private state: PatternState = { revision: 0, reportId: null, phase: 'idle', startedAt: null, error: null };
  private flight: { id: string; reportId: string; abort: AbortController; promise: Promise<void> } | null = null;
  private control: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private db: DatabaseClient, private gateway: Gateway, private hooks: Hooks) {}
  snapshot() { return structuredClone(this.state); }
  private publish() { this.state.revision++; this.hooks.publish(this.snapshot()); }
  command<K extends keyof PatternCommandArgs>(name: K, args: PatternCommandArgs[K]): Promise<PatternCommandResults[K]> {
    if (name === 'patternRelated') return this.db.call('patternRelated', (args as {id: string}).id) as Promise<PatternCommandResults[K]>;
    if (name === 'patternState') return Promise.resolve(this.snapshot()) as Promise<PatternCommandResults[K]>;
    if (name === 'patternClose') { this.hooks.closeViewer(); return Promise.resolve() as Promise<PatternCommandResults[K]>; }
    if (name === 'patternPreview') return this.db.call('patternPreview', undefined, args as PatternCommandArgs['patternPreview']) as Promise<PatternCommandResults[K]>;
    if (name === 'patternList') return this.db.call('patternList', (args as PatternCommandArgs['patternList']).offset) as Promise<PatternCommandResults[K]>;
    if (name === 'patternDetail') return this.db.call('patternDetail', (args as { id: string }).id) as Promise<PatternCommandResults[K]>;
    if (name === 'patternRetrySave') return this.hooks.retrySave() as Promise<PatternCommandResults[K]>;
    const operation = this.control.then(async () => {
      if (this.closed) throw new AppFailure('pattern_closed');
      const a = args as { id: string; fingerprint: string; operationId: string; selection?: import('../shared/pattern-report').PatternSelection };
      switch (name) {
        case 'patternCreate': {
          const result = await this.hooks.write('patternCreate', a.fingerprint, a.operationId, undefined, a.selection);
          if (result.attemptId && !this.flight) this.dispatch(result.attemptId, result.id);
          return { id: result.id, reused: result.reused };
        }
        case 'patternRetry': {
          const attempt = await this.hooks.write('patternRetry', a.id, a.operationId);
          if (attempt.status === 'queued' && !this.flight) this.dispatch(attempt.id, attempt.report_id);
          return;
        }
        case 'patternCancel': return this.cancel(a.id);
        case 'patternOpen': {
          const report = await this.db.call('patternHtml', a.id);
          await this.hooks.open(a.id, report.html, report.createdAt); return;
        }
        case 'patternClose': this.hooks.closeViewer(); return;
        case 'patternDelete':
          await this.cancel(a.id); this.hooks.closeViewer(a.id);
          await this.hooks.write('patternDelete', a.id);
          if (this.state.reportId === a.id) this.state = { ...this.state, reportId: null, startedAt: null, error: null };
          this.publish(); return;
      }
    });
    this.control = operation.catch(() => undefined);
    return operation as Promise<PatternCommandResults[K]>;
  }
  private dispatch(id: string, reportId: string) {
    const abort = new AbortController();
    this.state = { ...this.state, reportId, phase: 'generating', error: null, startedAt: new Date().toISOString() };
    const promise = this.run(id, reportId, abort);
    this.flight = { id, reportId, abort, promise }; this.publish();
  }
  private async run(id: string, reportId: string, abort: AbortController) {
    let html: string | null = null, metadata: Json = {}; const start = performance.now();
    try {
      const attempt = await this.hooks.write('patternDispatch', id);
      if (abort.signal.aborted) throw new AppFailure('request_cancelled');
      const routed = await this.hooks.write('prepareProvider', 'pattern', id, JSON.parse(attempt.request), attempt.contract.identity);
      const result = await this.gateway.complete(routed.body, routed.identity!, abort.signal, attempt.contract.timeout_ms, patternResponsePolicy(attempt.contract));
      metadata = { ...result.metadata, elapsed_seconds: (performance.now() - start) / 1000 };
      html = result.content;
      if (abort.signal.aborted) throw new AppFailure('request_cancelled');
      validatePatternHtml(html, attempt.contract);
      this.state.phase = 'saving'; this.publish();
      await this.hooks.write('patternSave', id, html, metadata);
    } catch (error) {
      const code = failureCode(error);
      if (error instanceof CompletionFailure) { html = error.content; metadata = error.metadata; }
      metadata = { ...metadata, elapsed_seconds: (performance.now() - start) / 1000 };
      if (html !== null && Buffer.byteLength(html) > patternLimits.html) { metadata.discarded_html_bytes = Buffer.byteLength(html); html = null; }
      this.state.error = code; this.state.phase = 'saving'; this.publish();
      try { await this.hooks.write('patternFinish', id, abort.signal.aborted ? 'cancelled' : 'failed', code, html, metadata); }
      catch (saveError) { this.state.error = failureCode(saveError); }
    } finally {
      if (this.flight?.id === id) this.flight = null;
      this.state.phase = 'idle'; this.state.reportId = reportId; this.publish();
    }
  }
  async cancel(reportId: string) {
    const flight = this.flight;
    if (!flight || flight.reportId !== reportId) return;
    if (this.state.phase === 'saving') throw new AppFailure('save_required');
    flight.abort.abort(); await flight.promise;
  }
  async sourceDeleting(sessionId: string) {
    const affected = await this.db.call('patternAffected', sessionId);
    if (this.flight && affected.includes(this.flight.reportId)) await this.cancel(this.flight.reportId);
  }
  databaseFailed() { this.flight?.abort.abort(); this.hooks.closeViewer(); }
  resumeAfterCloseFailure() { this.closed = false; }
  async close() {
    this.closed = true;
    this.flight?.abort.abort();
    await this.control;
    if (this.flight) { this.flight.abort.abort(); await this.flight.promise; }
    this.hooks.closeViewer();
  }
}
