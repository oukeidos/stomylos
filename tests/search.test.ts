import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { searchBoolean, searchHash, searchInput, searchOverlay, searchRouterBody, searchSnapshot, withSearch } from '../src/main/search-contract';
import { routeSearch, type SearchRoutingStore } from '../src/main/search-router';
import { AppFailure } from '../src/main/errors';
import { ChatStream, type Gateway } from '../src/main/transport';
import { validateCommand } from '../src/main/ipc';
import * as searchContracts from '../src/main/search-contract';

let store: Store, directory: string;
const native = resolve('native/advisory-lock.node');
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'stomylos-search-')); store = new Store(directory, native); });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function submitted(mode: 'auto' | 'off' = 'auto', direct = false) {
  const session = store.createSession();
  if (direct) store.setOpening(session.id, randomUUID(), session.opening_revision, 'user');
  store.searchMode(session.id, mode); const user = store.submit(session.id, 'Please verify the current opening hours.');
  store.commitRoute(session.id, null, 'fixture', null); return { id: session.id, user };
}
function hooks(id: string): SearchRoutingStore {
  return { view: async () => store.searchView(id), prepare: async () => store.searchPrepare(id),
    dispatch: async a => store.searchDispatch(a), finish: async (...args) => store.searchFinish(...args) };
}
function gateway(outputs: (string | Error)[]) {
  const stream = vi.fn(async (_body: any, _signal: AbortSignal, _chunk: (text: string) => void, _options?: any) => { const result = outputs.shift(); if (result instanceof Error) throw result;
    return { content: result ?? '{"search":false}', metadata: { usage: { cost: 0.00001 } } }; });
  return { stream, complete: vi.fn() } as unknown as Gateway & { stream: typeof stream };
}
it('freezes the selected prompt, two model settings and exact search limits', () => {
  const snapshot = searchSnapshot();
  expect(snapshot).toMatchObject({ version: 'stomylos_search_v2', attempt_timeout_ms: 10000, total_timeout_ms: 20000 });
  expect(searchHash(snapshot.prompt)).toBe('459b48c7e5b0b3e8ebb79b87d0e08b3f258ed3e5feedc9a3bed52f124c8287be');
  expect(searchOverlay).toEqual({ tools: [{ type: 'openrouter:web_search', parameters: { engine: 'parallel', mode: 'fast', max_results: 5, max_total_results: 10, max_uses: 2, max_characters: 1500 } }], max_tool_calls: 4, stop_server_tools_when: [{ type: 'step_count_is', step_count: 4 }, { type: 'max_cost', max_cost_in_dollars: 0.25 }, { type: 'max_tokens_used', max_tokens: 32000 }] });
  const body = searchRouterBody(snapshot, searchInput('Last reply', 'Current message'), 0);
  expect(body.model).toBe('openai/gpt-oss-120b'); expect(body.max_tokens).toBe(1024);
  expect(body.provider).toEqual({ sort: 'latency', allow_fallbacks: true, require_parameters: true, data_collection: 'deny' });
  expect(body.messages).toHaveLength(2); expect(body.tools).toBeUndefined();
  expect(searchRouterBody(snapshot, searchInput('', 'Hello'), 1).max_tokens).toBe(128);
  expect(() => searchRouterBody({ ...snapshot, attempt_timeout_ms: 99999 }, searchInput('', 'x'), 0)).toThrow('search_contract_changed');
});
it('strictly validates the single Boolean and rejects output or request injections', () => {
  expect(searchBoolean(' {"search":false}\n')).toBe(false);
  for (const text of ['{"search":"false"}', '{"search":true,"search":false}', '{"search":true,"why":"x"}', '[true]', 'true', '{"search":true} later']) expect(() => searchBoolean(text)).toThrow();
  expect(() => withSearch({ model: 'selected:online' }, false)).toThrow('search_body_conflict');
  expect(() => validateCommand('searchMode', { sessionId: 'one', mode: 'auto', tools: [] })).toThrow('invalid_command');
});
it('defaults initially to Auto, remembers Off for new chats, freezes input and locks unresolved mode', () => {
  const first = store.createSession(); expect(first.search_mode).toBe('auto'); store.searchMode(first.id, 'off');
  store.close(); store = new Store(directory, native); expect(store.session(first.id).search_mode).toBe('off');
  const user = store.submit(first.id, '  Exact input\n');
  expect(JSON.parse(store.searchView(first.id)!.turn.input)).toEqual({ previous_assistant: first.starter_text, current_user: user.content });
  expect(() => store.searchMode(first.id, 'auto')).toThrow('search_mode_locked');
  store.end(first.id); const next = store.createSession(); expect(next.search_mode).toBe('off');
  store.setOpening(next.id, randomUUID(), next.opening_revision, 'user'); store.submit(next.id, 'Hello');
  expect(JSON.parse(store.searchView(next.id)!.turn.input).previous_assistant).toBe('');
});
it.each([true, false])('uses a valid primary %s without fallback and gates the conversation body', async permitted => {
  const { id } = submitted(), net = gateway([JSON.stringify({ search: permitted })]);
  await routeSearch(hooks(id), net, new AbortController().signal);
  expect(net.stream).toHaveBeenCalledTimes(1);
  expect(store.searchView(id)!.turn).toMatchObject({ decision: 'primary', permitted: Number(permitted) });
  const request = store.prepareChat(id, randomUUID()), body = store.chatBody(request.id);
  expect(!!body.tools).toBe(permitted); expect(body.model).toBe(store.session(id).model);
  expect(body.messages[0].content).not.toContain('Decide whether web search');
});
it('skips all gates for Off and preserves a no-tool body through interrupted retry and restart', async () => {
  const { id } = submitted('off'), net = gateway([]);
  await routeSearch(hooks(id), net, new AbortController().signal); expect(net.stream).not.toHaveBeenCalled();
  const request = store.prepareChat(id, randomUUID()), original = store.chatBody(request.id);
  expect(original.tools).toBeUndefined(); store.dispatch(request.id); store.prepareReply(id, request.id);
  store.close(); store = new Store(directory, native);
  const retry = store.prepareChat(id, randomUUID()); expect(store.chatBody(retry.id)).toEqual(original);
  expect(store.searchView(id)!.attempts).toHaveLength(0);
});
it('falls back on invalid primary JSON but never interprets false as failure', async () => {
  const { id } = submitted(), net = gateway(['{"search":"true"}', '{"search":false}']);
  await routeSearch(hooks(id), net, new AbortController().signal);
  expect(net.stream).toHaveBeenCalledTimes(2); expect(store.searchView(id)!.turn).toMatchObject({ decision: 'fallback', permitted: 0 });
  expect(store.searchView(id)!.attempts[0].failure).toBe('search_gate_invalid');
});
it('exhausts two recoverable failures once, preserves recovery permission and reuses the saved gate', async () => {
  const { id } = submitted(), net = gateway([new AppFailure('request_timeout'), new AppFailure('http_503')]);
  await routeSearch(hooks(id), net, new AbortController().signal);
  expect(store.searchView(id)!.turn).toMatchObject({ decision: 'router_unavailable', permitted: 1 });
  const request = store.prepareChat(id, randomUUID()), body = store.chatBody(request.id);
  store.dispatch(request.id); store.failRequest(request.id, 'transport_failed');
  await routeSearch(hooks(id), net, new AbortController().signal);
  expect(net.stream).toHaveBeenCalledTimes(2); expect(store.chatBody(store.prepareChat(id, randomUUID()).id)).toEqual(body);
});
it('does not fall back on shared auth failure or user cancellation', async () => {
  const { id } = submitted(), net = gateway([new AppFailure('http_401')]);
  await expect(routeSearch(hooks(id), net, new AbortController().signal)).rejects.toThrow('http_401');
  expect(net.stream).toHaveBeenCalledTimes(1); expect(store.searchView(id)!.attempts).toHaveLength(1);
  const abort = new AbortController(); abort.abort();
  await expect(routeSearch(hooks(id), net, abort.signal)).rejects.toThrow('request_cancelled'); expect(net.stream).toHaveBeenCalledTimes(1);
});
it('cancels a dispatched primary without launching fallback and budgets only remaining network time', async () => {
  const { id } = submitted(), abort = new AbortController(), net = gateway([]);
  net.stream.mockImplementationOnce(async () => { abort.abort(); throw new AppFailure('request_cancelled'); });
  await expect(routeSearch(hooks(id), net, abort.signal)).rejects.toThrow('request_cancelled');
  expect(net.stream).toHaveBeenCalledTimes(1); expect(store.searchView(id)!.attempts).toHaveLength(1);
  expect(store.searchView(id)!.attempts[0].status).toBe('interrupted');
  const fallback = gateway(['{"search":true}']);
  await routeSearch(hooks(id), fallback, new AbortController().signal);
  expect(fallback.stream.mock.calls[0][3].timeoutMs).toBe(10000);
  expect(store.searchView(id)!.turn.decision).toBe('fallback');
});
it.each([false, true])('preserves saved deadlines across restart and retry (legacy: %s), then uses new deadlines on Send', async legacy => {
  const snapshot = searchSnapshot();
  if (legacy) Object.assign(snapshot, { version: 'stomylos_search_v1', attempt_timeout_ms: 2000, total_timeout_ms: 4000 });
  const freeze = vi.spyOn(searchContracts, 'searchSnapshot').mockReturnValueOnce(snapshot);
  let id: string;
  try { id = submitted().id; } finally { freeze.mockRestore(); }
  const saved = store.searchView(id)!.turn.config;
  store.close(); store = new Store(directory, native);
  expect(store.view(id).search!.turn.config).toBe(saved);
  const primary = store.searchPrepare(id)!; store.searchDispatch(primary.id);
  // Simulate a slow attempt without waiting: fallback gets the remaining total budget.
  const spent = legacy ? 3000 : 12000;
  store.searchFinish(primary.id, '', { routing_network_ms: spent }, 'request_timeout');
  const net = gateway(['{"search":false}']); await routeSearch(hooks(id), net, new AbortController().signal);
  expect(net.stream.mock.calls[0][3].timeoutMs).toBe(snapshot.total_timeout_ms - spent);
  const request = store.prepareChat(id, randomUUID()), body = store.chatBody(request.id);
  store.dispatch(request.id); store.failRequest(request.id, 'transport_failed');
  const retry = store.prepareChat(id, randomUUID()); expect(store.chatBody(retry.id)).toEqual(body);
  store.dispatch(retry.id); const bubble = store.prepareReply(id, retry.id);
  store.finishReply(retry.id, bubble.id, 'Complete reply.', {});
  store.submit(id, 'Continue this conversation.');
  const next = JSON.parse(store.searchView(id)!.turn.config);
  expect(next).toMatchObject({ version: 'stomylos_search_v2', attempt_timeout_ms: 10000, total_timeout_ms: 20000 });
  const nextNet = gateway(['{"search":false}']); await routeSearch(hooks(id), nextNet, new AbortController().signal);
  expect(nextNet.stream.mock.calls[0][3].timeoutMs).toBe(10000);
});
it('resumes only an unused fallback after a dispatched gate is interrupted by restart', async () => {
  const { id } = submitted(), attempt = store.searchPrepare(id)!; store.searchDispatch(attempt.id);
  store.close(); store = new Store(directory, native);
  const net = gateway(['{"search":true}']); await routeSearch(hooks(id), net, new AbortController().signal);
  expect(net.stream).toHaveBeenCalledTimes(1); expect(net.stream.mock.calls[0][0].model).toBe('ibm-granite/granite-4.2-8b');
  expect(store.searchView(id)!.attempts[0].failure).toBe('interrupted_unknown_outcome');
});
it('rejects missing durable decisions and context tampering, and deletes dependent search data', async () => {
  const { id } = submitted(); expect(() => store.prepareChat(id, randomUUID())).toThrow('search_decision_pending');
  await routeSearch(hooks(id), gateway(['{"search":true}']), new AbortController().signal);
  const request = store.prepareChat(id, randomUUID()); const raw = new Database(join(directory, 'stomylos.sqlite3'));
  expect(() => raw.prepare("UPDATE search_turns SET permitted=0 WHERE session_id=?").run(id)).toThrow('immutable');
  expect(() => raw.prepare("UPDATE chat_search_context SET config='{}' WHERE request_id=?").run(request.id)).toThrow('immutable');
  raw.close(); store.end(id); store.deleteSession(id); expect(store.integrity().foreignKeys).toEqual([]);
});
it('retains sources and terminal search usage without inventing live tool calls or accumulating duplicate cost', () => {
  const stream = new ChatStream('xiaomi/mimo-v2.5-pro', () => undefined, { search: true });
  const event = (delta: object, finish: string | null = null, extra = {}) => `data: ${JSON.stringify({ id: 'one', model: 'xiaomi/mimo-v2.5-pro', provider: 'OpenAI', choices: [{ delta, finish_reason: finish }], ...extra })}\n\n`;
  stream.feed(event({ content: 'A short answer.' }));
  stream.feed(event({ annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.org/source', title: 'Public source', start_index: 0, end_index: 0, content: 'Do not retain this fetched page' } }, { type: 'url_citation', url_citation: { url: 'javascript:alert(1)' } }] }));
  const extraSources = Array.from({ length: 12 }, (_, i) => ({ url: `https://example.org/source/${i}`, title: `Source ${i}` }));
  const annotations = extraSources.map(url_citation => ({ type: 'url_citation', url_citation }));
  stream.feed(event({ annotations: annotations.slice(0, 6) }));
  stream.feed(event({ annotations }));
  const end = event({}, 'stop', { usage: { cost: 0.003, server_tool_use_details: { web_search_requests: 2 } }, openrouter_metadata: { endpoints: { available: [{ selected: true, provider: 'Xiaomi', model: 'xiaomi/mimo-v2.5-pro-20260422' }] } } });
  stream.feed(end + end + 'data: [DONE]\n\n'); const result = stream.feed('', true)!;
  expect(result.metadata.usage.cost).toBe(0.003); expect(result.metadata.search.web_search_requests).toBe(2);
  expect(result.metadata.search.sources).toEqual([{ url: 'https://example.org/source', title: 'Public source' }, ...extraSources]);
  expect(JSON.stringify(result.metadata)).not.toContain('fetched page'); expect(result.metadata.search.endpoints[0].provider).toBe('Xiaomi');
});

it.each(['auto','off'] as const)('supports Expand streaming, privacy and exact retry with search %s',async mode=>{
  const session=store.createSession();store.selectManual(session.id,'model_09');store.searchMode(session.id,mode);
  store.submit(session.id,'Please verify the current opening hours.');store.commitRoute(session.id,null,'manual_override',null);
  const net=gateway(['{"search":true}']);await routeSearch(hooks(session.id),net,new AbortController().signal);
  const request=store.prepareChat(session.id,randomUUID()),body=store.chatBody(request.id);
  expect(body.model).toBe('deepseek/deepseek-v4.1-flash');expect(body.reasoning).toEqual({enabled:false,exclude:true});
  expect(body.provider.data_collection).toBe('deny');expect(body.provider.allow_fallbacks).toBe(false);
  expect(body.cache_control).toBeUndefined();expect(body.max_tokens).toBe(8192);expect(body.stream).toBe(true);
  expect(!!body.tools).toBe(mode==='auto');
  store.dispatch(request.id);store.prepareReply(session.id,request.id);store.failRequest(request.id,'request_timeout','Partial',{});
  const retry=store.prepareChat(session.id,randomUUID(),'retry');expect(store.chatBody(retry.id)).toEqual(body);expect(retry.config).toBe(request.config);
});
