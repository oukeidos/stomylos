import { prepareProviderRequest, type ProviderRequest } from './provider-policy';
import type { SearchAttempt, SearchView } from '../shared/search';
import type { Json } from '../shared/types';
import type { Gateway } from './transport';
import { CompletionFailure } from './transport';
import { AppFailure, failureCode } from './errors';
import { recoverableSearchFailure, searchBoolean, searchHash, validateSearchSnapshot } from './search-contract';

export interface SearchRoutingStore {
  prepareProvider?(id: string, body: Json): Promise<ProviderRequest>;
  view(): Promise<SearchView | null>;
  prepare(): Promise<SearchAttempt | null>;
  dispatch(id: string): Promise<void>;
  finish(id: string, content: string | null, metadata: Json, failure: string | null, interrupted: boolean): Promise<void>;
}
export async function routeSearch(store: SearchRoutingStore, gateway: Gateway, signal: AbortSignal) {
  for (;;) {
    if (signal.aborted) throw new AppFailure('request_cancelled');
    const view = await store.view();
    if (!view || view.turn.decision) return;
    const config = JSON.parse(view.turn.config); validateSearchSnapshot(config);
    const attempt = await store.prepare(); if (!attempt) return;
    if (searchHash(attempt.config) !== attempt.config_hash) throw new AppFailure('search_source_changed');
    const spent = view.attempts.reduce((sum, a) => {
      if (!a.dispatched_at) return sum;
      const ms = JSON.parse(a.metadata).routing_network_ms;
      return sum + (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : config.attempt_timeout_ms);
    }, 0);
    const timeoutMs = Math.max(0, Math.min(config.attempt_timeout_ms, config.total_timeout_ms - spent));
    if (signal.aborted) throw new AppFailure('request_cancelled');
    if (!timeoutMs) { await store.finish(attempt.id, null, {}, 'routing_deadline', false); continue; }
    await store.dispatch(attempt.id);
    if (signal.aborted) { await store.finish(attempt.id, null, {}, 'request_cancelled', true); throw new AppFailure('request_cancelled'); }
    let content: string | null = null; let metadata: Json = {};
    let failure: string | null = null;
    const input = JSON.parse(attempt.config);
    const routed = store.prepareProvider ? await store.prepareProvider(attempt.id, input) : prepareProviderRequest(input);
    const started = performance.now();
    try {
      const result = await gateway.stream(routed.body, signal, () => undefined, { gate: true, timeoutMs });
      content = result.content; metadata = result.metadata;
      if (signal.aborted) throw new AppFailure('request_cancelled');
      searchBoolean(content);
    } catch (error) {
      failure = failureCode(error);
      if (error instanceof CompletionFailure) { content = error.content; metadata = error.metadata; }
    }
    metadata = { ...metadata, routing_network_ms: performance.now() - started };
    // Persistence sits outside the network catch: save-only retries cannot repeat inference.
    await store.finish(attempt.id, content, metadata, failure, signal.aborted);
    if (signal.aborted) throw new AppFailure('request_cancelled');
    if (failure && !recoverableSearchFailure(failure)) throw new AppFailure(failure);
  }
}
