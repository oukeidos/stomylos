// Follow-up with two fresh lookup cases and raw-response attribution.
// Isolated compatibility probe. Never changes the deployed roster or runtime.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const directory = arg('--run-dir');
const mock = process.argv.includes('--mock');
const prepare = process.argv.includes('--prepare');
if (!process.argv.includes('--run-dir') || !isAbsolute(directory) ||
    (!prepare && !mock && !process.argv.includes('--authorize-19-calls'))) {
  throw Error('Use --prepare, --mock or --authorize-19-calls with --run-dir /absolute/path. Live ceiling: 19 requests / USD5.');
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
  const lookupCases = [
    { id: 'latest', seed_user: 'I will use Python for a small personal project.',
      previous_assistant: 'Python has stable maintenance releases as well as prereleases.',
      current_user: 'What is the latest stable release in the Python 3.14 series today, and when was it released? Please check the official Python site, keep it brief, and give the source.',
      expected: ['3.14.7', 'August 5, 2026'], references: ['https://www.python.org/downloads/'] },
    { id: 'specific', seed_user: 'I am interested in how much work goes into a Python maintenance release.',
      previous_assistant: 'The official release page can describe the work included in an individual release.',
      current_user: 'Please check https://www.python.org/downloads/release/python-3147/ . Approximately how many bugfixes, build improvements and documentation changes does that page report, and how many contributors? Keep it brief and give the source.',
      expected: ['499', '86'], references: ['https://www.python.org/downloads/release/python-3147/'] }
  ];
  save('gate.json', { mock, maximumCalls: 19, maximumUsd: 5, frozenAt: new Date().toISOString(),
    selected, fixture, cases: lookupCases, hashes, scope: 'Current product v5 prompt/memory/time and exact search implementation; only chat model/reasoning substituted. No UI/SQLite or future replacement-prompt acceptance.' }, true);
  if (prepare) { console.log('Prepared six Auto replies and one Aion Off duplication probe; no network access or credentials used.'); process.exit(0); }
}
const gate = JSON.parse(readFileSync(join(directory, 'gate.json')));
assert.equal(gate.mock, mock);
assert.equal(gate.maximumCalls, 19); assert.equal(gate.maximumUsd, 5);
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
// Observe response bytes in transit without a second request or header capture.
// Each chunk reaches the unchanged production transport with identical bytes.
let activeWire = null;
const networkFetch = globalThis.fetch;
if (!mock) globalThis.fetch = async (...args) => {
  const response = await networkFetch(...args);
  const capture = activeWire;
  if (!capture || String(args[0]) !== 'https://openrouter.ai/api/v1/chat/completions') return response;
  save(capture.httpFile, { status: response.status, contentType: response.headers.get('content-type') });
  if (!response.body) return response;
  let recorded = 0;
  const stream = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
    recorded += chunk.byteLength;
    if (recorded <= 8000000) appendFileSync(join(directory, capture.file), chunk);
    else capture.truncated = true;
    controller.enqueue(chunk);
  } }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
};
function auditWire(file, content) {
  const bytes = readFileSync(join(directory, file));
  const packets = []; let lines = [], parseErrors = 0;
  const flush = () => {
    if (!lines.length) return;
    const data = lines.join('\n'); lines = [];
    if (data === '[DONE]') return;
    try { packets.push(JSON.parse(data)); } catch { parseErrors++; }
  };
  for (const line of bytes.toString('utf8').split(/\r\n|\r|\n/)) {
    if (!line) flush();
    else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
  }
  flush();
  const deltas = packets.map((packet, index) => ({ index, text: packet.choices?.[0]?.delta?.content }))
    .filter(x => typeof x.text === 'string');
  const joined = deltas.map(x => x.text).join('');
  const paragraphs = joined.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
  return { bytes: bytes.length, sha256: digest(bytes), packetCount: packets.length, parseErrors,
    deltaTextEqualsStored: joined === (content ?? ''),
    wireToolMarkup: /uncensored_tool_call|<tool_call|<arg_key>/.test(joined),
    markerPacketIndices: deltas.filter(x => /uncensored_tool_call|<tool_call|<arg_key>/.test(x.text)).map(x => x.index),
    repeatedParagraphs: paragraphs.filter((x, i) => paragraphs.indexOf(x) !== i),
    upstreamIdentities: [...new Set(packets.map(x => x.model).filter(Boolean))],
    visibleDeltaText: joined };
}
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
    if (overrun || ledger.length >= 19 || held + reservation > 5) throw Error('Probe budget exhausted before dispatch');
    const attempt = { ordinal: ledger.length + 1, job, kind: options.gate ? 'router' : 'chat',
      request: body, requestHash: digest(JSON.stringify(body)), reservation, cost: null,
      status: 'dispatched', at: new Date().toISOString() };
    attempt.wireFile = `wire-${attempt.ordinal}.sse`;
    activeWire = { file: attempt.wireFile, httpFile: `http-${attempt.ordinal}.json`, truncated: false };
    writeFileSync(join(directory, attempt.wireFile), '', { flag: 'wx', mode: 0o600 });
    ledger.push(attempt); persist(); const started = performance.now();
    try {
      let result;
      if (mock) {
        const parser = new lib.ChatStream(body.model, chunk, options);
        const content = options.gate ? '{"search":true}' :
          body.model === 'aion-labs/aion-3.0' ? body.tools ? '<uncensored_tool_call>example</uncensored_tool_call>Answer.' : 'Answer.\n\nAnswer.' : 'A public lookup answer.';
        const raw = { model: body.model, provider: 'Public mock', choices: [{ delta: { content }, finish_reason: 'stop' }],
          usage: { cost: 0, ...(body.tools ? { server_tool_use_details: { web_search_requests: 1 } } : {}) } };
        const wire = `data: ${JSON.stringify(raw)}\n\ndata: [DONE]\n\n`;
        appendFileSync(join(directory, attempt.wireFile), wire);
        parser.feed(wire, false);
        result = parser.feed('', true);
      } else result = await remote.stream(body, signal, chunk, options);
      attempt.status = 'completed'; attempt.content = result.content; attempt.metadata = result.metadata;
      return result;
    } catch (error) {
      attempt.status = 'failed'; attempt.failure = lib.failureCode(error);
      attempt.content = error.content ?? null; attempt.metadata = error.metadata ?? {};
      throw error;
    } finally {
      attempt.wireTruncated = activeWire.truncated;
      activeWire = null;
      attempt.wireAudit = auditWire(attempt.wireFile, attempt.content);
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
  const jobs = gate.selected.flatMap(model => gate.cases.map(c => ({ model, c, mode: 'auto' })));
  // The earlier Off duplication is already observed; include one raw repeat check.
  jobs.push({ model: gate.selected.find(m => m.model === 'aion-labs/aion-3.0'), c: gate.fixture, mode: 'off' });
  for (const { model, c, mode } of jobs) {
    if (overrun) throw Error('Reported spend exceeded reservation; stop batch.');
    job = `${model.name}-${c.id}-${mode}`;
    const entry = { job, case: c, model: model.model, reasoning: model.reasoning, mode, status: 'preparing' };
    report.results.push(entry); persist();
    try {
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
      entry.operationalPass = mode === 'auto' ? !!body.tools && entry.actualSearches > 0 : !body.tools && !entry.actualSearches;
      entry.wireAudit = ledger.at(-1).wireAudit;
      entry.pass = entry.operationalPass && entry.wireAudit.deltaTextEqualsStored &&
        !entry.wireAudit.wireToolMarkup && !entry.wireAudit.repeatedParagraphs.length;
      if (!entry.wireAudit.deltaTextEqualsStored) throw Error('Raw content and production parser output differ');
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
if (mock) {
  assert.equal(report.status, 'needs_review'); assert.equal(ledger.length, 13);
  assert(report.results.every(x => x.operationalPass && x.wireAudit.deltaTextEqualsStored));
  assert.equal(report.results.filter(x => x.wireAudit.wireToolMarkup).length, 2);
  assert.equal(report.results.at(-1).wireAudit.repeatedParagraphs.length, 1);
}
console.log(JSON.stringify({ status: report.status, calls: ledger.length, reportedUsd: report.reportedUsd, unknownCosts: report.unknownCosts }));
