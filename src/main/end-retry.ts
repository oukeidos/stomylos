import { AppFailure, HttpFailure } from './errors';

/** null means manual recovery; local/storage errors never redispatch inference. */
export function endRetryDelay(error: unknown): number | null {
  if (!(error instanceof AppFailure)) return null;
  const code = error.code;
  if (/cancel|api_key|unsupported|settings|input_too_large|stale|source_changed|storage|hash_mismatch/.test(code)) return null;
  if (/^http_/.test(code) && !/^http_(408|429|5\d\d)$/.test(code)) return null;
  if (error instanceof HttpFailure && error.retryAfterMs !== null && error.retryAfterMs > 30000) return null;
  const transient = /^(transport_failed|request_timeout|stream_idle_timeout|http_(408|429|5\d\d)|provider_api_error)$/.test(code);
  const validation = /^(response_.+|grammar_(schema|source_count|source_text|source_index|empty_correction_or_note)|memory_(patch|operation|source|add_id|target|delete_fields|replacement|item|duplicate_item|budget|cleanup_format|cleanup_over_cap)|starter_output_format|unexpected_tool_call)$/.test(code);
  if (!transient && !validation) return null;
  return Math.max(transient ? 2000 : 0, error instanceof HttpFailure ? error.retryAfterMs ?? 0 : 0);
}

export function waitEndRetry(delay: number, signal: AbortSignal): Promise<void> {
  if (!delay || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, delay);
    signal.addEventListener('abort', done, { once: true });
  });
}
