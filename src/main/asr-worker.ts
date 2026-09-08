import { parentPort } from 'node:worker_threads';
import { DictationEncoder } from './asr-encoder';
import { failureCode } from './errors';
const port = parentPort!;
let encoder: DictationEncoder | undefined;
let tail = Promise.resolve();
port.on('message', request => {
  tail = tail.then(async () => {
    try {
      let result: unknown;
      if (request.method === 'start') encoder = await DictationEncoder.create();
      else if (!encoder) throw new Error('encoder_missing');
      else if (request.method === 'push') result = encoder.push(request.sequence, request.pcm, true);
      else if (request.method === 'finish') { result = encoder.finish(); encoder = undefined; }
      else if (request.method === 'discard') { encoder.discard(); encoder = undefined; }
      else throw new Error('invalid_method');
      port.postMessage({ id: request.id, result });
    } catch (error) { port.postMessage({ id: request.id, error: failureCode(error) }); }
  });
});
