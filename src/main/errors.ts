export class AppFailure extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'AppFailure'; }
}
export function failureCode(error: unknown): string {
  if (error instanceof AppFailure) return error.code;
  return 'operation_failed';
}

/** Retry-After is retained only as a bounded numeric delay, never response text. */
export class HttpFailure extends AppFailure {
  readonly retryAfterMs: number | null;
  constructor(status: number, retryAfter: string | null = null, now = Date.now()) {
    super(`http_${status}`);
    const value = retryAfter?.trim();
    const milliseconds = value && /^\d+$/.test(value) ? Number(value) * 1000
      : value ? Date.parse(value) - now : NaN;
    this.retryAfterMs = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : null;
  }
}
