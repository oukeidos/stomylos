// Run only after explicit authorization. This is a bounded live behavior screen, not an ordinary test.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';

const index = process.argv.indexOf('--run-dir'), directory = index >= 0 ? process.argv[index + 1] : null;
if (!process.argv.includes('--authorize-32-calls') || !directory || !isAbsolute(directory) || !directory.startsWith('/tmp/stomylos-associative-recall-live-'))
  throw new Error('Use --authorize-32-calls --run-dir /tmp/stomylos-associative-recall-live-<name>. Maximum 32 inference attempts / USD5.');
if (existsSync(directory)) throw new Error('Run directory exists; inspect its immutable ledger instead of restarting paid work.');
const runtime = JSON.parse(readFileSync('src/main/runtime-config.json', 'utf8'));
const cases = JSON.parse(readFileSync('tests/fixtures/associative-recall-live-cases.json', 'utf8'));
const models = runtime.conversation.characters.map(character => character.model);
const prices = {};
for (const model of models) {
  const response = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Cannot verify current provider prices: ${model}`);
  const data = await response.json(), endpoints = data.data?.endpoints;
  if (!Array.isArray(endpoints) || !endpoints.length) throw new Error(`No current endpoints: ${model}`);
  const maximum = {};
  for (const name of ['prompt', 'completion', 'request']) {
    const values = endpoints.map(endpoint => Number(endpoint.pricing?.[name] ?? (name === 'request' ? 0 : NaN)));
    if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error(`Unusable price data: ${model}`);
    maximum[name] = Math.max(...values);
  }
  prices[model] = maximum;
}
const jobs = [];
for (const character of runtime.conversation.characters) for (const item of cases.cases) {
  // The bound intentionally counts JSON bytes as tokens, so it is conservative.
  const inputBound = 24_000, price = prices[character.model];
  const reservation_usd = inputBound * price.prompt + cases.response_token_cap * price.completion + price.request;
  jobs.push({ id: `${character.id}-${item.id}`, character: character.id, model: character.model, case: item,
    response_token_cap: cases.response_token_cap, reservation_usd });
}
const maximum_usd = 5, total = jobs.reduce((sum, job) => sum + job.reservation_usd, 0);
if (!Number.isFinite(total) || total > maximum_usd) throw new Error(`Conservative maximum USD${total.toFixed(4)} exceeds USD${maximum_usd}; do not dispatch.`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const sources = ['src/main/contracts.ts', 'src/main/associative-recall.ts', 'src/main/provider-policy.ts', 'src/main/transport.ts',
  'src/main/runtime-config.json', 'tests/fixtures/associative-recall-live-cases.json', 'tests/associative-recall-live.check.ts'];
const hashes = Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
writeFileSync(join(directory, 'gate.json'), JSON.stringify({ version: cases.version, frozen_at: new Date().toISOString(), maximum_calls: 32,
  maximum_usd, conservative_reserved_usd: total, response_token_cap: cases.response_token_cap, prices, hashes, jobs }, null, 2), { flag: 'wx', mode: 0o600, flush: true });
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', STOMYLOS_ASSOCIATIVE_RECALL_VERIFY_DIR: directory };
for (const name of Object.keys(env)) if (name.startsWith('STOMYLOS_') && name !== 'STOMYLOS_ASSOCIATIVE_RECALL_VERIFY_DIR') delete env[name];
const child = spawn(createRequire(import.meta.url)('electron'), ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.checks.config.ts', 'tests/associative-recall-live.check.ts'], { stdio: 'inherit', env, cwd: resolve('.') });
process.exitCode = await new Promise((resolveExit, reject) => { child.once('exit', code => resolveExit(code ?? 1)); child.once('error', reject); });
