import { afterEach, expect, it, vi } from 'vitest';
import { CompletionFailure, OpenRouter } from '../src/main/transport';
import { conversationBody, conversationSnapshot, grammarBody, grammarSnapshot } from '../src/main/contracts';
const identity = { allowed_models: ['selected'], provider: 'OpenAI' };
const envelope = JSON.stringify({ model: 'selected', provider: 'OpenAI', choices: [{ message: { content: '안녕 🌳' }, finish_reason: 'stop' }] });
const signal = () => new AbortController().signal;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function bytesResponse(text: string, step = 1) {
  const bytes = new TextEncoder().encode(text); let index = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (index === bytes.length) controller.close(); else { controller.enqueue(bytes.slice(index, index + step)); index = Math.min(bytes.length, index + step); }
  } }));
}
it('decodes split UTF-8 bytes and sets bounded nonredirecting HTTP options', async () => {
  const fetchMock = vi.fn(async () => bytesResponse(envelope)); vi.stubGlobal('fetch', fetchMock);
  const gateway = new OpenRouter(() => 'dummy-key');
  expect((await gateway.complete({ model: 'selected' }, identity, signal(), 10_000)).content).toBe('안녕 🌳');
  const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions'); expect(options.redirect).toBe('error');
  expect(options.headers).toEqual({ Authorization: 'Bearer dummy-key', 'Content-Type': 'application/json' });
  expect(options.signal).toBeInstanceOf(AbortSignal);
});
it('handles fragmented SSE UTF-8 and rejects a response above the byte cap', async () => {
  vi.stubGlobal('fetch', async () => bytesResponse(`data: ${JSON.stringify({ model: 'selected', choices: [{ delta: { content: '안녕 🌳' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`));
  const gateway = new OpenRouter(() => 'dummy'); const seen: string[] = [];
  expect((await gateway.stream({ model: 'selected' }, signal(), text => seen.push(text))).content).toBe('안녕 🌳');
  expect(seen).toEqual(['안녕 🌳']);
  vi.stubGlobal('fetch', async () => bytesResponse('x'.repeat(2 * 1024 * 1024 + 1), 32768));
  await expect(gateway.complete({}, identity, signal(), 10_000)).rejects.toThrow('response_too_large');
});
it('returns redacted HTTP categories and rejects malformed UTF-8', async () => {
  const gateway = new OpenRouter(() => 'dummy');
  vi.stubGlobal('fetch', async () => new Response('Secret provider body', { status: 401 }));
  await expect(gateway.complete({}, identity, signal(), 10_000)).rejects.toThrow(/^http_401$/);
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array([0xff, 0xfe])));
  await expect(gateway.complete({}, identity, signal(), 10_000)).rejects.toThrow(/^transport_failed$/);
});
it('distinguishes total timeout, idle timeout and explicit cancellation', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const gateway = new OpenRouter(() => 'dummy');
  const total = expect(gateway.complete({}, identity, signal(), 10_000)).rejects.toThrow('request_timeout');
  await vi.advanceTimersByTimeAsync(10_001); await total;
  const idle = expect(gateway.stream({ model: 'selected' }, signal(), () => undefined)).rejects.toThrow('stream_idle_timeout');
  await vi.advanceTimersByTimeAsync(30_001); await idle;
  const abort = new AbortController(); const cancelled = expect(gateway.complete({}, identity, abort.signal, 10_000)).rejects.toThrow('request_cancelled');
  abort.abort(); await cancelled;
});
it('uses the shorter search-gate deadline and adds metadata headers only for search paths', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  })); vi.stubGlobal('fetch', fetchMock);
  const pending = expect(new OpenRouter(() => 'dummy').stream({ model: 'selected' }, signal(), () => undefined,
    { gate: true, timeoutMs: 2000 })).rejects.toThrow('request_timeout');
  await vi.advanceTimersByTimeAsync(2001); await pending;
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1].headers).toHaveProperty('X-OpenRouter-Metadata', 'enabled');
});
it('permits the larger response bound only for search-enabled chat and still enforces eight million bytes', async () => {
  const padding = ':' + 'x'.repeat(2 * 1024 * 1024) + '\n\n';
  const final = 'data: {"model":"selected","choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  vi.stubGlobal('fetch', async () => bytesResponse(padding + final, 65536));
  const gateway = new OpenRouter(() => 'dummy');
  await expect(gateway.stream({ model: 'selected' }, signal(), () => undefined)).rejects.toThrow('response_too_large');
  expect((await gateway.stream({ model: 'selected' }, signal(), () => undefined, { search: true })).content).toBe('Answer');
  vi.stubGlobal('fetch', async () => bytesResponse(':' + 'x'.repeat(8000000), 65536));
  await expect(gateway.stream({ model: 'selected' }, signal(), () => undefined, { search: true })).rejects.toThrow('response_too_large');
});
it('validates frozen inference settings before dispatch without rewriting them', () => {
  const grammar = grammarSnapshot(); grammar.parameters = { ...grammar.parameters, max_tokens: 100 };
  expect(() => grammarBody(grammar, [])).toThrow('unsupported_grammar_settings');
  const conversation = conversationSnapshot(); conversation.max_tokens = 100;
  expect(() => conversationBody(conversation, 'informative_generalist', 'Question?', [])).toThrow('unsupported_conversation_settings');
  const badPrompt = conversationSnapshot(); badPrompt.system_prompt += ' ';
  expect(() => conversationBody(badPrompt, 'informative_generalist', 'Question?', [])).toThrow('unsupported_conversation_prompt');
});
it('preserves only visible response and safe usage when a complete response has the wrong identity', async () => {
  vi.stubGlobal('fetch', async () => bytesResponse(JSON.stringify({ model: 'wrong-model', provider: 'Wrong provider',
    choices: [{ message: { content: 'First question?\nSecond question?', reasoning: 'Never store this reasoning.' }, finish_reason: 'stop' }],
    usage: { cost: 0.01, total_tokens: 42, arbitrary_secret: 'Never store this field.' }, secret: 'Never store this field.' })));
  const failed = await new OpenRouter(() => 'dummy').complete({}, identity, signal(), 1000).catch(error => error);
  expect(failed).toBeInstanceOf(CompletionFailure); expect(failed.code).toBe('response_identity');
  expect(failed.content).toBe('First question?\nSecond question?');
  expect(failed.metadata).toEqual({ model: 'wrong-model', provider: 'Wrong provider', usage: { cost: 0.01, total_tokens: 42 } });
});

it.each(['length', 'content_filter', 'error'])('retains the %s stream finish and trailing usage without reasoning text', async reason => {
  const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
  vi.stubGlobal('fetch', async () => bytesResponse(
    frame({ id: 'public-generation', model: 'selected', provider: 'OpenAI', choices: [{ delta: { content: 'Partial 🌳', reasoning: 'Do not retain me' } }] }) +
    frame({ choices: [{ delta: {}, finish_reason: reason }] }) +
    frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 8192, total_tokens: 8292, cost: .01,
      completion_tokens_details: { reasoning_tokens: 8000, private_field: 'Do not retain me' }, private_field: 'Do not retain me' } }) + 'data: [DONE]\n\n'));
  const failure = await new OpenRouter(() => 'dummy').stream({ model: 'selected' }, signal(), () => undefined).catch(e => e);
  expect(failure).toBeInstanceOf(CompletionFailure);
  expect(failure.code).toBe({ length: 'response_length_limit', content_filter: 'response_filtered', error: 'provider_api_error' }[reason]);
  expect(failure.content).toBe('Partial 🌳');
  expect(failure.metadata).toEqual({ id: 'public-generation', model: 'selected', provider: 'OpenAI', finish_reason: reason,
    elapsed_seconds: expect.any(Number), usage: { prompt_tokens: 100, completion_tokens: 8192, total_tokens: 8292, cost: .01,
      completion_tokens_details: { reasoning_tokens: 8000 } } });
});

it('retains received stream diagnostics on a broken connection without inventing a finish or usage', async () => {
  const text = 'data: {"id":"public-partial","model":"selected","choices":[{"delta":{"content":"Partial"}}]}\n\n';
  let delivered = false;
  vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ pull(controller) {
    if (delivered) controller.error(new Error('Private transport detail'));
    else { delivered = true; controller.enqueue(new TextEncoder().encode(text)); }
  } })));
  const failure = await new OpenRouter(() => 'dummy').stream({ model: 'selected' }, signal(), () => undefined).catch(e => e);
  expect(failure).toBeInstanceOf(CompletionFailure); expect(failure.code).toBe('transport_failed');
  expect(failure.content).toBe('Partial');
  expect(failure.metadata).toEqual({ id: 'public-partial', model: 'selected', elapsed_seconds: expect.any(Number) });
});
