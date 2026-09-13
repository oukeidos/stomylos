import type { Json } from '../shared/types';
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
