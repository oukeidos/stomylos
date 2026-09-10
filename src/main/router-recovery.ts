import { isDeepStrictEqual } from 'node:util';
import { eightRouterPrompts } from './compact-router';
import type { Json, RequestRecord } from '../shared/types';
import { AppFailure, failureCode } from './errors';
import { config, hash, routerScores } from './contracts';
import { CompletionFailure, type Gateway } from './transport';

export const routerRecoveryVersion = 'stomylos_router_recovery_v1';
export const routerRecoveryPolicy = { totalMs: 8000, attemptMs: [3000, 5000], models: ['openai/gpt-5.6-luna', 'openai/gpt-5.6-terra'] } as const;
export function recoverySnapshot(primary: Json): Json {
  validateRecovery(primary);
  if (primary.recovery_attempt !== 0) throw new AppFailure('router_recovery_exhausted');
  return { ...structuredClone(primary), recovery_attempt: 1, timeout_seconds: 5,
    parameters: { ...structuredClone(primary.parameters), model: routerRecoveryPolicy.models[1] },
    response_identity: { allowed_models: [routerRecoveryPolicy.models[1]], provider: 'OpenAI' } };
}
export function validateRecovery(snapshot: Json) {
  const index = snapshot.recovery_attempt;
  if (snapshot.recovery_version !== routerRecoveryVersion || ![0, 1].includes(index) ||
    snapshot.parameters?.model !== routerRecoveryPolicy.models[index as 0 | 1] ||
    snapshot.timeout_seconds * 1000 !== routerRecoveryPolicy.attemptMs[index as 0 | 1] ||
    snapshot.prompt_sha256 !== hash(snapshot.prompt) || !Object.values(eightRouterPrompts).includes(snapshot.prompt) ||
    !isDeepStrictEqual(snapshot.parameters.reasoning, config.router.model.reasoning) ||
    !isDeepStrictEqual(snapshot.parameters.response_format, config.router.response_format) ||
    !isDeepStrictEqual(snapshot.parameters.provider, { only: config.router.provider.only, require_parameters: true, data_collection: 'deny', allow_fallbacks: false }) ||
    snapshot.parameters.stream !== false || snapshot.parameters.max_tokens !== 512 ||
    !isDeepStrictEqual(snapshot.response_identity, { allowed_models: [routerRecoveryPolicy.models[index as 0 | 1]], provider: 'OpenAI' })) throw new AppFailure('router_recovery_changed');
}
interface IO {
  dispatch(id: string): Promise<unknown>;
  finish(id: string, content: string | null, metadata: Json, failure: string | null, terminal: boolean, interrupted: boolean): Promise<unknown>;
  secondary(id: string): Promise<RequestRecord>;
}
/** Only network/response validation failures enter recovery. Persistence is outside the catch. */
export async function recoverRouter(first: RequestRecord, saved: Json, body: Json, io: IO, gateway: Gateway, signal: AbortSignal) {
  let request = first, networkMs = 0;
  for (;;) {
    const snapshot = JSON.parse(request.config); validateRecovery(snapshot);
    if (hash(request.config) !== request.config_hash) throw new AppFailure('router_recovery_changed');
    if (signal.aborted) {
      await io.finish(request.id, null, {}, 'request_cancelled', true, true);
      return { request, scores: null, failure: 'request_cancelled' };
    }
    await io.dispatch(request.id);
    const timeout = Math.max(1, Math.min(snapshot.timeout_seconds * 1000, routerRecoveryPolicy.totalMs - networkMs));
    let content: string | null = null, metadata: Json = {}, failure: string | null = null, scores: Record<string, number> | null = null;
    const start = performance.now();
    try {
      if (signal.aborted) throw new AppFailure('request_cancelled');
      const result = await gateway.complete({ ...body, ...snapshot.parameters }, snapshot.response_identity, signal, timeout);
      content = result.content; metadata = result.metadata;
      if (signal.aborted) throw new AppFailure('request_cancelled');
      scores = routerScores(content, saved);
    } catch (error) {
      failure = failureCode(error);
      if (error instanceof CompletionFailure) { metadata = error.metadata; content = error.content; }
    }
    const elapsed = Math.max(0, performance.now() - start); networkMs += elapsed;
    metadata = { ...metadata, routing_network_ms: elapsed, routing_chain_network_ms: networkMs };
    const stopped = signal.aborted || ['request_cancelled', 'budget_exceeded', 'monthly_budget_exceeded', 'save_required', 'api_key_missing', 'usage_budget_reached', 'usage_unavailable'].includes(failure ?? '');
    const terminal = !failure || stopped || snapshot.recovery_attempt === 1 || networkMs >= routerRecoveryPolicy.totalMs;
    await io.finish(request.id, content, metadata, failure, terminal, stopped);
    if (stopped && !signal.aborted) throw new AppFailure(failure!);
    if (signal.aborted && !terminal) await io.finish(request.id, content, metadata, 'request_cancelled', true, true);
    if (terminal || signal.aborted) return { request, scores, failure };
    request = await io.secondary(request.id);
  }
}
