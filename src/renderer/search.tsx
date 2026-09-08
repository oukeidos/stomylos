import type { Json, SessionView } from '../shared/types';
import type { SearchSource } from '../shared/search';
import { markdownWebUrl } from '../shared/markdown-link';

const dollars = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `$${value.toFixed(6)}` : 'Unknown';
export function SearchSources({ metadata }: { metadata: Json }) {
  const search = metadata.search;
  const sources = (search?.sources ?? []).filter((s: SearchSource) => typeof s.url === 'string' && markdownWebUrl(s.url));
  if (!sources.length && !(search?.web_search_requests > 0)) return null;
  return <div className="search-sources">
    {search.web_search_requests > 0 && <span className="note">Web searched</span>}
    {!!sources.length && <details><summary>Sources · {sources.length}</summary><ul>{sources.map((s: SearchSource) => <li key={s.url}>
      <a href={markdownWebUrl(s.url)} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a>
    </li>)}</ul></details>}
  </div>;
}
export function SearchCost({ metadata }: { metadata: Json }) {
  if (!metadata.search) return null;
  const usage = metadata.usage ?? {}, costs = usage.cost_details ?? {};
  const residual = typeof usage.cost === 'number' && typeof costs.upstream_inference_cost === 'number'
    ? usage.cost - costs.upstream_inference_cost : undefined;
  return <>
    <small>Search executions: {metadata.search.web_search_requests ?? 'Unknown'}</small>
    <small>Conversation inference: {dollars(costs.upstream_inference_cost)} · input {dollars(costs.upstream_inference_prompt_cost)} · output {dollars(costs.upstream_inference_completions_cost)}</small>
    <small>Search / other charge residual: {dollars(residual)} (total minus reported inference; not an itemized search bill)</small>
    <small>Total reported: {dollars(usage.cost)}</small>
    {metadata.search.endpoints?.map((e: Json, i: number) => <small key={i}>Endpoint reported: {e.provider} · {e.model}</small>)}
  </>;
}
export function SearchAttempts({ view }: { view: SessionView }) {
  return <>{view.searches?.map(({ turn, attempts }) => <div key={turn.user_message_id}>
    <p className="note">Search: {turn.mode === 'off' ? 'Off' : !turn.decision ? 'Awaiting routing' : turn.decision === 'router_unavailable' ? 'Router unavailable; bounded search permitted' : turn.permitted ? 'Permitted by routing' : 'Not needed'}</p>
    {attempts.map(a => { const metadata = JSON.parse(a.metadata), body = JSON.parse(a.config); return <div className="request" key={a.id}>
      <strong>Search routing · {a.ordinal === 0 ? 'Primary' : 'Fallback'}</strong><span className="tag neutral">{a.status}</span>
      <small>{body.model}{metadata.provider ? ` · ${metadata.provider}` : ''}</small>
      <small>Router charge: {dollars(metadata.usage?.cost)}</small>
      {metadata.routing_network_ms != null && <small>{Math.round(metadata.routing_network_ms)} ms through completed gate</small>}
      {metadata.first_valid_seconds != null && <small>{Math.round(metadata.first_valid_seconds * 1000)} ms to first valid JSON</small>}
      {metadata.usage && <small>{metadata.usage.prompt_tokens ?? '?'} input · {metadata.usage.completion_tokens ?? '?'} output tokens</small>}
      {a.failure && <small>{a.failure.replaceAll('_', ' ')}</small>}
      {a.status === 'interrupted' && a.dispatched_at && <small>The provider outcome and any unreported charge are unknown.</small>}
    </div>; })}
  </div>)}</>;
}
