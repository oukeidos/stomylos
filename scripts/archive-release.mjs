import { listPackage, extractFile, statFile } from '@electron/asar';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import assert from 'node:assert/strict';
const bundle = resolve(process.env.STOMYLOS_ARCHIVE_BUNDLE ?? 'release/linux-unpacked');
const entries = listPackage(join(bundle, 'resources/app.asar'));
const forbidden = /\/(?:product-legacy|_reference|experiments|tests|test-results|scripts|\.git|\.env)(?:\/|$)|\.sqlite3?(?:$|-)|\.map$|\/(?:src|deps)\//;
assert.ok(entries.every(name => !forbidden.test(name)), 'Unexpected source/private artifact in application archive');
for (const file of ['/out/main/db-worker.js', '/native/advisory-lock.node', '/node_modules/better-sqlite3/prebuilds/linux-x64.node']) assert.ok(entries.includes(file), `Missing runtime file ${file}`);
assert.ok(!entries.some(name => /node_modules\/(?:react|@radix-ui)\//.test(name)), 'Renderer dependencies should already be bundled');
const files = [];
function walk(folder) {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name); const stat = statSync(path);
    if (stat.isDirectory()) walk(path); else files.push(path);
  }
}
walk(bundle);
const privatePattern = /\/home\/[^/\s]+|\/Users\/[^/\s]+|sk-or-v1-[A-Za-z0-9]{12,}|EXP-009-authentic|router-p4-flat-v1|exp008_baseline_v1/;
const vendorFiles = [];
for (const path of files) {
  const relativePath = relative(bundle, path);
  const vendor = join('node_modules/electron/dist', relativePath === 'stomylos' ? 'electron' : relativePath);
  if (existsSync(vendor) && statSync(vendor).isFile()) {
    // Pinned Chromium binaries contain literal privacy/home-path examples. Verify
    // their exact vendor bytes instead of treating those strings as user data.
    assert.ok(readFileSync(path).equals(readFileSync(vendor)), `Changed Electron runtime file: ${relativePath}`);
    vendorFiles.push(relativePath); continue;
  }
  if (relative(bundle, path) !== 'resources/app.asar') {
    assert.ok(!privatePattern.test(readFileSync(path).toString('latin1')), `Private/development string in ${relative(bundle, path)}`);
    continue;
  }
  for (const entry of entries) {
    assert.ok(!privatePattern.test(entry), `Private archive path: ${entry}`);
    if (statFile(path, entry.slice(1)).files) continue;
    let content = extractFile(path, entry.slice(1)).toString('latin1');
    // Emscripten creates this literal virtual directory; it is not a host user's path.
    // Limit the exception to exact quoted literals in the pinned libflac runtime files.
    if (/^\/node_modules\/libflacjs\/dist\/libflac(?:\.(?:dev|min))?(?:\.wasm)?\.js$/.test(entry))
      content = content.replace(/(['"])\/home\/web_user\1/g, '$1/virtual-web-user$1');
    assert.ok(!privatePattern.test(content), `Private/development string in ${entry}`);
  }
}
for (const file of ['stomylos', 'run.sh', 'install-desktop.sh', 'icon.png', 'README.md', 'stomylos.desktop']) assert.ok(files.includes(join(bundle, file)), `Missing release file ${file}`);
assert.deepEqual(readFileSync(join(bundle, 'README.md')), readFileSync('README.md'), 'Packaged README must match the user documentation');
assert.ok(!files.includes(join(bundle, 'USER_GUIDE.md')), 'Retired user guide must not ship');
execFileSync('desktop-file-validate', [join(bundle, 'stomylos.desktop')]);
assert.ok(readFileSync(join(bundle, 'icon.png')).equals(readFileSync('assets/icon.png')), 'Packaged icon must match the selected source asset');
assert.ok(!files.some(file => file.endsWith('icon-i2-approved-reference.png')), 'Reference sheet must not ship');
const libraries = execFileSync('ldd', [join(bundle, 'stomylos')], { encoding: 'utf8' });
assert.ok(!libraries.includes('not found'), 'Missing Linux shared library');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const archive = resolve(process.env.STOMYLOS_ARCHIVE_OUTPUT ?? `release/stomylos-linux-x64-${version}.tar.gz`);
const stagedArchive = archive + '.partial';
try {
  // Do not publish the build machine's account names or numeric user/group IDs.
  execFileSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '-czf', stagedArchive, '-C', bundle, '.']);
  renameSync(stagedArchive, archive);
} finally { rmSync(stagedArchive, { force: true }); }
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(archive + '.sha256', `${sha256}  ${archive.split('/').at(-1)}\n`);
mkdirSync('test-results', { recursive: true });
const report = { version, archive, sha256, applicationSha256: createHash('sha256').update(readFileSync(join(bundle, 'resources/app.asar'))).digest('hex'), archiveBytes: statSync(archive).size, bundleBytes: files.reduce((n, file) => n + statSync(file).size, 0), files: files.map(file => relative(bundle, file)), vendorFiles, applicationFiles: entries, status: 'audited-candidate' };
writeFileSync(process.env.STOMYLOS_ARCHIVE_REPORT ?? 'test-results/release-audit.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, archive, sha256, archiveBytes: report.archiveBytes, bundleBytes: report.bundleBytes }));
// During preparation keep the installed version plus this candidate. Delivery
// pruning reduces that to the installed archive alone. Isolated outputs never
// remove workspace artifacts.
if (!process.env.STOMYLOS_ARCHIVE_OUTPUT) {
  const installedAsar = resolve('release/linux-unpacked/resources/app.asar');
  const installedVersion = existsSync(installedAsar) ? JSON.parse(extractFile(installedAsar, 'package.json')).version : version;
  const keep = new Set([version, installedVersion]);
  for (const name of readdirSync('release')) {
    const match = /^stomylos-linux-x64-(\d+\.\d+\.\d+)\.tar\.gz(?:\.sha256)?$/.exec(name);
    if (match && !keep.has(match[1])) rmSync(join('release', name));
  }
}
