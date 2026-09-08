// Explicit, one-request-at-a-time acceptance gate; never imported by npm test.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const option = name => process.argv[process.argv.indexOf(name) + 1];
const mock = process.argv.includes('--mock');
if (!mock && !process.argv.includes('--authorize-asr-call')) throw new Error('Require --authorize-asr-call or --mock. Each invocation sends at most one request.');
const name = option('--fixture'), fixtures = option('--fixtures');
if (!process.argv.includes('--fixture') || !process.argv.includes('--fixtures') || !/^[a-z0-9-]+$/.test(name)) throw new Error('Require --fixture <manifest name> --fixtures <directory>');
const directory = resolve('test-results', mock ? 'asr-live-mock' : 'asr-live');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const lock = join(directory, 'gate.lock'); const fd = openSync(lock, 'wx', 0o600);
const ledgerPath = join(directory, 'ledger.json');
const hash = value => createHash('sha256').update(value).digest('hex');
let ledger, attempt;
const save = () => { const temp = ledgerPath + '.tmp'; writeFileSync(temp, JSON.stringify(ledger, null, 2), { mode: 0o600, flush: true }); renameSync(temp, ledgerPath); };
const words = text => text.toLowerCase().replace(/[’']/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
function score(reference, hypothesis) {
  const a = words(reference), b = words(hypothesis), width = b.length + 1;
  const costs = new Uint16Array((a.length + 1) * width);
  for (let i = 0; i <= a.length; i++) costs[i * width] = i;
  for (let j = 0; j <= b.length; j++) costs[j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) costs[i * width + j] = Math.min(
    costs[(i - 1) * width + j] + 1, costs[i * width + j - 1] + 1,
    costs[(i - 1) * width + j - 1] + Number(a[i - 1] !== b[j - 1]));
  const regions = ['beginning', 'middle', 'ending'].map(name => ({ name, referenceWords: 0, substitutions: 0, deletions: 0, insertions: 0 }));
  for (let i = 0; i < a.length; i++) regions[Math.min(2, Math.floor(i * 3 / a.length))].referenceWords++;
  let i = a.length, j = b.length;
  while (i || j) {
    const region = regions[Math.min(2, Math.floor(Math.max(0, i - 1) * 3 / a.length))];
    if (i && j && costs[i * width + j] === costs[(i - 1) * width + j - 1] + Number(a[i - 1] !== b[j - 1])) {
      region.substitutions += Number(a[--i] !== b[--j]);
    } else if (i && costs[i * width + j] === costs[(i - 1) * width + j] + 1) { region.deletions++; i--; }
    else { region.insertions++; j--; }
  }
  return { referenceWords: a.length, hypothesisWords: b.length, wordErrorRate: costs[a.length * width + b.length] / a.length, regions };
}
try {
  ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { mock, maxCalls: 4, maxUsd: 0.10, attempts: [] };
  assert.equal(ledger.mock, mock); assert.equal(ledger.maxCalls, 4); assert.equal(ledger.maxUsd, 0.10);
  assert.ok(ledger.attempts.length < 4, 'Four-call budget exhausted');
  assert.ok(ledger.attempts.every(a => a.status === 'received'), 'A failed/uncertain attempt requires inspection; no automatic retry');
  assert.ok(!ledger.attempts.some(a => a.name === name), 'This fixture already has an attempt');
  const manifest = JSON.parse(readFileSync(join(fixtures, 'manifest.json'), 'utf8'));
  const fixture = manifest.fixtures.find(f => f.name === name); assert.ok(fixture);
  const audio = readFileSync(join(fixtures, name + '.flac'));
  assert.equal(hash(audio), fixture.flac_sha256);
  const reference = readFileSync(join(fixtures, name + '.txt'), 'utf8');
  assert.ok(reference.trim()); assert.ok(words(reference).length <= 10000);
  const bundle = join(directory, 'transport.mjs');
  await build({ stdin: { contents: "export { AsrTransport, asrBody, validateFlac } from './src/main/asr-transport'; export { loadKey, keyFilePath } from './src/main/storage';", resolveDir: process.cwd(), loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { AsrTransport, asrBody, validateFlac, loadKey, keyFilePath } = await import(pathToFileURL(bundle));
  const { duration } = validateFlac(audio); assert.equal(duration, fixture.duration);
  const body = asrBody(audio);
  let catalog, rate, key;
  if (mock) { rate = 0.10; key = 'offline-test-key'; }
  else {
    key = loadKey(keyFilePath(process.platform, process.env)); assert.ok(key, 'External OpenRouter key missing');
    const response = await fetch('https://openrouter.ai/api/v1/models/microsoft/mai-transcribe-2/endpoints', { signal: AbortSignal.timeout(20000) });
    assert.ok(response.ok); catalog = await response.json();
    const routes = catalog.data.endpoints; assert.ok(routes.length);
    rate = Math.max(...routes.map(route => Number(route.pricing.prompt)));
    assert.ok(Number.isFinite(rate) && rate > 0 && rate <= 0.10, 'Current hourly price exceeds reviewed $0.10 rate');
  }
  const reservation = duration / 3600 * rate * 2;
  const spent = ledger.attempts.reduce((sum, a) => sum + Math.max(a.reservation, a.result?.usage?.cost ?? 0), 0);
  assert.ok(spent + reservation <= ledger.maxUsd, 'Cost reservation would exceed budget');
  attempt = { name, status: 'dispatched', at: new Date().toISOString(), duration, audioBytes: audio.length,
    bodyBytes: Buffer.byteLength(body), audioSha256: hash(audio), referenceSha256: hash(reference), transportSourceSha256: hash(readFileSync('src/main/asr-transport.ts')),
    hourlyRate: rate, reservation, catalog, source: manifest.source, license: manifest.license };
  ledger.attempts.push(attempt); save(); // Durable before any paid POST.
  const started = performance.now();
  if (mock) globalThis.fetch = async (_url, init) => {
    assert.equal(init.body, body); assert.equal(init.method, 'POST');
    return new Response(JSON.stringify({ text: reference, usage: { cost: 0 } }), { headers: { 'content-type': 'application/json', 'x-generation-id': 'mock-asr-gate' } });
  };
  const result = await new AsrTransport(() => key).transcribe(audio, new AbortController().signal);
  attempt.elapsedSeconds = (performance.now() - started) / 1000;
  attempt.result = result; attempt.score = score(reference, result.text); attempt.status = 'received'; save();
  writeFileSync(join(directory, name + '-raw.txt'), result.text, { mode: 0o600 });
  console.log(JSON.stringify({ ledger: ledgerPath, name, mock, status: attempt.status, duration, elapsedSeconds: attempt.elapsedSeconds,
    reservation, usage: result.usage ?? null, score: attempt.score }, null, 2));
} catch (error) {
  if (attempt) { attempt.status = 'failed_or_uncertain'; attempt.error = error.code ?? error.message; save(); }
  throw error;
} finally { closeSync(fd); unlinkSync(lock); }
