import Database from 'better-sqlite3';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppFailure } from './errors';
import { budgetState, sumMoney, validBudget, type UsageSnapshot } from '../shared/usage';

/** Called exactly at network dispatch, independent of UI/job/source lifetimes. */
export interface UsageRecorder {
  begin(estimate?: { amount: string; basis: string }): string | undefined;
  report(id: string | undefined, cost: unknown): void;
}
export function reportedMoney(cost: unknown): string | null {
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null;
  const [coefficient, exponent = '0'] = cost.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const digits = whole + fraction, point = whole.length + Number(exponent);
  return point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length
    ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
}
export function usageMonth(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}`;
}

/** Device-local ledger: intentionally outside chat deletion and history backup/restore.
 * The application's existing directory lock must be held by the caller.
 * No transcript, model input, provider account ID or credential is stored here.
 */
export class UsageStore implements UsageRecorder {
  private db?: Database.Database;
  private warning = false;
  constructor(directory: string, private changed: () => void = () => undefined,
    private now: () => Date = () => new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    const path = join(directory, 'usage.sqlite3');
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const existing = existsSync(path);
      if (existing && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('Invalid ledger');
      if (existing) {
        // Refuse incompatible/corrupt ledgers before any journal or recovery writes.
        const check = new Database(path, { readonly: true, fileMustExist: true });
        try {
          if (check.pragma('user_version', { simple: true }) !== 1 || check.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Invalid ledger');
          check.prepare('SELECT id,started_at,time_zone,budget,incomplete FROM preferences').all();
          check.prepare('SELECT id,dispatched_at,month,cost,estimate,estimate_basis FROM charges LIMIT 0').all();
        } finally { check.close(); }
      }
      this.db = new Database(path); chmodSync(path, 0o600);
      this.db.pragma('journal_mode = DELETE'); this.db.pragma('synchronous = FULL'); this.db.pragma('busy_timeout = 1000');
      if (!existing) {
        const started = this.now().toISOString(); usageMonth(new Date(started), timeZone);
        this.db.transaction(() => {
          this.db!.exec(`CREATE TABLE preferences (id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL, time_zone TEXT NOT NULL, budget TEXT, incomplete INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE charges (id TEXT PRIMARY KEY, dispatched_at TEXT NOT NULL, month TEXT NOT NULL, cost TEXT, estimate TEXT, estimate_basis TEXT);
            CREATE INDEX charges_month ON charges(month);
            PRAGMA user_version = 1;`);
          this.db!.prepare('INSERT INTO preferences(id,started_at,time_zone) VALUES(1,?,?)').run(started, timeZone);
        })();
      }
      if (this.db.pragma('user_version', { simple: true }) !== 1 || this.db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Invalid ledger');
      const p = this.preferences();
      if (!p || !validBudget(p.budget) || !Number.isFinite(Date.parse(p.started_at)) || ![0, 1].includes(p.incomplete)) throw new Error('Invalid preferences');
      usageMonth(this.now(), p.time_zone);
      this.warning = p.incomplete === 1;
    } catch {
      this.db?.close(); this.db = undefined; this.warning = true;
    }
  }
  private preferences() {
    return this.db!.prepare('SELECT * FROM preferences WHERE id=1').get() as { started_at: string; time_zone: string; budget: string | null; incomplete: number };
  }
  private failed() {
    const notify = !this.warning; this.warning = true;
    try { this.db?.prepare('UPDATE preferences SET incomplete=1 WHERE id=1').run(); } catch { /* Keep a visible in-process warning even when the disk is unavailable. */ }
    if (notify) this.changed();
  }
  begin(estimate?: { amount: string; basis: string }) {
    if (!this.db) { this.failed(); return undefined; }
    try {
      const id = randomUUID(), date = this.now(), p = this.preferences();
      this.db.prepare('INSERT INTO charges VALUES(?,?,?,NULL,?,?)').run(id, date.toISOString(), usageMonth(date, p.time_zone), estimate?.amount ?? null, estimate?.basis ?? null);
      if (this.warning) this.db.prepare('UPDATE preferences SET incomplete=1 WHERE id=1').run();
      this.changed(); return id;
    } catch { this.failed(); return undefined; }
  }
  report(id: string | undefined, cost: unknown) {
    const amount = reportedMoney(cost);
    if (!id || amount === null || !this.db) return;
    try {
      // Stream observations overwrite the same dispatch, never add child/detail charges.
      const result = this.db.prepare('UPDATE charges SET cost=? WHERE id=? AND (cost IS NULL OR cost!=?)').run(amount, id, amount);
      if (result.changes) this.changed();
    } catch { this.failed(); }
  }
  snapshot(): UsageSnapshot {
    if (!this.db) throw new AppFailure('usage_unavailable');
    try {
      const p = this.preferences(), month = usageMonth(this.now(), p.time_zone);
      const rows = this.db.prepare('SELECT cost,estimate FROM charges WHERE month=?').all(month) as { cost: string | null; estimate: string | null }[];
      if (rows.some(row => [row.cost, row.estimate].some(value => value !== null && !/^\d+(\.\d+)?$/.test(value)))) throw new Error('Invalid amount');
      const reported = sumMoney(rows.flatMap(row => row.cost === null ? [] : [row.cost]));
      const estimates = rows.filter(row => row.cost === null && row.estimate !== null);
      const estimated = sumMoney(estimates.map(row => row.estimate!)), total = sumMoney([reported, estimated]);
      return { month, timeZone: p.time_zone, startedAt: p.started_at, total, reported, estimated, estimatedRequests: estimates.length, requests: rows.length,
        unreported: rows.filter(row => row.cost === null && row.estimate === null).length, budget: p.budget,
        ...budgetState(total, p.budget), warning: this.warning || p.incomplete === 1 };
    } catch { this.failed(); throw new AppFailure('usage_unavailable'); }
  }
  setBudget(amount: string | null) {
    if (!validBudget(amount)) throw new AppFailure('usage_invalid_budget');
    if (!this.db) throw new AppFailure('usage_unavailable');
    try { this.db.prepare('UPDATE preferences SET budget=? WHERE id=1').run(amount); }
    catch { this.failed(); throw new AppFailure('usage_save_failed'); }
    this.changed(); return this.snapshot();
  }
  close() { this.db?.close(); this.db = undefined; }
}
