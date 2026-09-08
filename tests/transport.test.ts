import { expect, it } from 'vitest';
import { ChatStream } from '../src/main/transport';
const event = (delta: object, reason: string | null = null, extra = {}) => `data: ${JSON.stringify({ model: 'selected', id: 'one', provider: 'Provider', choices: [{ delta, finish_reason: reason }], ...extra })}\r\n\r\n`;
it('decodes fragmented SSE lines, preserves text and discards reasoning', () => {
  const received: string[] = []; const stream = new ChatStream('selected', text => received.push(text));
  const input = event({ content: '안녕\n', reasoning: 'Private chain' }) + event({ content: '  world' }) + event({}, 'stop') +
    'data: {"choices":[],"usage":{"total_tokens":30}}\n\ndata: [DONE]';
  for (const char of input) stream.feed(char);
  expect(stream.feed('', true)).toEqual({ content: '안녕\n  world', metadata: { model: 'selected', id: 'one', provider: 'Provider', usage: { total_tokens: 30 }, finish_reason: 'stop' } });
  expect(received.at(-1)).toBe('안녕\n  world');
});
it('requires both stop and done and rejects late events or identity changes', () => {
  for (const input of [event({ content: 'Text' }) + 'data: [DONE]\n\n', event({ content: 'Text' }, 'stop')]) {
    const stream = new ChatStream('selected', () => undefined); stream.feed(input); expect(() => stream.feed('', true)).toThrow('stream_incomplete');
  }
  const late = new ChatStream('selected', () => undefined);
  expect(() => late.feed(event({ content: 'Text' }, 'stop') + 'data: [DONE]\n\n' + event({ content: 'Late' }))).toThrow('stream_after_done');
  const identity = new ChatStream('selected', () => undefined); identity.feed(event({ content: 'Text' }));
  expect(() => identity.feed(event({}, 'stop', { id: 'different' }))).toThrow('stream_identity_changed');
});
it('rejects duplicate JSON fields and refusal before accepting visible output', () => {
  expect(() => new ChatStream('selected', () => undefined).feed('data: {"model":"selected","model":"other"}\n\n')).toThrow();
  expect(() => new ChatStream('selected', () => undefined).feed(event({ refusal: 'No', content: 'Text' }))).toThrow('response_refusal');
});
