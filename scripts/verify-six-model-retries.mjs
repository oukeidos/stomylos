// Explicitly reviewed retries of two failed MiMo requests; the original gate remains immutable.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = process.argv.includes('--run-dir') ? process.argv[process.argv.indexOf('--run-dir') + 1] : null;
const prepare = process.argv.includes('--prepare'), authorize = process.argv.includes('--authorize-two-retries');
if (!directory || !isAbsolute(directory) || prepare === authorize) throw Error('Use --prepare or --authorize-two-retries with the original --run-dir.');
const read = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value, exclusive = false) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flush: true, ...(exclusive ? { flag: 'wx' } : {}) });
const gate = read('gate.json'), original = read('dispatches.json'), report = read('report.json');
assert.equal(gate.mock, false); assert.equal(report.status, 'needs_review'); assert.equal(original.length, 84);
const selected = original.filter(attempt => ['chat-model_02-3', 'search-model_02-off'].includes(attempt.job));
assert.equal(selected.length, 2);
for (const item of selected) {
  assert.equal(item.status, 'failed'); assert.equal(item.failure, 'provider_api_error');
  assert.equal(item.request.model, 'xiaomi/mimo-v2.5-pro'); assert.equal(item.request.tools, undefined);
  assert.deepEqual(item.request.reasoning, { enabled: false, exclude: true });
  assert.equal(hash(JSON.stringify(item.request)), item.requestHash);
}
const manifest = { sourceLedgerSha256: hash(readFileSync(join(directory, 'dispatches.json'))), runnerSha256: hash(readFileSync(import.meta.filename)),
  maximumRetries: 2, maximumCombinedCalls: 90, maximumCombinedUsd: 15, jobs: selected.map(item => ({ job: item.job, parentOrdinal: item.ordinal, requestHash: item.requestHash, request: item.request, reservation: item.reservation })) };
if (prepare) { save('retry-manifest.json', manifest, true); console.log(JSON.stringify({ status: 'prepared', jobs: manifest.jobs.map(item => item.job), combinedCallsIfCompleted: 86, maximumCombinedUsd: 15, paidRequests: 0 })); process.exit(0); }
assert.deepEqual(read('retry-manifest.json'), manifest);
for (const [path, digest] of Object.entries(gate.hashes)) assert.equal(hash(readFileSync(path)), digest, path);
if (existsSync(join(directory, 'retry-dispatches.json'))) throw Error('Retry ledger exists; no automatic replay.');
const lib = await import(pathToFileURL(join(directory, 'production.mjs')).href);
const key = lib.loadKey(lib.keyFilePath(process.platform, process.env)); if (!key) throw Error('Missing external API key.');
const remote = new lib.OpenRouter(() => key), attempts = [];
const originalHeld = original.reduce((sum, item) => sum + (item.cost ?? item.reservation), 0);
for (const item of manifest.jobs) {
  const held = originalHeld + attempts.reduce((sum, attempt) => sum + (attempt.cost ?? attempt.reservation), 0);
  if (held + item.reservation > 15 || original.length + attempts.length >= 90) throw Error('Combined original/retry budget exceeded before dispatch.');
  const attempt = { job: item.job, requestHash: item.requestHash, parentOrdinal: item.parentOrdinal, reservation: item.reservation, cost: null, at: new Date().toISOString(), status: 'dispatched' };
  attempts.push(attempt); save('retry-dispatches.json', attempts); const started = performance.now();
  try {
    const result = await remote.stream(item.request, new AbortController().signal, () => undefined);
    Object.assign(attempt, { status: 'completed', content: result.content, metadata: result.metadata });
  } catch (error) { Object.assign(attempt, { status: 'failed', failure: lib.failureCode(error), content: error.content ?? null, metadata: error.metadata ?? {} }); }
  const cost = attempt.metadata?.usage?.cost; attempt.cost = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
  attempt.seconds = (performance.now() - started) / 1000; save('retry-dispatches.json', attempts);
  console.log(JSON.stringify({ job: attempt.job, status: attempt.status, failure: attempt.failure ?? null, cost: attempt.cost }));
  if (attempt.cost !== null && attempt.cost > attempt.reservation) throw Error('Reported cost exceeded the reservation; stop remaining retries.');
}
save('retry-report.json', { status: attempts.every(item => item.status === 'completed') ? 'operational_pass_review_pending' : 'needs_review',
  combinedCalls: original.length + attempts.length, reportedUsd: [...original, ...attempts].reduce((sum, item) => sum + (item.cost ?? 0), 0),
  unknownCosts: [...original, ...attempts].filter(item => item.cost === null).length, contentReview: 'pending' }, true);
