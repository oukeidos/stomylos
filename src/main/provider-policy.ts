import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Json } from '../shared/types';
import { AppFailure } from './errors';

export const providerPolicyVersion = 'stomylos_provider_policy_v1';
export type InferenceEndpoint = 'chat' | 'speech' | 'transcription';
export const endpointCapabilities = Object.freeze({
  chat: 'supported', speech: 'unverified', transcription: 'unsupported'
} as const);
export interface ProviderRequest {
  version: typeof providerPolicyVersion;
  endpoint: InferenceEndpoint;
  support: typeof endpointCapabilities[InferenceEndpoint];
  sourceHash: string;
  body: Json;
  identity: Json | null;
  hash: string;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (): never => { throw new AppFailure('provider_policy_invalid'); };
/** Historical generation contracts stay frozen. Only approved capability preferences survive. */
export function providerPreferences(preferences: Json = {}): Json {
  return { ...(preferences.require_parameters === true ? { require_parameters: true } : {}),
    ...(preferences.sort === 'latency' ? { sort: 'latency' } : {}),
    allow_fallbacks: true, data_collection: 'deny' };
}
/** Call at attempt preparation, never as a silent rewrite inside fetch. */
export function prepareProviderRequest(body: Json, identity: Json | null = null, endpoint: InferenceEndpoint = 'chat'): ProviderRequest {
  if (!Object.hasOwn(endpointCapabilities, endpoint)) invalid();
  const effective = structuredClone(body);
  if (endpoint === 'transcription') delete effective.provider;
  else effective.provider = providerPreferences(body.provider);
  const value: Omit<ProviderRequest, 'hash'> = { version: providerPolicyVersion, endpoint, support: endpointCapabilities[endpoint],
    sourceHash: digest({ body, identity }), body: effective,
    identity: identity ? { ...structuredClone(identity), provider: null } : null };
  return { ...value, hash: digest(value) };
}
export function assertProviderBody(body: Json, endpoint: InferenceEndpoint = 'chat') {
  if (!Object.hasOwn(endpointCapabilities, endpoint)) invalid();
  if (endpoint === 'transcription') { if (Object.hasOwn(body, 'provider')) invalid(); return; }
  if (!body.provider || !isDeepStrictEqual(body.provider, providerPreferences(body.provider))) invalid();
}
export function validateProviderRequest(value: ProviderRequest, original?: { body: Json; identity: Json | null }) {
  if (!value || value.version !== providerPolicyVersion || !Object.hasOwn(endpointCapabilities, value.endpoint) ||
      value.support !== endpointCapabilities[value.endpoint]) invalid();
  const { hash, ...rest } = value;
  if (hash !== digest(rest) || value.identity && value.identity.provider !== null) invalid();
  assertProviderBody(value.body, value.endpoint);
  if (original && value.sourceHash !== digest(original)) throw new AppFailure('provider_source_changed');
  return value;
}
export type ProviderOwner = 'model' | 'search' | 'pattern' | 'memory' | 'cleanup' | 'explain';
