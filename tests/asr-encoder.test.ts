import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import factory from 'libflacjs';
import { Decoder } from 'libflacjs/lib/decoder';
import { DictationEncoder } from '../src/main/asr-encoder';
import { validateFlac, asrBody } from '../src/main/asr-transport';
import { ASR } from '../src/shared/asr';

describe('lossless dictation encoding', () => {
  it.each(['silence', 'noise'] as const)('preserves every sample through the %s limit', async kind => {
    const encoder = await DictationEncoder.create();
    const original = createHash('sha256'); let sequence = 0, samples = 0, random = 1;
    let stop: string | null = null;
    while (!stop) {
      const chunk = new Int16Array(ASR.chunkSamples);
      if (kind === 'noise') for (let i = 0; i < chunk.length; i++) {
        random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
        chunk[i] = random;
      }
      original.update(Buffer.from(chunk.buffer)); samples += chunk.length;
      stop = encoder.push(sequence++, chunk).stop;
    }
    expect(stop).toBe(kind === 'silence' ? 'time' : 'size');
    expect(() => encoder.push(sequence, new Int16Array(1))).toThrow();
    if (kind === 'noise') {
      // A worker stop notice can race three chunks already emitted by capture.
      for (let n = 0; n < 3; n++) {
        const chunk = new Int16Array(ASR.chunkSamples);
        for (let i = 0; i < chunk.length; i++) { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; chunk[i] = random; }
        original.update(Buffer.from(chunk.buffer)); samples += chunk.length;
        expect(encoder.push(sequence++, chunk, true).stop).toBe('size');
      }
      expect(() => encoder.push(sequence, new Int16Array(1), true)).toThrow();
    }
    const audio = encoder.finish();
    expect(validateFlac(audio).samples).toBe(samples);
    expect(audio.byteLength).toBeLessThanOrEqual(ASR.audioBytes);
    expect(Buffer.byteLength(asrBody(audio))).toBeLessThanOrEqual(ASR.bodyBytes);
    if (kind === 'silence') expect(samples).toBe(ASR.rate * 600);
    else expect(samples).toBeLessThan(ASR.rate * 600);
    const decoder = new Decoder(factory('release'), { verify: true });
    try {
      expect(decoder.decode(Uint8Array.from(audio))).toBe(true);
      const pcm = decoder.getSamples(true);
      expect(pcm.byteLength).toBe(samples * 2);
      expect(createHash('sha256').update(pcm).digest('hex')).toBe(original.digest('hex'));
    } finally { decoder.destroy(); }
  }, 30_000);

  it('rejects reordered input and releases cancelled encoders without a clip', async () => {
    const encoder = await DictationEncoder.create();
    expect(() => encoder.push(1, new Int16Array(10))).toThrow();
    encoder.push(0, new Int16Array([32767, -32768, 1, -1]));
    encoder.discard();
    expect(() => encoder.finish()).toThrow();
    expect(() => encoder.push(1, new Int16Array(10))).toThrow();
  });
});
