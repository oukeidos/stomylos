import { utilityProcess } from 'electron';
import { AppFailure } from './errors';

export interface EmbeddingProcess {
  on(event: string, listener: (...args: any[]) => void): unknown;
  postMessage(message: unknown): void;
  kill(): boolean;
}
export class EmbeddingWorkerClient {
  private sequence = 0;
  private terminal = false;
  private exited = false;
  private exitListeners = new Set<() => void>();
  private stopping: Promise<void> | null = null;
  private pending: { id: number; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private process: EmbeddingProcess;
  constructor(entry: string, private beforeKill: (reason: string) => Promise<void>,
    factory: (entry: string) => EmbeddingProcess = path => utilityProcess.fork(path, [], { serviceName: 'Local memory embeddings', stdio: 'ignore' }),
    private deadlines = { init: 60_000, item: 30_000, termination: 2_000 }) {
    this.process = factory(entry);
    this.process.on('message', message => {
      if (this.terminal || !this.pending || message.id !== this.pending.id) return;
      const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
      if (message.error) pending.reject(new AppFailure(message.error)); else pending.resolve(message.result);
    });
    this.process.on('exit', () => {
      this.exited = true; for (const listener of this.exitListeners) listener(); this.exitListeners.clear();
      if (!this.terminal) void this.stop('cold_worker_exit').catch(() => undefined);
    });
    this.process.on('error', () => { void this.stop('cold_worker_exit').catch(() => undefined); });
  }
  private call(method: 'init' | 'embed', args: object): Promise<any> {
    if (this.terminal || this.pending) return Promise.reject(new AppFailure('cold_worker_unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { void this.stop(method === 'init' ? 'cold_init_timeout' : 'cold_item_timeout').catch(() => undefined); }, method === 'init' ? this.deadlines.init : this.deadlines.item);
      this.pending = { id, resolve, reject, timer };
      try { this.process.postMessage({ id, method, ...args }); }
      catch { void this.stop('cold_worker_exit').catch(() => undefined); }
    });
  }
  async initialize(directory: string) { await this.call('init', { directory }); }
  async embed(text: string): Promise<{ vector: number[]; inputHash: string; chunkCount: number }> { return this.call('embed', { text }); }
  stop(reason = 'cold_worker_stopped'): Promise<void> {
    if (this.stopping) return this.stopping;
    this.terminal = true;
    const pending = this.pending; this.pending = null;
    if (pending) clearTimeout(pending.timer);
    this.stopping = (async () => {
      // Seal result admission and revoke the durable lease before terminating native work.
      let invalidationError: unknown;
      try { await this.beforeKill(reason); } catch (error) { invalidationError = error; }
      if (!this.exited) {
        await new Promise<void>((resolve, reject) => {
          const done = () => { clearTimeout(timer); this.exitListeners.delete(done); resolve(); };
          const timer = setTimeout(() => { this.exitListeners.delete(done); reject(new AppFailure('cold_worker_termination')); }, this.deadlines.termination);
          this.exitListeners.add(done);
          this.process.kill();
          if (this.exited) done();
        });
      }
      if (invalidationError) throw invalidationError;
    })();
    // A caller cannot retry/spawn until actual termination has completed or failed visibly.
    this.stopping.then(() => pending?.reject(new AppFailure(reason)), error => pending?.reject(error));
    return this.stopping;
  }
}
