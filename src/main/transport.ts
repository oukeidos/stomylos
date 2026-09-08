import type { UsageRecorder } from './usage-store';
import type { Json } from '../shared/types';
import { AppFailure } from './errors';
import { safeMetadata, validateEnvelope } from './contracts';
import { strictJson } from './strict-json';
import type { SearchStreamOptions } from '../shared/search';
import { searchMetadata } from './search-metadata';
import { searchBoolean } from './search-contract';

export class CompletionFailure extends AppFailure {
  constructor(code: string, public readonly content: string | null, public readonly metadata: Json) { super(code); }
}

export interface Completion { content: string; metadata: Json }
export interface Gateway {
  complete(body: Json, identity: Json, signal: AbortSignal, timeoutMs: number): Promise<Completion>;
  stream(body: Json, signal: AbortSignal, chunk: (text: string) => void, options?: SearchStreamOptions): Promise<Completion>;
}
const MAX_BYTES = 2 * 1024 * 1024;
export class OpenRouter implements Gateway {
  constructor(private key: () => string | null, private endpoint = 'https://openrouter.ai/api/v1/chat/completions', private usage?: UsageRecorder) {}
  private async request<T>(body: Json, signal: AbortSignal, timeout: number, streaming: boolean,
    consume: (text: string, final: boolean) => T | undefined, options: SearchStreamOptions = {}, metadata: () => Json = () => ({})): Promise<T> {
    const key = this.key(); if (!key) throw new AppFailure('api_key_missing');
    if (signal.aborted) throw new AppFailure('request_cancelled');
    const payload = JSON.stringify(body);
    const abort = new AbortController(); let reason = 'request_cancelled';
    const stop = (code: string) => { if (!abort.signal.aborted) { reason = code; abort.abort(); } };
    const relay = () => stop('request_cancelled');
    if (signal.aborted) relay(); else signal.addEventListener('abort', relay, { once: true });
    const total = setTimeout(() => stop('request_timeout'), timeout);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => { if (streaming) { clearTimeout(idle); idle = setTimeout(() => stop('stream_idle_timeout'), 30_000); } };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let charge: string | undefined;
    try {
      resetIdle();
      charge = this.usage?.begin();
      const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
          ...(options.search || options.gate ? { 'X-OpenRouter-Metadata': 'enabled' } : {}) }, body: payload });
      if (!response.ok) throw new AppFailure(`http_${response.status}`);
      if (!response.body) throw new AppFailure('response_empty');
      reader = response.body.getReader(); let size = 0;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.byteLength; if (size > (options.search ? 8000000 : MAX_BYTES)) throw new AppFailure('response_too_large');
        resetIdle(); const result = consume(decoder.decode(item.value, { stream: true }), false);
        this.usage?.report(charge, metadata().usage?.cost);
        if (result !== undefined) return result;
      }
      const result = consume(decoder.decode(), true);
      if (result === undefined) throw new AppFailure('response_incomplete');
      return result;
    } catch (error) {
      if (abort.signal.aborted) throw new AppFailure(reason);
      if (error instanceof AppFailure) throw error;
      throw new AppFailure('transport_failed');
    } finally {
      this.usage?.report(charge, metadata().usage?.cost);
      clearTimeout(total); clearTimeout(idle); signal.removeEventListener('abort', relay);
      await reader?.cancel().catch(() => undefined);
    }
  }
  complete(body: Json, identity: Json, signal: AbortSignal, timeoutMs: number): Promise<Completion> {
    let text = ''; let metadata: Json = {};
    return this.request(body, signal, timeoutMs, false, (part, final) => {
      text += part;
      if (final) {
        const raw = strictJson(text); metadata = safeMetadata(raw ?? {});
        try { return validateEnvelope(raw, identity); }
        catch (error) {
          if (!(error instanceof AppFailure)) throw error;
          const visible = raw?.choices?.[0]?.message?.content;
          throw new CompletionFailure(error.code, typeof visible === 'string' ? visible : null, safeMetadata(raw ?? {}));
        }
      }
    }, {}, () => metadata);
  }
  async stream(body: Json, signal: AbortSignal, chunk: (text: string) => void, options: SearchStreamOptions = {}): Promise<Completion> {
    const parser = new ChatStream(body.model, chunk, options);
    const started = performance.now();
    try {
      return await this.request(body, signal, options.timeoutMs ?? 120_000, true, (text, final) => parser.feed(text, final), options, () => parser.failure('accounting').metadata);
    } catch (error) {
      if (!(error instanceof AppFailure)) throw error;
      const failure = parser.failure(error.code);
      failure.metadata.elapsed_seconds = (performance.now() - started) / 1000;
      throw failure;
    }
  }
}

export class ChatStream {
  private buffer = ''; private data: string[] = []; private content = '';
  private stopped = false; private done = false; private identity = false;
  private metadata: Json = {}; private provider: string | undefined;
  private terminalFailure: string | undefined;
  private started = performance.now();
  constructor(private model: string, private chunk: (text: string) => void, private options: SearchStreamOptions = {}) {}
  failure(code: string): CompletionFailure {
    return new CompletionFailure(this.terminalFailure ?? code, this.content, structuredClone(this.metadata));
  }
  feed(text: string, final = false): Completion | undefined {
    this.buffer += text;
    for (;;) {
      const index = this.buffer.search(/[\r\n]/); if (index < 0) break;
      if (!final && this.buffer[index] === '\r' && index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, index);
      const width = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(index + width);
      if (!line) {
        if (this.data.length) { const result = this.event(this.data.join('\n')); this.data = []; if (result) return result; }
      } else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
    }
    if (final) {
      if (this.buffer.startsWith('data:')) this.data.push(this.buffer.slice(5).replace(/^ /, ''));
      this.buffer = '';
      if (this.data.length) { this.event(this.data.join('\n')); this.data = []; }
      if (this.terminalFailure) throw this.failure(this.terminalFailure);
      if (!this.done || !this.stopped || !this.identity || !this.content.trim()) throw new AppFailure('stream_incomplete');
      if (this.options.search || this.options.gate) this.metadata.elapsed_seconds = (performance.now() - this.started) / 1000;
      return { content: this.content, metadata: { ...this.metadata, finish_reason: 'stop' } };
    }
    return undefined;
  }
  private event(data: string): Completion | undefined {
    if (data === '[DONE]') {
      this.done = true; return undefined;
    }
    if (this.done) throw new AppFailure('stream_after_done');
    const raw = strictJson(data);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppFailure('provider_api_error');
    if (raw.model !== undefined) {
      if (raw.model !== this.model) throw new AppFailure('response_identity');
      this.identity = true;
    }
    if (raw.provider !== undefined) {
      if (typeof raw.provider !== 'string' || !raw.provider || (this.provider && raw.provider !== this.provider)) throw new AppFailure('response_identity');
      this.provider = raw.provider;
    }
    const safe = safeMetadata(raw);
    for (const name of ['id', 'model', 'provider']) if (safe[name] !== undefined && this.metadata[name] !== undefined && safe[name] !== this.metadata[name]) throw new AppFailure('stream_identity_changed');
    this.metadata = { ...this.metadata, ...safe,
      ...(safe.usage ? { usage: { ...this.metadata.usage, ...safe.usage } } : {}) };
    if (this.options.search || this.options.gate) {
      if (raw.openrouter_metadata?.requested !== undefined && raw.openrouter_metadata.requested !== this.model) throw new AppFailure('response_identity');
      this.metadata.search = searchMetadata(raw, this.metadata.search);
      this.options.evidence?.(structuredClone(this.metadata));
    }
    if (raw.error != null) {
      if (raw.choices?.[0]?.finish_reason === 'error') this.metadata.finish_reason = 'error';
      throw new AppFailure('provider_api_error');
    }
    if (!Array.isArray(raw.choices) || raw.choices.length > 1) throw new AppFailure('response_choices');
    if (!raw.choices.length) return undefined;
    const choice = raw.choices[0];
    if (!choice || typeof choice !== 'object' || Array.isArray(choice) || (choice.index !== undefined && choice.index !== 0)) throw new AppFailure('response_choices');
    if (choice.finish_reason != null) {
      const reason = choice.finish_reason;
      if (!['stop', 'length', 'content_filter', 'error', 'tool_calls'].includes(reason) ||
        (this.stopped && this.metadata.finish_reason !== reason)) throw new AppFailure('response_incomplete');
      this.metadata.finish_reason = reason;
      const failures: Record<string, string> = { length: 'response_length_limit', content_filter: 'response_filtered',
        error: 'provider_api_error', tool_calls: 'unexpected_tool_call' };
      this.terminalFailure = failures[reason];
    }
    if (choice.error != null) throw new AppFailure('provider_api_error');
    const delta = choice.delta;
    if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw new AppFailure('response_message');
    if (delta.refusal != null && delta.refusal !== '') throw new AppFailure('response_refusal');
    if (delta.tool_calls || delta.function_call) throw new AppFailure('unexpected_tool_call');
    if (this.options.search || this.options.gate) {
      const seconds = (performance.now() - this.started) / 1000;
      if ((delta.content || delta.reasoning || delta.reasoning_details) && this.metadata.first_token_seconds === undefined) this.metadata.first_token_seconds = seconds;
      if (delta.content && this.metadata.first_answer_seconds === undefined) this.metadata.first_answer_seconds = seconds;
      if ((delta.reasoning || delta.reasoning_details) && this.metadata.first_reasoning_seconds === undefined) this.metadata.first_reasoning_seconds = seconds;
    }
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== 'string' || (this.stopped && delta.content.length > 0)) throw new AppFailure('response_message');
      this.content += delta.content; this.chunk(this.content);
      if (this.options.gate && this.metadata.first_valid_seconds === undefined) {
        try { searchBoolean(this.content); this.metadata.first_valid_seconds = (performance.now() - this.started) / 1000; } catch { /* Wait for a complete valid gate. */ }
      }
    }
    if (choice.finish_reason != null) {
      // Drain usage-only events after the terminal choice before reporting a provider cutoff.
      this.stopped = true;
    }
    return undefined;
  }
}
