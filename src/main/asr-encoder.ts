import factory from 'libflacjs';
import { Encoder } from 'libflacjs/lib/encoder';
import { addFLACMetaData } from 'libflacjs/lib/utils/flac-utils';
import { ASR, type DictationProgress } from '../shared/asr';
import { AppFailure } from './errors';

const flac = factory('release');
async function ready() {
  if (flac.isReady()) return;
  await new Promise<void>(resolve => flac.on('ready', () => resolve()));
}

/** Worker-owned stream: inputs are bounded, ordered PCM16 chunks, never files. */
export class DictationEncoder {
  private samples = 0;
  private sequence = 0;
  private finished = false;
  private bytes = 0;
  private counted = 0;
  private stop: DictationProgress['stop'] = null;
  private drained = 0;
  private constructor(private encoder: Encoder) {}
  static async create() {
    await ready();
    const encoder = new Encoder(flac, { sampleRate: ASR.rate, channels: 1,
      bitsPerSample: 16, compression: 5, verify: true });
    if (!encoder.initialized) { encoder.destroy(); throw new AppFailure('asr_encoder_failed'); }
    return new DictationEncoder(encoder);
  }
  private countBytes() {
    while (this.counted < this.encoder.rawData.length) this.bytes += this.encoder.rawData[this.counted++].byteLength;
  }
  push(sequence: number, pcm: Int16Array, drain = false): DictationProgress {
    // At most three already captured chunks can arrive after the size notice.
    if (this.finished || this.stop === 'time' || this.stop && (!drain || ++this.drained > 3)) throw new AppFailure('asr_capture_stopped');
    if (sequence !== this.sequence || !(pcm instanceof Int16Array) || !pcm.length || pcm.length > ASR.chunkSamples)
      throw new AppFailure('asr_invalid_chunk');
    // Capture must stop at the sample boundary; never silently crop a chunk.
    if (this.samples + pcm.length > ASR.seconds * ASR.rate) throw new AppFailure('asr_audio_duration');
    if (!this.encoder.encode(Int32Array.from(pcm))) throw new AppFailure('asr_encoder_failed');
    this.sequence++; this.samples += pcm.length; this.countBytes();
    if (this.samples === ASR.seconds * ASR.rate) this.stop = 'time';
    else if (this.bytes >= ASR.audioBytes - ASR.finalizeReserve ||
      4 * Math.ceil((this.bytes + ASR.finalizeReserve) / 3) + 1024 >= ASR.bodyBytes) this.stop = 'size';
    return { samples: this.samples, bytes: this.bytes, stop: this.stop };
  }
  finish(): Uint8Array {
    if (this.finished) throw new AppFailure('asr_capture_stopped');
    this.finished = true;
    try {
      if (!this.samples || !this.encoder.encode() || !this.encoder.metadata) throw new AppFailure('asr_encoder_failed');
      const chunks = this.encoder.rawData;
      addFLACMetaData(chunks, this.encoder.metadata, false);
      // Retain the complete clip even if a later upload eligibility check fails.
      return Buffer.concat(chunks);
    } finally { this.encoder.destroy(); }
  }
  discard() { this.finished = true; this.encoder.destroy(); }
}
