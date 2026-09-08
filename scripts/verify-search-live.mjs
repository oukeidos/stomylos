// Explicit, bounded acceptance only. Ordinary tests never execute this entry point.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { startMockGateway } from './mock-gateway.mjs';
const mock = process.argv.includes('--mock');
const resume = process.argv.includes('--resume-unattempted');
const index = process.argv.indexOf('--run-dir'), directory = index >= 0 ? process.argv[index + 1] : null;
if (!directory || !isAbsolute(directory) || (!mock && !process.argv.includes('--authorize-44-calls'))) throw new Error('Use --mock or --authorize-44-calls and --run-dir /absolute/unused/path. Maximum 44 inference attempts / USD5.');
if (existsSync(directory) && !resume) throw new Error('Run directory exists; inspect its ledger instead of restarting paid work.');
if (resume && !existsSync(join(directory, 'gate.json'))) throw new Error('Missing original frozen run.');
const original = resume ? JSON.parse(readFileSync(join(directory, 'gate.json'), 'utf8')) : null;
if (original && original.mock !== mock) throw new Error('Run mode cannot change.');
const runtime = JSON.parse(readFileSync('src/main/runtime-config.json', 'utf8'));
const cases = JSON.parse(readFileSync('tests/fixtures/search-live-cases.json', 'utf8'));
const models = [...runtime.conversation.characters.map(c => c.model), 'openai/gpt-oss-120b', 'ibm-granite/granite-4.2-8b'];
const prices = {};
for (const model of models) {
  if (original) { prices[model] = original.prices[model]; continue; }
  if (mock) { prices[model] = { prompt: 0, completion: 0, request: 0 }; continue; }
  const response = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error('Cannot verify current provider prices: ' + model);
  const data = await response.json();
  if (!data.data?.endpoints?.length) throw new Error('No current endpoints: ' + model);
  const maxima = {};
  for (const name of ['prompt', 'completion', 'request']) {
    const values = data.data.endpoints.map(e => Number(e.pricing?.[name] ?? (name === 'request' ? 0 : NaN)));
    if (values.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Unusable price data: ' + model);
    maxima[name] = Math.max(...values);
  }
  prices[model] = { ...maxima, evidence: data };
}
const jobs = [];
// Fixed alternating pair order; all models and all cases are retained.
for (const [i, partner] of runtime.conversation.characters.entries()) for (const c of cases.cases) {
  const modes = c.expected_search ? (i % 2 ? ['off', 'auto'] : ['auto', 'off']) : ['auto'];
  for (const mode of modes) jobs.push({ id: `${partner.id}-${c.id}-${mode}`, partner: partner.id, model: partner.model, mode, case: c });
}
const sources = ['src/main/search-contract.ts', 'src/main/search-router-prompt.txt', 'src/main/search-router.ts',
  'src/main/search-store.ts', 'src/main/transport.ts', 'src/main/contracts.ts', 'src/main/coordinator.ts',
  'src/main/database.ts', 'src/main/runtime-config.json', 'tests/fixtures/search-live-cases.json', 'tests/search-live.check.ts'];
const hashes = Object.fromEntries(sources.map(p => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const gate = original ?? { mock, maximumCalls: 44, maximumUsd: 5, frozenAt: new Date().toISOString(), reference: cases, jobs, prices, hashes };
if (resume) {
  writeFileSync(join(directory, 'report-before-continuation.json'), readFileSync(join(directory, 'report.json')), { flag: 'wx', mode: 0o600, flush: true });
  writeFileSync(join(directory, 'continuation.json'), JSON.stringify({ hashes, originalGateHash: createHash('sha256').update(readFileSync(join(directory, 'gate.json'))).digest('hex'),
    reason: 'The initial conversation was not dispatched because its engineering reservation exceeded the batch budget. Resume only jobs without a conversation HTTP attempt; reuse durable gates and include all prior charges.',
    reservation: 'Search: 1.25 times (USD0.25 loop threshold plus two full generation allowances with 20,000 added input tokens and two search fees). This is an engineering estimate, not a provider billing guarantee.',
    maximumCalls: 44, maximumUsd: 5, at: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600, flush: true });
} else writeFileSync(join(directory, 'gate.json'), JSON.stringify(gate, null, 2), { flag: 'wx', mode: 0o600, flush: true });
const local = mock ? await startMockGateway({ delay: 0, searchHandler: async (body, response) => {
  const pair = JSON.parse(body.messages[1].content);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ model: body.model, provider: 'Public mock', choices: [{ delta: { content: JSON.stringify({ search: !pair.current_user.includes('natural English') }) }, finish_reason: 'stop' }], usage: { cost: 0 } })}\n\ndata: [DONE]\n\n`);
}, chatHandler: async (body, response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ model: body.model, provider: 'Public mock', choices: [{ delta: { content: 'A public synthetic acceptance reply.' }, finish_reason: 'stop' }], usage: { cost: 0, ...(body.tools ? { server_tool_use_details: { web_search_requests: 1 } } : {}) } })}\n\ndata: [DONE]\n\n`);
} }) : null;
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', STOMYLOS_SEARCH_VERIFY_DIR: directory };
if (resume) env.STOMYLOS_SEARCH_RESUME = '1'; else delete env.STOMYLOS_SEARCH_RESUME;
for (const name of ['STOMYLOS_LIVE_DIR', 'STOMYLOS_STARTER_VERIFY_DIR', 'STOMYLOS_CONTINUITY_DIR', 'STOMYLOS_MEMORY_CONTINUITY_DIR', 'STOMYLOS_OPENING_CONVERTER', 'STOMYLOS_SEARCH_MOCK_ENDPOINT']) delete env[name];
if (local) env.STOMYLOS_SEARCH_MOCK_ENDPOINT = local.endpoint;
try {
  const child = spawn(createRequire(import.meta.url)('electron'), ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.checks.config.ts', 'tests/search-live.check.ts'], { stdio: 'inherit', env, cwd: resolve('.') });
  process.exitCode = await new Promise((r, j) => { child.once('exit', c => r(c ?? 1)); child.once('error', j); });
} finally { if (local) { local.server.closeAllConnections(); await new Promise(r => local.server.close(r)); } }
