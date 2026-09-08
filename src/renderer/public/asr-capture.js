/* Runs at the AudioContext's verified 16-kHz rate; the browser resamples input. */
class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(8000);
    this.used = 0; this.samples = 0; this.sequence = 0; this.pending = 0; this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'ack') this.pending = Math.max(0, this.pending - 1);
      else if (data === 'cancel') { this.stopped = true; this.used = 0; }
      else if (data === 'stop') this.finish('manual');
    };
  }
  flush() {
    if (!this.used) return;
    const pcm = this.buffer.slice(0, this.used);
    this.port.postMessage({ type: 'chunk', sequence: this.sequence++, pcm }, [pcm.buffer]);
    this.used = 0; this.pending++;
  }
  finish(reason) {
    if (this.stopped) return;
    this.stopped = true; this.flush();
    this.port.postMessage({ type: 'stopped', reason, samples: this.samples });
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i]));
      this.buffer[this.used++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
      this.samples++;
      if (this.samples === 9600000) { this.finish('time'); return false; }
      if (this.used === this.buffer.length) {
        this.flush();
        // Bound outstanding PCM to three half-second chunks, preserving all of it.
        if (this.pending >= 3) { this.finish('interrupted'); return false; }
      }
    }
    return true;
  }
}
registerProcessor('dictation-capture', DictationCapture);
