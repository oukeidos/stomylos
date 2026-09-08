/** Amounts cross IPC as decimal USD strings, never as rounded per-request floats. */
export interface UsageSnapshot {
  month: string; timeZone: string; startedAt: string; total: string; reported: string; estimated: string; estimatedRequests: number;
  requests: number; unreported: number; budget: string | null;
  level: 'off' | 'below' | 'near' | 'reached'; percent: string | null;
  warning: boolean;
}

export function validBudget(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && /^\d{1,9}(\.\d{1,2})?$/.test(value) && Number(value) > 0;
}

export function moneyParts(value: string): { units: bigint; scale: number } {
  const [whole, fraction = ''] = value.split('.');
  return { units: BigInt(whole + fraction), scale: fraction.length };
}
export function decimal(units: bigint, scale: number): string {
  const digits = units.toString().padStart(scale + 1, '0');
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') : digits;
}
export function sumMoney(values: string[]): string {
  const parts = values.map(moneyParts), scale = parts.reduce((max, p) => Math.max(max, p.scale), 0);
  return decimal(parts.reduce((sum, p) => sum + p.units * 10n ** BigInt(scale - p.scale), 0n), scale);
}
export function budgetState(total: string, budget: string | null): Pick<UsageSnapshot, 'level' | 'percent'> {
  if (budget === null) return { level: 'off', percent: null };
  const a = moneyParts(total), b = moneyParts(budget), scale = Math.max(a.scale, b.scale);
  const spent = a.units * 10n ** BigInt(scale - a.scale), limit = b.units * 10n ** BigInt(scale - b.scale);
  return { level: spent >= limit ? 'reached' : spent * 100n >= limit * 80n ? 'near' : 'below',
    percent: decimal((spent * 1000n) / limit, 1) };
}
export function displayMoney(value: string): string {
  const { units, scale } = moneyParts(value);
  const cents = scale > 2 ? (units + 5n * 10n ** BigInt(scale - 3)) / 10n ** BigInt(scale - 2) : units * 10n ** BigInt(2 - scale);
  if (cents === 0n && units > 0n) return '<$0.01';
  const digits = cents.toString().padStart(3, '0');
  return `$${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
