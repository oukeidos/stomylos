// One frozen integration gate. Preparation/mock are offline; live dispatch is explicit and non-replayable.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const directory = process.argv.includes('--run-dir') ? arg('--run-dir') : null;
const prepare = process.argv.includes('--prepare'), mock = process.argv.includes('--mock'), live = process.argv.includes('--authorize-90-calls-usd15');
if (!directory || !isAbsolute(directory) || [prepare, mock, live].filter(Boolean).length !== 1) throw Error('Use exactly --prepare, --mock or --authorize-90-calls-usd15 with --run-dir /absolute/path.');
const digest = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (name, value, exclusive = false) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flush: true, ...(exclusive ? { flag: 'wx' } : {}) });
if (prepare || mock) {
  if (existsSync(directory)) throw Error('Use a new preparation directory; never overwrite a gate.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bundle = await build({ absWorkingDir: root, stdin: { contents: `
    export { characters, conversationSnapshot, conversationBody, conversationSystem, hash, verifyRuntime, routerBody, routerSnapshot, routerScores, eligible } from './src/main/contracts';
    export { emptyMemory, memoryConfig, memoryBody, applyMemory } from './src/main/memory-updater';
    export { recordedTime, timeSources, temporalHash } from './src/main/time-context';
    export { searchSnapshot, searchRouterBody, searchInput, withSearch } from './src/main/search-contract';
    export { routeSearch } from './src/main/search-router';
    export { OpenRouter, ChatStream } from './src/main/transport';
    export { failureCode } from './src/main/errors';
    export { loadKey, keyFilePath } from './src/main/storage';
  `, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(directory, 'production.mjs'), metafile: true,
    plugins: [{ name: 'raw', setup(b) {
      b.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
      b.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
    } }] });
  const fixturePath = join(root, 'tests/fixtures/six-live-cases.json');
  const selectionPath = resolve(root, '../auxiliary/conversation-model-evaluation/selected-six-models.json');
  const paths = Object.keys(bundle.metafile.inputs).filter(path => path !== '<stdin>').map(path => path.startsWith('raw:') ? path.slice(4) : resolve(root, path));
  paths.push(fixturePath, selectionPath, import.meta.filename, join(directory, 'production.mjs'));
  const cases = read(fixturePath); assert.equal(cases.router_cases.length, 23); assert.equal(cases.chat_turns.length, 3); assert.equal(cases.memory_cases.length, 2);
  const selected = read(selectionPath).models; assert.equal(selected.length, 6);
  save('gate.json', { mock, maximumCalls: 90, maximumUsd: 15, maximumSearchExecutions: 12, frozenAt: new Date().toISOString(),
    selected, cases, hashes: Object.fromEntries(paths.map(path => [path, digest(readFileSync(path))])),
    scope: 'Exact candidate v6 assembly, 46 character routes, 18 Off conversation replies, 12 matched Auto/Off replies, at most 12 search-router attempts and 2 unchanged updater calls. No automatic retry, normal user data or product writes. Operational results require separate content review.' }, true);
  if (prepare) { console.log(JSON.stringify({ status: 'prepared', directory, maximumCalls: 90, maximumUsd: 15, paidRequests: 0 })); process.exit(0); }
}
const gate = read(join(directory, 'gate.json'));
assert.equal(gate.mock, mock); assert.equal(gate.maximumCalls, 90); assert.equal(gate.maximumUsd, 15);
for (const [path, expected] of Object.entries(gate.hashes)) assert.equal(digest(readFileSync(path)), expected, `Frozen source changed: ${path}`);
if (existsSync(join(directory, 'dispatches.json'))) throw Error('Dispatch ledger already exists. No automatic continuation or replay is permitted.');
const lib = await import(pathToFileURL(join(directory, 'production.mjs')).href); lib.verifyRuntime();
assert.deepEqual(lib.characters.map(({ model, reasoning }) => ({ model, reasoning })), gate.selected.map(({ model, reasoning }) => ({ model, reasoning })));
const prices = {}, modelIds = [...new Set([...lib.characters.map(c => c.model), lib.routerSnapshot().parameters.model, ...lib.searchSnapshot().models.map(m => m.model), lib.memoryConfig().parameters.model])];
for (const model of modelIds) {
  if (mock) { prices[model] = { prompt: 0, completion: 0, request: 0 }; continue; }
  const response = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw Error(`Endpoint preflight failed: ${model} (${response.status})`);
  const evidence = await response.json(), endpoints = evidence.data?.endpoints;
  assert.ok(endpoints?.length, `No endpoints: ${model}`); prices[model] = { evidence };
  for (const field of ['prompt', 'completion', 'request']) {
    const values = endpoints.map(e => Number(e.pricing?.[field] ?? (field === 'request' ? 0 : NaN)));
    assert.ok(values.every(value => Number.isFinite(value) && value >= 0), `Unknown price: ${model}/${field}`);
    prices[model][field] = Math.max(...values);
  }
}
save('prices.json', prices, true);
const key = mock ? 'public-mock' : lib.loadKey(lib.keyFilePath(process.platform, process.env));
if (!key) throw Error('External API key is missing.');
const remote = new lib.OpenRouter(() => key), ledger = [];
const report = { status: 'running', mock, scope: gate.scope, results: [], contentReview: 'pending' };
let job, mockContent, fatal = false;
const persist = () => { save('dispatches.json', ledger); save('report.json', report); };
async function dispatch(body, execute) {
  const price = prices[body.model], inputBytes = Buffer.byteLength(JSON.stringify(body)) + 2048;
  const reservation = mock ? 0 : 1.25 * (body.tools
    ? 0.25 + 4 * ((inputBytes + 20000) * price.prompt + body.max_tokens * price.completion + price.request) + 0.002
    : inputBytes * price.prompt + body.max_tokens * price.completion + price.request);
  const held = ledger.reduce((sum, attempt) => sum + (attempt.cost ?? attempt.reservation), 0);
  if (fatal || ledger.length >= 90 || held + reservation > 15) { fatal = true; throw Error('Gate budget exhausted before dispatch.'); }
  const attempt = { ordinal: ledger.length + 1, job, request: body, requestHash: digest(JSON.stringify(body)), reservation, cost: null, status: 'dispatched', at: new Date().toISOString() };
  ledger.push(attempt); persist(); const started = performance.now();
  try {
    const result = await execute(); Object.assign(attempt, { status: 'completed', content: result.content, metadata: result.metadata }); return result;
  } catch (error) {
    Object.assign(attempt, { status: 'failed', failure: lib.failureCode(error), content: error.content ?? null, metadata: error.metadata ?? {} });
    if (['http_401', 'http_402', 'http_403', 'api_key_missing'].includes(attempt.failure)) fatal = true;
    throw error;
  } finally {
    const cost = attempt.metadata?.usage?.cost;
    attempt.cost = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
    if (!mock && attempt.cost !== null && attempt.cost > reservation) fatal = true;
    attempt.seconds = (performance.now() - started) / 1000; persist();
  }
}
const gateway = {
  complete: (body, identity, signal, timeout) => dispatch(body, async () => mock
    ? { content: mockContent, metadata: { model: body.model, provider: identity.provider, usage: { cost: 0 } } }
    : remote.complete(body, identity, signal, timeout)),
  stream: (body, signal, chunk, options = {}) => dispatch(body, async () => {
    if (!mock) return remote.stream(body, signal, chunk, options);
    const parser = new lib.ChatStream(body.model, chunk, options);
    parser.feed(`data: ${JSON.stringify({ model: body.model, provider: 'Public mock', choices: [{ delta: { content: options.gate ? '{"search":true}' : 'An invented public response for harness verification.' }, finish_reason: 'stop' }], usage: { cost: 0, ...(body.tools ? { server_tool_use_details: { web_search_requests: 1 } } : {}) } })}\n\ndata: [DONE]\n\n`);
    return parser.feed('', true);
  })
};
async function check(id, work) {
  if (fatal) throw Error('Gate stopped; inspect the retained ledger.');
  job = id; const entry = { id, status: 'running' }; report.results.push(entry); persist();
  try { Object.assign(entry, await work(), { status: 'completed' }); }
  catch (error) { Object.assign(entry, { status: 'failed', failure: lib.failureCode(error), pass: false }); }
  persist(); console.log(JSON.stringify({ id, status: entry.status, pass: entry.pass ?? null, failure: entry.failure ?? null }));
  return entry;
}
const sentTimes = new Map();
const message = (content, sequence, role = 'user', session = job) => {
  const id = `${session}-m${sequence}`;
  if (role === 'user') sentTimes.set(id, lib.recordedTime(new Date().toISOString(), 'UTC', 0));
  return { id, session_id: session, sequence, role, origin: role === 'user' ? 'learner' : 'model', delivery: 'complete', content, request_id: null };
};
function assembled(partner, messages) {
  const snapshot = lib.conversationSnapshot('user'); snapshot.memory_context = lib.emptyMemory(partner.id);
  snapshot.memory_context.traits.push({ id: 'public-preference', text: 'Enjoys visiting quiet museums.' });
  const time = lib.recordedTime(new Date().toISOString(), 'UTC', 0);
  snapshot.time_context = { reply_reference: time, sources: lib.timeSources(messages, id => sentTimes.get(id) ?? null) };
  snapshot.temporal_source_hash = lib.temporalHash(snapshot.time_context.sources);
  snapshot.system_sha256 = lib.hash(lib.conversationSystem(snapshot, messages));
  return { snapshot, body: lib.conversationBody(snapshot, partner.id, null, messages) };
}
// The same production routing function is used with an isolated persistence adapter.
// SQLite/restart behavior is verified separately by the offline/native gates.
async function permitSearch(input) {
  const contract = lib.searchSnapshot(), attempts = [], turn = { config: JSON.stringify(contract), decision: null, permitted: null };
  await lib.routeSearch({ view: async () => ({ turn, attempts }), prepare: async () => {
    if (attempts.length === 2) { turn.decision = 'router_unavailable'; turn.permitted = 1; return null; }
    const config = JSON.stringify(lib.searchRouterBody(contract, input, attempts.length));
    const attempt = { id: String(attempts.length), config, config_hash: digest(config), metadata: '{}', dispatched_at: null };
    attempts.push(attempt); return attempt;
  }, dispatch: async id => { attempts[Number(id)].dispatched_at = new Date().toISOString(); }, finish: async (id, content, metadata, failure) => {
    Object.assign(attempts[Number(id)], { content, metadata: JSON.stringify(metadata), failure });
    if (!failure) { turn.decision = Number(id) ? 'fallback' : 'primary'; turn.permitted = JSON.parse(content).search; }
  } }, gateway, new AbortController().signal);
  return { turn, attempts };
}
persist();
try {
  for (const kind of ['starter', 'user']) for (const test of gate.cases.router_cases) await check(`router-${kind}-${test.id}`, async () => {
    const snapshot = lib.conversationSnapshot(kind), contract = lib.routerSnapshot(snapshot);
    mockContent = JSON.stringify(Object.fromEntries(lib.characters.map(c => [c.id, test.required.includes(c.id) ? 2 : 1])));
    const result = await gateway.complete(lib.routerBody(kind === 'starter' ? gate.cases.starter_question : null, test.text, snapshot), contract.response_identity, new AbortController().signal, contract.timeout_seconds * 1000);
    const scores = lib.routerScores(result.content, snapshot), strong = Object.keys(scores).filter(id => scores[id] === 2);
    return { scores, strong, runtimeEligible: lib.eligible(scores, snapshot), pass: test.required.every(id => strong.includes(id)) && strong.every(id => test.allowed.includes(id)), expected: { required: test.required, allowed: test.allowed }, metadata: result.metadata };
  });
  for (const partner of lib.characters) {
    const messages = [];
    for (const [index, content] of gate.cases.chat_turns.entries()) {
      messages.push(message(content, messages.length, 'user', `chat-${partner.id}`));
      const entry = await check(`chat-${partner.id}-${index + 1}`, async () => {
        const { snapshot, body } = assembled(partner, messages), started = performance.now(); let first = null;
        const result = await gateway.stream(body, new AbortController().signal, text => { if (text && first === null) first = (performance.now() - started) / 1000; });
        messages.push(message(result.content, messages.length, 'assistant', `chat-${partner.id}`));
        return { snapshot, content: result.content, metadata: result.metadata, firstAnswerSeconds: first, words: result.content.trim().split(/\s+/).length, pass: true, contentReview: 'pending' };
      });
      if (!entry.pass) break;
    }
  }
  for (const partner of lib.characters) for (const mode of ['auto', 'off']) await check(`search-${partner.id}-${mode}`, async () => {
    const messages = [message(gate.cases.search_input, 0)], { snapshot, body } = assembled(partner, messages);
    const routing = mode === 'auto' ? await permitSearch(lib.searchInput('', gate.cases.search_input)) : null;
    const final = lib.withSearch(body, mode === 'auto' && !!routing.turn.permitted);
    const result = await gateway.stream(final, new AbortController().signal, () => undefined, final.tools ? { search: true } : {});
    const searches = result.metadata.search?.web_search_requests ?? null;
    return { snapshot, routing, content: result.content, metadata: result.metadata, searches,
      pass: mode === 'auto' ? !!final.tools && searches > 0 : !final.tools && !searches, contentReview: 'pending' };
  });
  for (const test of gate.cases.memory_cases) await check(`memory-${test.id}`, async () => {
    const contract = lib.memoryConfig('stomylos_memory_updater_v2'), current = lib.emptyMemory('model_07');
    if (test.initial_trait) current.traits.push({ id: 'old-preference', text: test.initial_trait });
    const packet = { current_memory: current, limits: contract.limits, session: { id: job, character_id: 'model_07', ended_at: gate.frozenAt, timezone: 'UTC',
      messages: test.messages.map((m, i) => ({ id: `${job}-m${i}`, role: m.role, origin: m.role === 'user' ? 'learner' : 'model', delivery: 'complete', content: m.content, sent_time: m.role === 'user' ? lib.recordedTime(gate.frozenAt, 'UTC', 0) : null })) } };
    mockContent = '{"operations":[]}';
    const result = await gateway.complete(lib.memoryBody(contract, packet), contract.response_identity, new AbortController().signal, contract.timeout_seconds * 1000);
    return { packet, content: result.content, memory: lib.applyMemory(packet, result.content), metadata: result.metadata, pass: true, contentReview: 'pending', reviewCriterion: test.review };
  });
  report.status = report.results.every(result => result.pass) ? 'operational_pass_review_pending' : 'needs_review';
} catch (error) { report.status = 'stopped'; report.failure = lib.failureCode(error); }
finally {
  report.routerComparisons = [];
  for (const kind of ['starter', 'user']) for (const test of gate.cases.router_cases.filter(test => test.variant_of)) {
    const base = report.results.find(result => result.id === `router-${kind}-${test.variant_of}`), variant = report.results.find(result => result.id === `router-${kind}-${test.id}`);
    if (base && variant) report.routerComparisons.push({ kind, base: base.id, variant: variant.id, sameScores: JSON.stringify(base.scores) === JSON.stringify(variant.scores), sameStrong: JSON.stringify(base.strong) === JSON.stringify(variant.strong), bothAccepted: base.pass && variant.pass });
  }
  report.calls = ledger.length; report.reportedUsd = ledger.reduce((sum, attempt) => sum + (attempt.cost ?? 0), 0);
  report.unknownCosts = ledger.filter(attempt => attempt.cost === null).length;
  report.heldUnknownUsd = ledger.filter(attempt => attempt.cost === null).reduce((sum, attempt) => sum + attempt.reservation, 0);
  report.fatal = fatal; persist();
}
if (mock) { assert.equal(ledger.length, 84); assert.equal(report.results.length, 78); assert.equal(report.status, 'operational_pass_review_pending'); }
console.log(JSON.stringify({ status: report.status, calls: report.calls, reportedUsd: report.reportedUsd, unknownCosts: report.unknownCosts }));
if (report.status === 'stopped') process.exitCode = 1;
