// Offline native/package gates for the shared-memory release; no provider calls.
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const env = { ...process.env, STOMYLOS_VERIFY_BUNDLE: resolve('release/shared-memory-candidate/linux-unpacked/stomylos'), STOMYLOS_VERIFY_REPORT: 'test-results/shared-memory-package-report.json' };
const gates = [
  ['scripts/verify-memory.mjs', '--packaged'],
  ['scripts/verify-six-models.mjs', '--packaged'],
  ['scripts/verify-deletion.mjs', '--packaged'],
  ['scripts/verify-package.mjs'],
  ['scripts/verify-shared-memory-copy.mjs']
];
const results = [];
const applicationSha256 = createHash('sha256').update(readFileSync(resolve('release/shared-memory-candidate/linux-unpacked/resources/app.asar'))).digest('hex');
if (process.argv.includes('--resume')) {
  const previous = JSON.parse(readFileSync('test-results/shared-memory-release-gates.json', 'utf8'));
  if (previous.applicationSha256 && previous.applicationSha256 !== applicationSha256) throw new Error('Candidate changed since verification');
  copyFileSync('test-results/shared-memory-release-gates.json', `test-results/shared-memory-release-gates-before-${Date.now()}.json`);
  results.push(...previous.results.filter(r => r.exitCode === 0));
}
for (const args of gates) {
  if (results.some(r => r.script === args[0])) continue;
  const result = spawnSync('xvfb-run', ['-a', process.execPath, ...args], { env, encoding: 'utf8', timeout: 180000 });
  results.push({ script: args[0], exitCode: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  writeFileSync('test-results/shared-memory-release-gates.json', JSON.stringify({ applicationSha256, status: results.every(r => r.exitCode === 0) && results.length === gates.length ? 'passed' : 'incomplete', results }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ script: args[0], exitCode: result.status }));
  if (result.status !== 0) { console.error(result.stderr || result.stdout); process.exit(1); }
}
