import type { UsageRecorder } from './usage-store';
import { ASR } from '../shared/asr';
import { AppFailure } from './errors';

/** Parse the file, rather than trusting a renderer-supplied duration or MIME. */
export function validateFlac(bytes: Uint8Array) {
  if (bytes.byteLength < 42 || bytes.byteLength > ASR.audioBytes) throw new AppFailure('asr_audio_size');
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.toString('ascii', 0, 4) !== 'fLaC' || (b[4] & 127) !== 0 || b.readUIntBE(5, 3) !== 34) throw new AppFailure('asr_invalid_audio');
  const packed = b.readBigUInt64BE(18);
  const rate = Number(packed >> 44n), channels = Number((packed >> 41n) & 7n) + 1;
  const depth = Number((packed >> 36n) & 31n) + 1, samples = Number(packed & ((1n << 36n) - 1n));
  if (rate !== ASR.rate || channels !== 1 || depth !== 16 || samples < 1 || samples > ASR.rate * ASR.seconds) throw new AppFailure('asr_invalid_audio');
  return { samples, duration: samples / rate };
}
export function asrBody(bytes: Uint8Array) {
  validateFlac(bytes);
  const body = JSON.stringify({ model: ASR.model, input_audio: { format: 'flac', data: Buffer.from(bytes).toString('base64') } });
  if (Buffer.byteLength(body) > ASR.bodyBytes) throw new AppFailure('asr_request_size');
  return body;
}
export interface AsrResult { text: string; generationId?: string; usage?: Record<string, unknown> }
export class AsrFailure extends AppFailure {
  constructor(code: string, readonly generationId?: string, readonly usage?: Record<string, unknown>) { super(code); }
}
export interface AsrGateway { transcribe(bytes: Uint8Array, signal: AbortSignal): Promise<AsrResult> }
export class AsrTransport implements AsrGateway {
  constructor(private key: () => string | null, private endpoint = 'https://openrouter.ai/api/v1/audio/transcriptions', private timeoutMs = 180_000, private idleTimeoutMs = 30_000, private accounting?: UsageRecorder) {}
  async transcribe(bytes: Uint8Array, signal: AbortSignal): Promise<AsrResult> {
    const body = asrBody(bytes); const key = this.key();
    if (!key) throw new AppFailure('api_key_missing');
    if (signal.aborted) throw new AppFailure('asr_cancelled');
    const abort = new AbortController(); let timedOut = false; let timeoutCode = 'asr_timeout';
    const cancel = () => abort.abort(); signal.addEventListener('abort', cancel, { once: true });
    // Includes upload of <=19 MiB and the observed upstream processing window.
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, this.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let responseBody: ReadableStream<Uint8Array> | null = null;
    let generationId: string | undefined; let charge: string | undefined;
    try {
      charge = this.accounting?.begin();
      const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body });
      responseBody = response.body; generationId = response.headers.get('x-generation-id') ?? undefined;
      if (generationId && generationId.length > 1000) generationId = undefined;
      if (!response.ok) throw new AppFailure(`asr_http_${response.status}`);
      if (!response.headers.get('content-type')?.startsWith('application/json') || !response.body) throw new AppFailure('asr_invalid_response');
      if (Number(response.headers.get('content-length')) > ASR.responseBytes) throw new AppFailure('asr_response_size');
      reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      for (;;) {
        let idle: ReturnType<typeof setTimeout> | undefined;
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => {
            idle = setTimeout(() => { timedOut = true; timeoutCode = 'asr_response_timeout'; abort.abort(); reject(new AppFailure(timeoutCode)); }, this.idleTimeoutMs);
          })]);
        } finally { clearTimeout(idle); }
        if (next.done) break;
        size += next.value.length; if (size > ASR.responseBytes) throw new AppFailure('asr_response_size');
        chunks.push(next.value);
      }
      if (signal.aborted) throw new AppFailure('asr_cancelled');
      let value: any;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new AppFailure('asr_invalid_response'); }
      this.accounting?.report(charge, value?.usage?.cost);
      if (!value || typeof value.text !== 'string' || Buffer.byteLength(value.text) > ASR.textBytes) throw new AppFailure('asr_invalid_response');
      const usage = value.usage && typeof value.usage === 'object' && !Array.isArray(value.usage) ? value.usage : undefined;
      return { text: value.text, generationId, usage };
    } catch (error) {
      const code = abort.signal.aborted ? timedOut ? timeoutCode : 'asr_cancelled' : error instanceof AppFailure ? error.code : 'asr_transport_failed';
      throw new AsrFailure(code, generationId);
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (reader) await reader.cancel().catch(() => undefined);
      else await responseBody?.cancel().catch(() => undefined);
    }
  }
}
