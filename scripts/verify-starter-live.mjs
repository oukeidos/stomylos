// Separate, bounded renewal gate. Mock mode never loads a credential.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startMockGateway } from './mock-gateway.mjs';
const mock = process.argv.includes('--mock');
const resume = process.argv.includes('--resume-unattempted');
const supplied = process.argv[process.argv.indexOf('--run-dir') + 1];
if (!mock && (!process.argv.includes('--authorize-three-calls') || !process.argv.includes('--run-dir') || !isAbsolute(supplied ?? ''))) {
  throw new Error('Require --authorize-three-calls --run-dir <absolute unused path>. Maximum: three requests / USD 1; stop on failure.');
}
const directory = mock && !resume ? mkdtempSync(join(tmpdir(), 'stomylos-starter-live-mock-')) : supplied;
mkdirSync(directory, { recursive: true, mode: 0o700 });
const marker = join(directory, 'gate.json');
if (existsSync(marker) && !resume) throw new Error('This run was already started. Inspect its evidence; do not automatically retry.');
const pricesFile = 'test-results/starter-route-prices.json';
if (!mock && Date.now() - statSync(pricesFile).mtimeMs > 86400_000) throw new Error('Refresh public pinned-route prices before live verification.');
const prices = mock ? [] : JSON.parse(readFileSync(pricesFile, 'utf8'));
if (resume) {
  const saved = JSON.parse(readFileSync(marker, 'utf8'));
  if (saved.mock !== mock) throw new Error('The original run mode must be preserved');
  copyFileSync(join(directory, 'report.json'), join(directory, 'report-before-continuation.json'), constants.COPYFILE_EXCL);
} else writeFileSync(marker, JSON.stringify({ mock, maximumCalls: 3, maximumUsd: 1, inputTokenBound: 20000, startedAt: new Date().toISOString(), prices }), { flag: 'wx', mode: 0o600, flush: true });
const local = mock ? await startMockGateway() : null;
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', STOMYLOS_STARTER_VERIFY_DIR: directory };
delete env.STOMYLOS_LIVE_DIR; delete env.STOMYLOS_CONTINUITY_DIR; delete env.STOMYLOS_STARTER_MOCK_ENDPOINT;
if (local) env.STOMYLOS_STARTER_MOCK_ENDPOINT = local.endpoint;
try {
  const child = spawn(createRequire(import.meta.url)('electron'), ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.checks.config.ts', 'tests/starter-live.check.ts'], { stdio: 'inherit', env });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/starter-live-${mock ? 'mock-' : ''}report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); process.exitCode = code ?? 1;
} finally { if (local) await new Promise(resolve => local.server.close(resolve)); }
