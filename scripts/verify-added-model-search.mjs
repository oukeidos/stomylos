// Isolated compatibility probe. Never changes the deployed roster or runtime.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const directory = arg('--run-dir');
const mock = process.argv.includes('--mock');
const prepare = process.argv.includes('--prepare');
if (!process.argv.includes('--run-dir') || !isAbsolute(directory) ||
    (!prepare && !mock && !process.argv.includes('--authorize-12-calls'))) {
  throw Error('Use --prepare, --mock or --authorize-12-calls with --run-dir /absolute/path. Live ceiling: 12 requests / USD5.');
}
const digest = value => createHash('sha256').update(value).digest('hex');
const save = (name, value, exclusive = false) => writeFileSync(join(directory, name),
  JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flush: true, ...(exclusive ? { flag: 'wx' } : {}) });
const manifestPath = resolve(root, '../auxiliary/conversation-model-evaluation/selected-seven-models.json');
if (prepare || mock) {
  if (existsSync(directory)) throw Error('Preparation requires an unused directory.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bundled = await build({ absWorkingDir: root, stdin: { contents: `
    export { conversationBody, conversationSnapshot, conversationSystem, hash, verifyRuntime } from './src/main/contracts';
    export { emptyMemory } from './src/main/memory-updater';
    export { recordedTime, timeSources, temporalHash } from './src/main/time-context';
    export { searchSnapshot, searchRouterBody, searchInput, withSearch } from './src/main/search-contract';
    export { routeSearch } from './src/main/search-router';
    export { OpenRouter, ChatStream } from './src/main/transport';
    export { failureCode } from './src/main/errors';
    export { loadKey, keyFilePath } from './src/main/storage';
  `, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm',
  outfile: join(directory, 'production.mjs'), metafile: true,
  plugins: [{ name: 'raw-text', setup(b) {
    b.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
  } }] });
  const paths = Object.keys(bundled.metafile.inputs).filter(p => p !== '<stdin>').map(p => p.startsWith('raw:') ? p.slice(4) : resolve(root, p));
  paths.push(manifestPath, resolve(import.meta.filename), join(directory, 'production.mjs'), join(root, 'tests/fixtures/search-live-cases.json'));
  const hashes = Object.fromEntries(paths.map(p => [p, digest(readFileSync(p))]));
  const selected = JSON.parse(readFileSync(manifestPath)).models.slice(4);
  assert.deepEqual(selected.map(m => m.model), ['google/gemini-3.8-flash', 'aion-labs/aion-3.0', 'bytedance-seed/seed-2-1-turbo']);
  const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/search-live-cases.json'))).cases.find(c => c.id === 'expo');
  save('gate.json', { mock, maximumCalls: 12, maximumUsd: 5, frozenAt: new Date().toISOString(),
    selected, fixture, hashes, scope: 'Current product v5 prompt/memory/time and exact search implementation; only chat model/reasoning substituted. No UI/SQLite or future replacement-prompt acceptance.' }, true);
  if (prepare) { console.log('Prepared six chat probes; no network access or credentials used.'); process.exit(0); }
}
const gate = JSON.parse(readFileSync(join(directory, 'gate.json')));
assert.equal(gate.mock, mock);
assert.equal(gate.maximumCalls, 12); assert.equal(gate.maximumUsd, 5);
for (const [path, hash] of Object.entries(gate.hashes)) assert.equal(digest(readFileSync(path)), hash, path);
if (existsSync(join(directory, 'dispatches.json'))) throw Error('A ledger already exists; no replay or automatic continuation is allowed.');
const lib = await import(pathToFileURL(join(directory, 'production.mjs')).href);
lib.verifyRuntime();
const prices = {};
const models = [...gate.selected.map(m => m.model), ...lib.searchSnapshot().models.map(m => m.model)];
for (const model of models) {
  if (mock) { prices[model] = { prompt: 0, completion: 0, request: 0 }; continue; }
  const response = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw Error('Endpoint preflight failed: ' + model);
  const evidence = await response.json(), endpoints = evidence.data?.endpoints;
  if (!endpoints?.length) throw Error('No endpoints: ' + model);
  prices[model] = { evidence };
  for (const field of ['prompt', 'completion', 'request']) {
    const values = endpoints.map(e => Number(e.pricing?.[field] ?? (field === 'request' ? 0 : NaN)));
    assert(values.every(v => Number.isFinite(v) && v >= 0));
    prices[model][field] = Math.max(...values);
  }
}
save('prices.json', prices, true);
const key = mock ? 'public-mock' : lib.loadKey(lib.keyFilePath(process.platform, process.env));
if (!key) throw Error('Missing external API key.');
const remote = new lib.OpenRouter(() => key);
const ledger = [], report = { scope: gate.scope, mock, results: [], status: 'running' };
const persist = () => { save('dispatches.json', ledger); save('report.json', report); };
let job = '', overrun = false;
const gateway = { complete: async () => { throw Error('Unexpected complete call'); },
  stream: async (body, signal, chunk, options = {}) => {
    const p = prices[body.model], input = Buffer.byteLength(JSON.stringify(body)) + 2048;
    const reservation = mock ? 0 : 1.25 * (body.tools
      ? 0.25 + 2 * ((input + 20000) * p.prompt + body.max_tokens * p.completion + p.request) + 0.002
      : input * p.prompt + body.max_tokens * p.completion + p.request);
    const held = ledger.reduce((n, a) => n + (a.cost ?? a.reservation), 0);
    if (overrun || ledger.length >= 12 || held + reservation > 5) throw Error('Probe budget exhausted before dispatch');
    const attempt = { ordinal: ledger.length + 1, job, kind: options.gate ? 'router' : 'chat',
      request: body, requestHash: digest(JSON.stringify(body)), reservation, cost: null,
      status: 'dispatched', at: new Date().toISOString() };
    ledger.push(attempt); persist(); const started = performance.now();
    try {
      let result;
      if (mock) {
        const parser = new lib.ChatStream(body.model, chunk, options);
        const content = options.gate ? '{"search":true}' : 'Osaka hosted the Expo at Yumeshima.';
        const raw = { model: body.model, provider: 'Public mock', choices: [{ delta: { content }, finish_reason: 'stop' }],
          usage: { cost: 0, ...(body.tools ? { server_tool_use_details: { web_search_requests: 1 } } : {}) } };
        parser.feed(`data: ${JSON.stringify(raw)}\n\ndata: [DONE]\n\n`, false);
        result = parser.feed('', true);
      } else result = await remote.stream(body, signal, chunk, options);
      attempt.status = 'completed'; attempt.content = result.content; attempt.metadata = result.metadata;
      return result;
    } catch (error) {
      attempt.status = 'failed'; attempt.failure = lib.failureCode(error);
      attempt.content = error.content ?? null; attempt.metadata = error.metadata ?? {};
      throw error;
    } finally {
      const cost = attempt.metadata?.usage?.cost;
      attempt.cost = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
      if (!mock && attempt.cost !== null && attempt.cost > reservation) overrun = true;
      attempt.seconds = (performance.now() - started) / 1000; persist();
    }
  }
};
// In-memory persistence adapter for the unchanged production routing function.
// This probe intentionally does not claim SQLite, restart or native UI acceptance.
async function permitSearch(input) {
  const contract = lib.searchSnapshot(), attempts = [];
  const turn = { config: JSON.stringify(contract), decision: null, permitted: null };
  await lib.routeSearch({ view: async () => ({ turn, attempts }),
    prepare: async () => {
      if (attempts.length === 2) { turn.decision = 'router_unavailable'; turn.permitted = true; return null; }
      const config = JSON.stringify(lib.searchRouterBody(contract, input, attempts.length));
      const a = { id: String(attempts.length), config, config_hash: digest(config), metadata: '{}', dispatched_at: null };
      attempts.push(a); return a;
    }, dispatch: async id => { attempts[Number(id)].dispatched_at = new Date().toISOString(); },
    finish: async (id, content, metadata, failure) => {
      Object.assign(attempts[Number(id)], { content, metadata: JSON.stringify(metadata), failure });
      if (!failure) { turn.decision = Number(id) ? 'fallback' : 'primary'; turn.permitted = JSON.parse(content).search; }
    }
  }, gateway, new AbortController().signal);
  return { turn, attempts };
}
persist();
try {
  for (const model of gate.selected) for (const mode of ['auto', 'off']) {
    if (overrun) throw Error('Reported spend exceeded reservation; stop batch.');
    job = `${model.name}-${mode}`;
    const entry = { job, model: model.model, reasoning: model.reasoning, mode, status: 'preparing' };
    report.results.push(entry); persist();
    try {
      const c = gate.fixture;
      const messages = [c.seed_user, c.previous_assistant, c.current_user].map((content, i) => ({ id: `m${i}`, session_id: 'public-probe',
        role: i === 1 ? 'assistant' : 'user', origin: i === 1 ? 'model' : 'learner', delivery: 'complete', sequence: i, content, request_id: null }));
      const snapshot = lib.conversationSnapshot('user'); snapshot.memory_context = lib.emptyMemory('model_04');
      const time = lib.recordedTime(gate.frozenAt, 'UTC', 0);
      snapshot.time_context = { reply_reference: time, sources: lib.timeSources(messages, () => time) };
      snapshot.temporal_source_hash = lib.temporalHash(snapshot.time_context.sources);
      snapshot.system_sha256 = lib.hash(lib.conversationSystem(snapshot, messages));
      const baseline = lib.conversationBody(snapshot, 'model_04', null, messages);
      const substituted = { ...baseline, model: model.model, reasoning: model.reasoning };
      const started = performance.now();
      entry.routing = mode === 'auto' ? await permitSearch(lib.searchInput(c.previous_assistant, c.current_user)) : null;
      const body = lib.withSearch(substituted, mode === 'auto' && entry.routing.turn.permitted);
      assert.deepEqual(body.messages, baseline.messages); assert.deepEqual(body.provider, baseline.provider);
      if (mode === 'off') assert.equal(body.tools, undefined);
      entry.body = body; let first = null;
      const result = await gateway.stream(body, new AbortController().signal, text => {
        if (text && first === null) first = (performance.now() - started) / 1000;
      }, body.tools ? { search: true } : {});
      Object.assign(entry, { status: 'completed', content: result.content, metadata: result.metadata,
        firstAnswerSeconds: first, totalSeconds: (performance.now() - started) / 1000,
        actualSearches: result.metadata.search?.web_search_requests ?? null });
      entry.pass = mode === 'auto' ? !!body.tools && entry.actualSearches > 0 : !body.tools && !entry.actualSearches;
    } catch (error) { entry.status = 'failed'; entry.failure = lib.failureCode(error); entry.pass = false; }
    persist(); console.log(JSON.stringify({ job, status: entry.status, pass: entry.pass, searches: entry.actualSearches ?? null, failure: entry.failure ?? null }));
  }
  report.status = report.results.every(r => r.pass) ? 'operational_pass' : 'needs_review';
} finally {
  report.reportedUsd = ledger.reduce((n, a) => n + (a.cost ?? 0), 0);
  report.unknownCosts = ledger.filter(a => a.cost === null).length;
  report.heldUnknownUsd = ledger.filter(a => a.cost === null).reduce((n, a) => n + a.reservation, 0);
  report.overrun = overrun; persist();
}
if (mock) { assert.equal(report.status, 'operational_pass'); assert.equal(ledger.length, 9); }
console.log(JSON.stringify({ status: report.status, calls: ledger.length, reportedUsd: report.reportedUsd, unknownCosts: report.unknownCosts }));
