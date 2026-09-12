import type { DatabaseClient } from './db-client';
import { EmbeddingWorkerClient } from './memory-embedding-client';
import type { EmbeddingJob } from './memory-clusters';
import type { AssociativeEmbeddingJob } from './associative-recall-store';
import { failureCode } from './errors';

/** Local indexing never joins the paid ADD/end-processing pipeline. */
export class MemoryEmbeddingController {
  private engine: EmbeddingWorkerClient | null = null;
  private running: Promise<void> | null = null;
  private current: { kind: 'cold'; job: EmbeddingJob } | { kind: 'associative'; job: AssociativeEmbeddingJob } | null = null;
  private stopped = false;
  private suspended = false;
  private epoch = 0;
  private recoveries = 0;
  private paused = false;
  private wakeSequence = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private db: DatabaseClient, private entry: string, private directory: string,
    private changed: () => void, private make = (entry: string, beforeKill: (reason: string) => Promise<void>) => new EmbeddingWorkerClient(entry, beforeKill)) {}
  async initialize() { await this.db.call('coldInitialize'); this.wake(); }
  wake() {
    this.wakeSequence++;
    if (this.stopped || this.suspended || this.running || this.paused || this.timer) return;
    const wake = this.wakeSequence;
    this.running = this.run().finally(() => {
      this.running = null;
      if (wake !== this.wakeSequence) this.wake();
    });
  }
  private async invalidate(reason: string) {
    this.epoch++;
    if (this.current) {
      if (this.current.kind === 'cold') {
        if (reason === 'cold_worker_stopped') await this.db.call('coldRelease', this.current.job);
        else await this.db.call('coldFail', this.current.job, reason, true);
      } else if (reason === 'cold_worker_stopped') await this.db.call('associativeRelease', this.current.job);
      else await this.db.call('associativeFail', this.current.job, reason, true);
    }
  }
  private async run() {
    try {
      while (!this.stopped && !this.suspended && !this.paused) {
        if (!(await this.db.call('memoryPreference')).enabled) return;
        let changed = await this.db.call('coldTick');
        if (changed) this.changed();
        const coldPending = (await this.db.call('coldStatus')).pending;
        changed += await this.db.call('associativeTick');
        const associativePending = await this.db.call('associativePending');
        if (!coldPending && !associativePending) { if (changed) continue; return; }
        let job: EmbeddingJob | AssociativeEmbeddingJob | null = null;
        // Current and active HOT records are time-sensitive for reply recall;
        // COLD grouping remains resumable and must not starve them.
        let kind: 'cold' | 'associative' = associativePending ? 'associative' : 'cold';
        const epoch = this.epoch;
        try {
          if (!this.engine) {
            this.engine = this.make(this.entry, reason => this.invalidate(reason));
            await this.engine.initialize(this.directory);
          }
          if (this.stopped || this.suspended || epoch !== this.epoch || !(await this.db.call('memoryPreference')).enabled) return;
          job = kind === 'cold' ? await this.db.call('coldClaim') : await this.db.call('associativeClaim');
          if (!job) { if (kind === 'cold' ? await this.db.call('coldTick') : await this.db.call('associativeTick')) continue; return; }
          this.current = { kind, job };
          if (this.stopped || this.suspended || epoch !== this.epoch || !(await this.db.call('memoryPreference')).enabled) {
            if (kind === 'cold') await this.db.call('coldRelease', job as EmbeddingJob); else await this.db.call('associativeRelease', job as AssociativeEmbeddingJob); return;
          }
          const result = await this.engine.embed(job.text);
          if (!this.stopped && epoch === this.epoch) {
            if (kind === 'cold') await this.db.call('coldComplete', job as EmbeddingJob, result);
            else await this.db.call('associativeComplete', job as AssociativeEmbeddingJob, result);
          }
          this.recoveries = 0;
          await this.db.call('coldIndexFailure', null);
          this.changed();
        } catch (error) {
          const reason = failureCode(error);
          if (job) {
            if (kind === 'cold') await this.db.call('coldFail', job as EmbeddingJob, reason, true);
            else await this.db.call('associativeFail', job as AssociativeEmbeddingJob, reason, true);
          }
          if (this.engine) {
            try { await this.engine.stop(reason); }
            catch { this.paused = true; await this.db.call('coldIndexFailure', 'cold_worker_termination'); this.changed(); return; }
            this.engine = null;
          }
          if (this.stopped || this.suspended || !(await this.db.call('memoryPreference')).enabled) return;
          if (['cold_model_missing', 'cold_model_integrity', 'cold_tokenizer_contract'].includes(reason)) this.paused = true;
          if (this.recoveries >= 3) this.paused = true;
          await this.db.call('coldIndexFailure', reason); this.changed();
          if (!this.paused && !this.stopped) {
            const delay = [1000, 5000, 30000][this.recoveries++];
            this.timer = setTimeout(() => { this.timer = null; this.wake(); }, delay);
          }
          return;
        } finally { this.current = null; }
        // Allow other DB requests between bounded local batches.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } catch (error) {
      this.paused = true;
      await this.db.call('coldIndexFailure', failureCode(error)).catch(() => undefined); this.changed();
    }
  }
  async preferenceChanged(enabled: boolean) {
    if (enabled) { this.wake(); return; }
    this.epoch++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.current) {
      if (this.current.kind === 'cold') await this.db.call('coldRelease', this.current.job);
      else await this.db.call('associativeRelease', this.current.job);
    }
    if (this.engine) { await this.engine.stop(); this.engine = null; }
  }
  async retry() {
    if (this.stopped) return;
    await this.db.call('coldRetry');
    this.paused = false; this.recoveries = 0; this.wake();
  }
  async suspend() {
    this.suspended = true; this.epoch++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.engine) { await this.engine.stop(); this.engine = null; }
    await this.running;
  }
  resume() { this.suspended = false; this.wake(); }
  async close() {
    this.stopped = true; this.epoch++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.engine) await this.engine.stop();
    await this.running;
  }
}
