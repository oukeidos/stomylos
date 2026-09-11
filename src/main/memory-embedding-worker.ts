import { loadEmbedding } from './memory-embedding';
import { failureCode } from './errors';
const port = (process as NodeJS.Process & { parentPort: {
  on(event: 'message', listener: (event: { data: { id: number; method: string; directory?: string; text?: string } }) => void): void;
  postMessage(value: unknown): void;
} }).parentPort;
let engine: Awaited<ReturnType<typeof loadEmbedding>> | null = null;
let busy = false;
port.on('message', async ({ data }) => {
  if (busy) { port.postMessage({ id: data.id, error: 'cold_worker_busy' }); return; }
  busy = true;
  try {
    if (data.method === 'init' && typeof data.directory === 'string' && !engine) {
      engine = await loadEmbedding(data.directory);
      port.postMessage({ id: data.id, result: true });
    } else if (data.method === 'embed' && typeof data.text === 'string' && engine) {
      port.postMessage({ id: data.id, result: await engine.embed(data.text) });
    } else throw new Error('cold_worker_message');
  } catch (error) { port.postMessage({ id: data.id, error: failureCode(error) }); }
  finally { busy = false; }
});
