import type { Json } from '../shared/types';
import type { SearchSource } from '../shared/search';
import { markdownWebUrl } from '../shared/markdown-link';

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function searchMetadata(raw: Json, previous: Json = {}): Json {
  const result: Json = { ...previous };
  const sources: SearchSource[] = [...(previous.sources ?? [])];
  const annotations = raw.choices?.[0]?.delta?.annotations;
  if (Array.isArray(annotations)) for (const annotation of annotations) {
    const source = annotation?.type === 'url_citation' ? annotation.url_citation : null;
    if (!source || typeof source.url !== 'string' || source.url.length > 2048) { result.sources_omitted = true; continue; }
    const url = markdownWebUrl(source.url);
    if (!url) { result.sources_omitted = true; continue; }
    if (sources.some(s => s.url === url)) continue;
    sources.push({ url, title: typeof source.title === 'string' ? source.title.slice(0, 300) : url });
    if (source.title?.length > 300) result.sources_omitted = true;
  }
  if (sources.length) result.sources = sources;
  for (const name of ['server_tool_use_details', 'server_tool_use']) {
    const usage = raw.usage?.[name];
    if (count(usage?.web_search_requests)) result.web_search_requests = usage.web_search_requests;
    for (const key of ['tool_calls_requested', 'tool_calls_executed']) if (count(usage?.[key])) result[key] = usage[key];
  }
  const endpoints = raw.openrouter_metadata?.endpoints?.available;
  if (Array.isArray(endpoints)) {
    const selected = endpoints.filter(e => e?.selected === true && typeof e.provider === 'string' && typeof e.model === 'string')
      .slice(0, 8).map(e => ({ provider: e.provider.slice(0, 256), model: e.model.slice(0, 256) }));
    if (selected.length) result.endpoints = selected;
  }
  return result;
}
