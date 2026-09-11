/** Older rows have no explicit dispatch timestamp; preserve uncertainty unless known unsent. */
export function memoryOutcomeUncertain(state: string, failure: string | null | undefined): boolean {
  if (failure === 'queued_not_dispatched') return false;
  return state === 'interrupted' || state === 'failed' && ['request_timeout', 'transport_failed', 'stream_idle_timeout', 'request_cancelled'].includes(failure ?? '');
}
export const memoryRetryNotice = 'The previous request may already have been billed. Retrying makes a new request.';
