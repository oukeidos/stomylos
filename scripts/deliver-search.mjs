// Explicit, bounded normal-data cutover after the recorded copy/package gates.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, cpSync, mkdirSync, renameSync, readdirSync, lstatSync, openSync, closeSync, fsyncSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { extractFile } from '@electron/asar';
assert.equal(process.argv[2], 'cutover', 'Explicit cutover argument required');
const require = createRequire(import.meta.url), read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const sync = path => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const copy = read('test-results/search-copy-acceptance.json'), location = read('test-results/search-copy-location.json');
assert.equal(copy.status, 'passed'); assert.equal(copy.directory, location.directory);
assert.equal(read('test-results/package-report.json').status, 'passed');
assert.equal(read('test-results/search-packaged/report.json').passed, true);
assert.equal(read('test-results/asr-package-report.json').status, 'passed');
assert.equal(read('test-results/tts-package-report.json').status, 'passed');
assert.equal(read('test-results/pattern-packaged.json').passed, true);
assert.equal(read('test-results/markdown-packaged/report.json').status, 'passed');
assert.equal(read('test-results/search-live-20260906-a/quality-review.json').status, 'reviewed');
const live = read('test-results/search-live-20260906-a/report.json');
assert.equal(live.results.length, 20); assert.ok(live.results.every(r => r.request.status === 'succeeded'));
assert.equal(live.unknownCostReservationUsd, 0); assert.ok(live.reportedUsd <= 5);
const source = location.manifest.source, candidate = resolve('release/search-final/linux-unpacked');
const active = resolve('release/linux-unpacked'), candidateArchive = resolve('release/stomylos-linux-x64-0.13.0.tar.gz');
assert.equal(hash(source), location.manifest.source_sha256, 'Repeat copy acceptance if normal data changed');
assert.equal(hash(join(candidate, 'resources/app.asar')), copy.bundle_sha256);
assert.equal(read('test-results/release-audit.json').sha256, hash(candidateArchive));
assert.equal(JSON.parse(extractFile(join(active, 'resources/app.asar'), 'package.json').toString()).version, '0.12.2');
assert.equal(JSON.parse(extractFile(join(candidate, 'resources/app.asar'), 'package.json').toString()).version, '0.13.0');
const files = folder => readdirSync(folder).flatMap(name => {
  const file = join(folder, name), stat = lstatSync(file);
  assert.ok(!stat.isSymbolicLink(), 'Unexpected release symlink');
  return stat.isDirectory() ? files(file) : [file];
});
const candidateFiles = files(candidate).map(file => ({ path: file.slice(candidate.length + 1), sha256: hash(file) }));
const priorFiles = files(active).map(file => ({ path: file.slice(active.length + 1), sha256: hash(file) }));
const id = randomUUID(), archive = join(dirname(source), 'backups', 'search-delivery-' + id);
mkdirSync(archive, { mode: 0o700 });
const priorArchive = join(archive, 'stomylos-linux-x64-0.12.2.tar.gz');
copyFileSync('release/stomylos-linux-x64-0.12.2.tar.gz', priorArchive); sync(priorArchive);
assert.equal(hash(priorArchive), hash('release/stomylos-linux-x64-0.12.2.tar.gz'));
for (const name of ['search-copy-acceptance.json', 'search-copy-location.json', 'release-audit.json']) copyFileSync(join('test-results', name), join(archive, name));
const stage = resolve('release/.search-delivery-' + id), priorBundle = resolve('release/before-search-0.12.2-' + id);
cpSync(candidate, stage, { recursive: true, errorOnExist: true, force: false });
for (const file of candidateFiles) assert.equal(hash(join(stage, file.path)), file.sha256);
const report = { status: 'prepared', source, archive, priorBundle, stage, candidateFiles, priorFiles,
  application_sha256: copy.bundle_sha256, candidate_archive_sha256: hash(candidateArchive), prior_archive_sha256: hash(priorArchive),
  rollback_rule: 'Preserve both current data and its backup. Restore the matched v7 DB and 0.12.2 bundle only before new writes; otherwise use verified recovery or a forward fix.', inferenceActions: 0 };
const save = () => {
  for (const file of [join(archive, 'delivery.json'), 'test-results/search-cutover-report.json']) writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600, flush: true });
};
save(); sync(archive);
report.conversion = JSON.parse(execFileSync(require('electron'), ['scripts/convert-search.mjs', source, '--expected-source-sha256', location.manifest.source_sha256],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }));
assert.equal(hash(source), report.conversion.target_sha256);
report.status = 'converted_bundle_switch_pending'; save();
renameSync(active, priorBundle);
try { renameSync(stage, active); }
catch (error) { if (!existsSync(active)) renameSync(priorBundle, active); throw error; }
sync(dirname(active));
for (const file of candidateFiles) assert.equal(hash(join(active, file.path)), file.sha256);
for (const file of priorFiles) assert.equal(hash(join(priorBundle, file.path)), file.sha256);
report.status = 'converted_and_switched'; save();
copyFileSync(join(archive, 'delivery.json'), join(report.conversion.archive, 'delivery.json'));
console.log(JSON.stringify({ status: report.status, archive, conversionArchive: report.conversion.archive,
  preservedRows: Object.values(report.conversion.counts).reduce((a, b) => a + b, 0), inferenceActions: 0 }));
