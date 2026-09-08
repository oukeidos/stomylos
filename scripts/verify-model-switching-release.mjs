// Read-only aggregate verification of the isolated model-switching candidate.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { extractFile } from '@electron/asar';
import assert from 'node:assert/strict';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = resolve('.'), bundle = 'release/model-switch-candidate/linux-unpacked', asar = join(bundle, 'resources/app.asar'), files = {};
function verify(folder) {
  for (const name of readdirSync(folder)) {
    const file = join(folder, name);
    if (statSync(file).isDirectory()) verify(file);
    else { const key = relative(root, resolve(file)); files[key] = hash(readFileSync(file)); assert.equal(hash(extractFile(asar, key)), files[key], key); }
  }
}
verify('out');
// electron-builder intentionally strips development-only package fields.
const { scripts, build, devDependencies, ...expected } = read('package.json');
assert.deepEqual(JSON.parse(extractFile(asar, 'package.json')), expected);
assert.deepEqual(readFileSync(join(bundle, 'README.md')), readFileSync('README.md'));
assert.equal(expected.version, '0.19.0');
for (const path of ['model-switching-native/report.json','model-switching-packaged/report.json','model-switching-copy-acceptance.json','model-switching-install.json']) assert.equal(read('test-results/' + path).status, 'passed', path);
const archive = read('test-results/model-switching-archive.json'); assert.equal(archive.status, 'audited-candidate');
assert.equal(hash(readFileSync(archive.archive)), archive.sha256);
assert.equal(read('test-results/model-switching-install.json').archiveSha256, archive.sha256);
const offline = readFileSync('test-results/model-switching-offline.log', 'utf8');
assert.match(offline, /Test Files\s+36 passed/); assert.match(offline, /Tests\s+426 passed \| 1 skipped/);
const report = { status: 'passed', version: '0.19.0', archiveSha256: hash(readFileSync(asar)), releaseSha256: archive.sha256,
  guideSha256: hash(readFileSync('README.md')), packageSha256: hash(extractFile(asar, 'package.json')), offlineSha256: hash(offline), files, paidRequests: 0, normalDelivery: false };
writeFileSync('test-results/model-switching-package-parity.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, version: report.version, builtFiles: Object.keys(files).length, asarSha256: report.archiveSha256, releaseSha256: report.releaseSha256, normalDelivery: false }));
