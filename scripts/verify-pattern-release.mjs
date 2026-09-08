// Explicit final delivery after copy acceptance and direct user experience review.
// Run with ELECTRON_RUN_AS_NODE=1 and the built Electron dependency runtime.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync, cpSync, mkdirSync, renameSync, existsSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { convertPatterns } from './convert-patterns.mjs';

// Hash and copy the archive bytes, rather than Electron's virtual ASAR directory.
process.noAsar = true;
assert.equal(process.argv[2], 'cutover', 'Explicit cutover argument required');
const root = resolve('.');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const sync = path => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const ready = read('test-results/pattern-delivery-readiness.json');
const copy = read('test-results/pattern-copy-acceptance.json');
const location = read('test-results/pattern-copy-location.json');
const quality = read('test-results/pattern-quality/results.json');
assert.equal(copy.status, 'passed'); assert.equal(copy.directory, location.directory);
assert.equal(quality.user_acceptance.accepted, true);
const old = ready.bundles.find(b => b.role === 'current');
const candidate = ready.bundles.find(b => b.role === 'candidate');
assert.equal(copy.bundle_sha256, candidate.application_sha256);
assert.equal(hash(ready.conversion.converter), ready.conversion.converter_sha256);
for (const bundle of [old, candidate]) {
  assert.equal(hash(bundle.archive), bundle.archive_sha256);
  for (const file of bundle.files) assert.equal(hash(join(bundle.bundle, file.path)), file.sha256, file.path);
}
const source = join(homedir(), '.local/share/io.github.oukeidos.stomylos/stomylos.sqlite3');
assert.equal(hash(source), location.source_sha256, 'Repeat copy acceptance if normal data changed');
const id = randomUUID();
const archive = join(dirname(source), 'backups', 'pattern-delivery-' + id);
mkdirSync(archive, { mode: 0o700 });
const priorArchive = join(archive, 'stomylos-linux-x64-0.11.0.tar.gz');
copyFileSync(old.archive, priorArchive); sync(priorArchive);
assert.equal(hash(priorArchive), old.archive_sha256);
for (const name of ['pattern-copy-acceptance.json', 'pattern-copy-location.json', 'pattern-delivery-readiness.json']) {
  copyFileSync(join(root, 'test-results', name), join(archive, name)); sync(join(archive, name));
}
copyFileSync(ready.conversion.converter, join(archive, 'convert-patterns.mjs'));
copyFileSync('tests/fixtures/schema-v6-before-pattern.sql', join(archive, 'schema-v6.sql'));
copyFileSync('src/main/schema.sql', join(archive, 'schema-v7.sql'));
const stage = join(root, 'release', '.pattern-delivery-' + id);
const priorBundle = join(root, 'release', 'before-pattern-0.11.0-' + id);
cpSync(candidate.bundle, stage, { recursive: true, errorOnExist: true, force: false });
for (const file of candidate.files) assert.equal(hash(join(stage, file.path)), file.sha256, file.path);
const report = { status: 'prepared', archive, priorBundle, stage, source, source_sha256: location.source_sha256,
  application_sha256: candidate.application_sha256, archive_sha256: candidate.archive_sha256,
  rollback_rule: ready.rollback_rule, paidRequests: 0 };
const save = () => {
  writeFileSync(join(archive, 'delivery.json'), JSON.stringify(report, null, 2), { mode: 0o600, flush: true });
  writeFileSync('test-results/pattern-cutover-report.json', JSON.stringify(report, null, 2), { mode: 0o600, flush: true });
};
save(); sync(archive);
// The converter acquires the same application lock and rechecks the exact source.
report.conversion = convertPatterns(source, { expectedSourceHash: location.source_sha256 });
assert.equal(hash(source), report.conversion.target_sha256);
report.status = 'converted_bundle_switch_pending'; save();
renameSync(old.bundle, priorBundle);
try { renameSync(stage, old.bundle); }
catch (error) {
  // Keep the old bundle available, but do not restore an old database over v7.
  if (!existsSync(old.bundle)) renameSync(priorBundle, old.bundle);
  throw error;
}
sync(dirname(old.bundle));
const deliveredArchive = join(root, 'release', 'stomylos-linux-x64-0.12.0.tar.gz');
copyFileSync(candidate.archive, deliveredArchive); sync(deliveredArchive);
assert.equal(hash(join(old.bundle, 'resources/app.asar')), candidate.application_sha256);
assert.equal(hash(deliveredArchive), candidate.archive_sha256);
report.status = 'converted_and_switched'; report.deliveredArchive = deliveredArchive; save();
copyFileSync(join(archive, 'delivery.json'), join(report.conversion.archive, 'delivery.json'));
console.log(JSON.stringify({ status: report.status, archive, conversionArchive: report.conversion.archive,
  preservedRows: Object.values(report.conversion.counts).reduce((a, b) => a + b, 0), paidRequests: 0 }));
