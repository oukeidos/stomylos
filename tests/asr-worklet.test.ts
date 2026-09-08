import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ASR, dictationWarning } from '../src/shared/asr';

// Executes the shipped processor's real process/port code with a deterministic
// audio clock. No wall-clock wait, microphone, browser permission or network.
function worklet(ack = true) {
  let Processor: any; const messages: any[] = [];
  class Base {
    port = { onmessage: (_event: any) => {}, postMessage: (data: any) => { messages.push(data); } };
  }
  runInNewContext(readFileSync(new URL('../src/renderer/public/asr-capture.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: Base, registerProcessor: (_name: string, klass: any) => { Processor = klass; }
  });
  const processor = new Processor(); let acknowledged = 0;
  return { messages, processor,
    process(input: Float32Array) {
      const alive = processor.process([[input]]);
      if (ack) while (acknowledged < messages.length) { const m = messages[acknowledged++]; if (m.type === 'chunk') processor.port.onmessage({ data: 'ack' }); }
      return alive;
    }, command(data: string) { processor.port.onmessage({ data }); }
  };
}
describe('production worklet with a deterministic audio clock', () => {
  it('covers all ten minutes and retains the final PCM sample without waiting ten minutes', () => {
    const w = worklet(), block = new Float32Array(128);
    for (let i = 0; i < block.length; i++) block[i] = i % 2 ? -1 : 1;
    const expected = createHash('sha256'), expectedBlock = Buffer.alloc(256);
    for (let i = 0; i < 128; i++) expectedBlock.writeInt16LE(i % 2 ? -32768 : 32767, i * 2);
    const quanta = ASR.rate * ASR.seconds / 128;
    for (let n = 0; n < quanta; n++) { expected.update(expectedBlock); expect(w.process(block)).toBe(n !== quanta - 1); }
    const chunks = w.messages.filter(m => m.type === 'chunk');
    expect(chunks.map(m => m.sequence)).toEqual(Array.from({ length: 1200 }, (_, i) => i));
    const actual = createHash('sha256'); let samples = 0;
    for (const m of chunks) { samples += m.pcm.length; actual.update(Buffer.from(m.pcm.buffer)); }
    expect(samples).toBe(9600000); expect(actual.digest('hex')).toBe(expected.digest('hex'));
    expect(w.messages.at(-1)).toEqual({ type: 'stopped', reason: 'time', samples: 9600000 });
    const count = w.messages.length; expect(w.process(block)).toBe(false); expect(w.messages.length).toBe(count);
  });
  it('flushes a manual partial chunk and cancels buffered samples without emitting them', () => {
    const stopped = worklet(); stopped.process(new Float32Array(123).fill(.5)); stopped.command('stop');
    expect(stopped.messages[0].pcm.length).toBe(123); expect(stopped.messages[0].pcm[122]).toBe(16384);
    expect(stopped.messages.at(-1)).toEqual({ type: 'stopped', reason: 'manual', samples: 123 });
    stopped.command('stop'); expect(stopped.messages.length).toBe(2);
    const cancelled = worklet(); cancelled.process(new Float32Array(123)); cancelled.command('cancel');
    expect(cancelled.process(new Float32Array(128))).toBe(false); expect(cancelled.messages).toEqual([]);
  });
  it('stops at bounded backpressure and keeps all samples already accepted', () => {
    const w = worklet(false); let active = true;
    for (let i = 0; i < 1000 && active; i++) active = w.process(new Float32Array(128));
    expect(active).toBe(false);
    const chunks = w.messages.filter(m => m.type === 'chunk');
    expect(chunks).toHaveLength(3); expect(chunks.reduce((n, c) => n + c.pcm.length, 0)).toBe(24000);
    expect(w.messages.at(-1)).toEqual({ type: 'stopped', reason: 'interrupted', samples: 24000 });
  });
  it('warns at the selected nine-minute and 80-percent boundaries', () => {
    expect(dictationWarning({ samples: 539 * ASR.rate, bytes: 0, stop: null })).toBe(false);
    expect(dictationWarning({ samples: 540 * ASR.rate, bytes: 0, stop: null })).toBe(true);
    expect(dictationWarning({ samples: 1, bytes: Math.ceil(ASR.audioBytes * .8), stop: null })).toBe(true);
    expect(dictationWarning({ samples: 1, bytes: Math.floor(ASR.audioBytes * .8) - 1, stop: null })).toBe(false);
  });
});
