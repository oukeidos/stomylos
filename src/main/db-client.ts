import { Worker } from 'node:worker_threads';
import type { Store, StoreMethod } from './database';
import { AppFailure } from './errors';
export class DatabaseClient {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private terminal = false;
  readonly ready: Promise<void>;
  constructor(entry: string, directory: string, nativePath: string, onFailure: () => void, externallyLocked = false) {
    this.worker = new Worker(entry, { workerData: { directory, nativePath, externallyLocked } });
    let readyResolve!: () => void; let readyReject!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const fail = (code: string) => {
      if (this.terminal) return;
      this.terminal = true; const error = new AppFailure(code); readyReject(error);
      for (const callback of this.pending.values()) callback.reject(error);
      this.pending.clear(); onFailure();
    };
    this.worker.on('message', message => {
      if (message.type === 'ready') { readyResolve(); return; }
      if (message.type === 'startup-error') { fail(message.error); return; }
      const callback = this.pending.get(message.id); if (!callback) return;
      this.pending.delete(message.id);
      if (message.error) callback.reject(new AppFailure(message.error)); else callback.resolve(message.value);
    });
    this.worker.on('error', () => fail('database_worker_failed'));
    this.worker.on('exit', () => fail('database_worker_stopped'));
  }
  async call<K extends StoreMethod>(method: K, ...args: Parameters<Store[K]>): Promise<ReturnType<Store[K]>> {
    await this.ready;
    if (this.terminal) throw new AppFailure('database_worker_stopped');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, method, args });
    });
  }
  async close() { await this.call('close'); this.terminal = true; }
}
