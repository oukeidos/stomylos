import { afterEach, expect, it, vi } from 'vitest';
import { AppFailure, HttpFailure } from '../src/main/errors';
import { endRetryDelay, waitEndRetry } from '../src/main/end-retry';
import { OpenRouter } from '../src/main/transport';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('retries only transient and output errors and respects bounded Retry-After', () => {
  for (const status of [400,401,402,403,404,405,422]) expect(endRetryDelay(new HttpFailure(status))).toBeNull();
  for (const status of [408,429,500,503]) expect(endRetryDelay(new HttpFailure(status))).toBe(2000);
  expect(endRetryDelay(new HttpFailure(429, '12'))).toBe(12000);
  expect(endRetryDelay(new HttpFailure(503, '30'))).toBe(30000);
  expect(endRetryDelay(new HttpFailure(429, '31'))).toBeNull();
  expect(endRetryDelay(new HttpFailure(503, 'Tue, 08 Sep 2026 12:00:10 GMT', Date.parse('2026-09-08T12:00:00Z')))).toBe(10000);
  expect(endRetryDelay(new HttpFailure(503, 'invalid'))).toBe(2000);
  for (const code of ['response_invalid_json','grammar_source_count','memory_source','memory_cleanup_over_cap','starter_output_format']) expect(endRetryDelay(new AppFailure(code))).toBe(0);
  for (const code of ['request_cancelled','memory_stale','memory_candidate_changed','operation_failed','memory_source_changed']) expect(endRetryDelay(new AppFailure(code))).toBeNull();
  expect(endRetryDelay(new Error('disk full'))).toBeNull();
});
it('cancellation interrupts the retry wait without a remaining timer', async () => {
  vi.useFakeTimers(); const abort = new AbortController();
  const pending = waitEndRetry(30000, abort.signal); abort.abort(); await pending;
  expect(vi.getTimerCount()).toBe(0);
});
it('retains HTTP retry timing and rejects embedded permanent provider errors', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After':'31' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 402, message: 'balance' } })));
  vi.stubGlobal('fetch', fetcher);
  const gateway = new OpenRouter(() => 'fake'); const signal = new AbortController().signal;
  await expect(gateway.complete({}, {}, signal, 1000)).rejects.toMatchObject({ code: 'http_429', retryAfterMs: 31000 });
  await expect(gateway.complete({}, {}, signal, 1000)).rejects.toMatchObject({ code: 'http_402' });
});
