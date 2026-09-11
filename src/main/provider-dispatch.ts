import type { Json } from '../shared/types';
import type { Gateway, CompletionOptions } from './transport';
import type { ProviderOwner, ProviderRequest } from './provider-policy';
export type PrepareProvider = (owner: ProviderOwner, id: string, body: Json, identity: Json | null) => Promise<ProviderRequest>;
export async function providerComplete(prepare: PrepareProvider, gateway: Gateway, owner: ProviderOwner, id: string,
  body: Json, identity: Json, signal: AbortSignal, timeout: number, options?: CompletionOptions) {
  const routed = await prepare(owner, id, body, identity);
  return gateway.complete(routed.body, routed.identity!, signal, timeout, options);
}
