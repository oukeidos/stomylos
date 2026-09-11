export type ExitChoice = 'stay' | 'exit';
export interface ExitHooks {
  prepare(id: number, retry: boolean): void;
  cancel(): void;
  finishPreparation(current: () => boolean): Promise<boolean>;
  failed(): boolean;
  choose(copy: () => Promise<string>): Promise<ExitChoice>;
  copy(): Promise<string>;
  teardown(): Promise<void>;
  exit(): void;
}
/** Main-owned: neither the command queue nor the renderer can prevent confirmed exit. */
export class ExitController {
  private sequence = 0;
  private active = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private deciding = false;
  private completing = 0;
  exiting = false;
  constructor(private hooks: ExitHooks, private prepareMs = 5000, private teardownMs = 2000) {}
  private clearTimer() { clearTimeout(this.timer); this.timer = undefined; }
  request(options = false, retry = false) {
    if (this.exiting || this.active || this.deciding) return;
    this.active = ++this.sequence;
    if (options || this.hooks.failed() && !retry) { void this.decide(); return; }
    this.timer = setTimeout(() => { void this.decide(); }, this.prepareMs);
    this.hooks.prepare(this.active, retry);
  }
  async prepared(id: number, outcome: 'ready' | 'cancelled' | 'blocked') {
    if (id !== this.active || this.exiting || this.deciding || this.completing === id) return;
    if (outcome === 'cancelled') { this.stay(); return; }
    if (outcome === 'blocked') { await this.decide(); return; }
    this.completing = id;
    const current = () => this.active === id && !this.deciding && !this.exiting;
    try {
      const ready = await this.hooks.finishPreparation(current);
      if (!current()) return;
      if (ready) this.finish(); else await this.decide();
    } catch { if (current()) await this.decide(); }
    finally { if (this.completing === id) this.completing = 0; }
  }
  private stay() {
    this.clearTimer(); this.active = 0; this.hooks.cancel();
  }
  private async decide() {
    if (this.deciding || this.exiting || !this.active) return;
    this.clearTimer(); this.deciding = true;
    // Invalidate the old preparation before presenting choices: late work may save,
    // but may never close the database or quit after Stay.
    this.active = ++this.sequence; this.hooks.cancel();
    try {
      const choice = await this.hooks.choose(() => this.copy());
      if (choice === 'exit') this.finish(); else this.stay();
    } catch { this.stay(); }
    finally { this.deciding = false; }
  }
  private async copy() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.hooks.copy(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('copy_timeout')), 3000);
      })]);
    } catch { return 'Copy could not be confirmed'; }
    finally { clearTimeout(timer); }
  }
  private finish() {
    if (this.exiting) return;
    this.exiting = true; this.clearTimer(); this.active = 0;
    let done = false;
    const exit = () => { if (!done) { done = true; clearTimeout(timer); this.hooks.exit(); } };
    const timer = setTimeout(exit, this.teardownMs);
    // teardown seals admission synchronously before returning its promise.
    try { void this.hooks.teardown().then(exit, exit); } catch { exit(); }
  }
}
