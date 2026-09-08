// Accept only fixtures converted and verified outside the product. No conversion runs here.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const supplied = process.argv[process.argv.indexOf('--fixture-dir') + 1];
if (!process.argv.includes('--fixture-dir') || !supplied) throw new Error('Supply --fixture-dir for a fresh externally converted public continuity fixture. See ../docs/PRODUCT_VERIFICATION.md.');
const root = resolve(supplied);
const external = JSON.parse(readFileSync(join(root, 'external-conversion.json'), 'utf8'));
assert.equal(external.status, 'passed'); assert.equal(external.directory, root);
const source = readFileSync(join(root, 'electron-copy/stomylos.sqlite3'));
assert.equal(createHash('sha256').update(source).digest('hex'), external.converted.installed_sha256, 'Use the unchanged external stage before application recovery');
const child = spawn(process.execPath, ['scripts/test.mjs', '--check', 'continuity'], { stdio: 'inherit', env: { ...process.env, STOMYLOS_CONTINUITY_DIR: root } });
const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
if (code !== 0) throw new Error('Externally converted continuity assertions failed');
const before = JSON.parse(readFileSync(join(root, 'before.json'), 'utf8'));
const after = JSON.parse(readFileSync(join(root, 'electron-after.json'), 'utf8'));
const report = { status: 'passed', directory: root, externalEvidence: external, legacySessions: before.tables.sessions.length,
  resultingSessions: after.tables.sessions.length, checks: ['Actual Dart-created v1 refused unchanged', 'External conversion preserves every original row',
    'Matching supported recovery', 'Immutable raw source/config snapshots', 'No historical job backfill', 'Migrated active session renewal', 'Candidate and draft reopen'] };
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/continuity-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
