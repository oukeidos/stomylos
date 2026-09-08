// Read metadata for the already recorded failures. This does not create generations.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = resolve('test-results/six-live-20260906');
const read = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const failures = [...read('dispatches.json'), ...read('retry-dispatches.json')].filter(item => item.status === 'failed');
const lib = await import(pathToFileURL(join(directory, 'production.mjs')).href);
const key = lib.loadKey(lib.keyFilePath(process.platform, process.env));
if (!key) throw Error('Missing external API key.');
const output = join(directory, 'failure-generation-metadata.json');
if (existsSync(output)) throw Error('Metadata evidence already exists.');
const records = [];
for (const failure of failures) {
  const id = failure.metadata?.id;
  if (!/^gen-[a-zA-Z0-9-]+$/.test(id)) throw Error('Missing generation identity');
  const url = new URL('https://openrouter.ai/api/v1/generation'); url.searchParams.set('id', id);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const body = await response.json(); records.push({ job: failure.job, id, httpStatus: response.status, body });
  console.log(JSON.stringify({ job: failure.job, id, httpStatus: response.status, data: body.data }));
}
writeFileSync(output, JSON.stringify({ modelRequests: 0, records }, null, 2), { mode: 0o600, flag: 'wx' });
