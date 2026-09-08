import { Worker } from 'node:worker_threads';
import type { DictationProgress } from '../shared/asr';
import { AppFailure } from './errors';

export interface CaptureEncoder {
  push(sequence: number, pcm: Int16Array): Promise<DictationProgress>;
  finish(): Promise<Uint8Array>;
  discard(): Promise<void>;
}
export class CaptureWorker implements CaptureEncoder {
  private worker: Worker;
  private next = 0;
  private dead = false;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(path: string) {
    this.worker = new Worker(path);
    this.worker.on('message', message => {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new AppFailure(message.error)); else pending.resolve(message.result);
    });
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => this.fail());
  }
  static async create(path: string) {
    const worker = new CaptureWorker(path);
    try { await worker.call('start'); return worker; }
    catch (error) { await worker.discard(); throw error; }
  }
  private fail() {
    this.dead = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new AppFailure('asr_encoder_stopped')); }
    this.pending.clear();
  }
  private call(method: string, args = {}): Promise<any> {
    if (this.dead) return Promise.reject(new AppFailure('asr_encoder_stopped'));
    if (this.pending.size >= 5) return Promise.reject(new AppFailure('asr_encoder_backpressure'));
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.fail(); void this.worker.terminate(); }, 15_000);
      this.pending.set(id, { resolve, reject, timer }); this.worker.postMessage({ id, method, ...args });
    });
  }
  push(sequence: number, pcm: Int16Array) { return this.call('push', { sequence, pcm }) as Promise<DictationProgress>; }
  async finish() { try { return await this.call('finish') as Uint8Array; } finally { await this.discard(); } }
  async discard() { this.fail(); await this.worker.terminate(); }
}
