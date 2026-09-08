import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from './db-client';
import type { Store, StoreMethod } from './database';
import type { IntentionJob } from '../shared/intention';
import type { Json } from '../shared/types';
import type { Gateway } from './transport';
import { CompletionFailure } from './transport';
import { AppFailure, failureCode } from './errors';
import { intentionBody, intentionPolicy } from './intention-questions';

type Hooks = {
  write<K extends StoreMethod>(method: K, ...args: Parameters<Store[K]>): Promise<ReturnType<Store[K]>>;
  changed(sessionId: string): Promise<void>;
  ready(sessionId: string): Promise<void>;
  error(code: string): void;
};
// Only sessions authorized in this process are scheduled. Recovery never replays
// paid requests on startup; a user action explicitly reauthorizes pending work.
export class IntentionController {
  get backupBusy() { return this.sessions.size > 0 || this.active.size > 0 || this.ticking !== null; }
  private sessions = new Set<string>();
  private cancelled = new Set<string>();
  private active = new Map<string, { sessionId: string; abort: AbortController; promise: Promise<void> }>();
  private timer?: ReturnType<typeof setTimeout>;
  private ticking: Promise<void> | null = null;
  private wake = 0;
  private closed = false;
  constructor(private db: DatabaseClient, private gateway: Gateway, private hooks: Hooks) {}
  authorize(id: string) { if (this.closed || this.cancelled.has(id)) return; this.sessions.add(id); this.wake++; this.pump(); }
  private pump() {
    if (this.closed || this.ticking) return;
    clearTimeout(this.timer); const wake = this.wake;
    this.ticking = this.tick().catch(e => this.hooks.error(failureCode(e))).finally(() => {
      this.ticking = null;
      if (!this.closed && (this.sessions.size || wake !== this.wake)) this.timer = setTimeout(() => this.pump(), wake !== this.wake ? 0 : 1000);
    });
  }
  private async tick() {
    for (const sessionId of [...this.sessions]) {
      if (this.closed || !this.sessions.has(sessionId)) continue;
      const released = await this.hooks.write('advanceStarter', sessionId);
      const jobs = await this.db.call('intentionJobs', sessionId);
      for (const job of jobs) {
        const active = this.active.get(job.id);
        if (active && !['pending','running','received'].includes(job.state)) active.abort.abort();
        if (job.state === 'received') await this.hooks.write('acceptIntention', job.id);
        if (job.state === 'pending' && !active && this.active.size < intentionPolicy.concurrency && !this.closed && this.sessions.has(sessionId)) {
          const abort = new AbortController();
          const promise = Promise.resolve().then(() => this.generate(job, abort.signal)).catch(e => this.hooks.error(failureCode(e))).finally(async () => {
            this.active.delete(job.id);
            if (this.sessions.has(sessionId)) { await this.hooks.changed(sessionId).catch(() => undefined); this.wake++; this.pump(); }
          });
          this.active.set(job.id, { sessionId, abort, promise });
        }
      }
      if (released && !this.closed && this.sessions.has(sessionId)) {
        await this.hooks.ready(sessionId);
        if (!jobs.some(j => ['pending','running','received'].includes(j.state))) {
          this.sessions.delete(sessionId); await this.hooks.changed(sessionId);
        }
      }
    }
  }
  private async generate(initial: IntentionJob, signal: AbortSignal) {
    for (;;) {
      const job = await this.db.call('intentionJob', initial.id);
      if (signal.aborted || job.state !== 'pending') return;
      const config = JSON.parse(job.config);
      const attempt = await this.hooks.write('dispatchIntention', job.id, randomUUID());
      if (!attempt) return;
      let content: string | null = null, metadata: Json = {}; const started = performance.now();
      try {
        if (signal.aborted) throw new AppFailure('request_cancelled');
        const body = intentionBody(config, job.input_json, attempt.route);
        const timeout = Math.max(1, Math.min(config.policy.attemptMs, Date.parse(job.deadline) - Date.now()));
        const result = await this.gateway.complete(body, config.routes[attempt.route].response_identity, signal, timeout);
        content = result.content; metadata = { ...result.metadata, elapsed_seconds: (performance.now() - started) / 1000 };
        if (signal.aborted) throw new AppFailure('request_cancelled');
        await this.hooks.write('receiveIntention', attempt.id, content, metadata);
        await this.hooks.write('acceptIntention', job.id); return;
      } catch (error) {
        if (error instanceof CompletionFailure) { content = error.content; metadata = { ...metadata, ...error.metadata }; }
        metadata.elapsed_seconds = (performance.now() - started) / 1000;
        await this.hooks.write('failIntention', attempt.id, failureCode(error), content, metadata, signal.aborted);
      }
    }
  }
  async cancel(sessionId: string) {
    this.cancelled.add(sessionId); this.sessions.delete(sessionId);
    // Wait for an in-progress tick to finish before deleting its database source.
    await this.ticking;
    const active = [...this.active.values()].filter(a => a.sessionId === sessionId);
    active.forEach(a => a.abort.abort()); await Promise.all(active.map(a => a.promise));
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); this.sessions.clear();
    await this.ticking;
    const active = [...this.active.values()]; active.forEach(a => a.abort.abort());
    await Promise.all(active.map(a => a.promise));
  }
  resume() { this.closed = false; }
}
