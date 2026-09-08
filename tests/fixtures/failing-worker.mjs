import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', () => process.exit(1));
