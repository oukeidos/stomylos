// Explicit development vocabulary parity; ordinary builds never read workspace docs.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const runtime = JSON.parse(readFileSync(new URL('../src/renderer/word-cloud-v1.json', import.meta.url), 'utf8'));
const document = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.deepEqual(runtime, { id: document.id, version: document.version, entries: document.entries });
assert.equal(runtime.entries.length, 240);
assert.equal(new Set(runtime.entries.map(x => x.word)).size, 240);
assert.deepEqual(Object.fromEntries(['scene','action','state','time'].map(k => [k, runtime.entries.filter(x => x.category === k).length])), {scene:120,action:60,state:48,time:12});
assert(!/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(JSON.stringify(document)));
assert(!Object.keys(document).some(k => k.endsWith('_ko')));
console.log('Word-cloud vocabulary parity and 240-word distribution passed.');
