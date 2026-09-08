import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'stomylos-install-'));
const bundle = join(root, 'A folder with spaces');
const desktop = join(root, 'Desktop'); const data = join(root, 'data'); const configuration = join(root, 'config');
for (const folder of [bundle, desktop, data, configuration]) mkdirSync(folder, { recursive: true });
const audit = JSON.parse(readFileSync(process.env.STOMYLOS_INSTALL_AUDIT ?? 'test-results/release-audit.json', 'utf8'));
assert.equal(createHash('sha256').update(readFileSync(audit.archive)).digest('hex'), audit.sha256);
await exec('tar', ['-xzf', audit.archive, '-C', bundle]);
assert.deepEqual(readFileSync(join(bundle, 'README.md')), readFileSync('README.md'), 'Archived README matches the user documentation');
assert.deepEqual(readFileSync(join(bundle, 'icon.png')), readFileSync('assets/icon.png'), 'Archived icon matches the selected source asset');
writeFileSync(join(configuration, 'user-dirs.dirs'), `XDG_DESKTOP_DIR="${desktop}"\n`);
const env = { ...process.env, XDG_CONFIG_HOME: configuration, XDG_DATA_HOME: data, STOMYLOS_DATA_DIR: join(root, 'history') };
delete env.STOMYLOS_LIVE_VERIFY; delete env.STOMYLOS_TEST_ENDPOINT; delete env.ELECTRON_RUN_AS_NODE;
const installer = join(bundle, 'install-desktop.sh');
await exec(installer, [], { env, cwd: tmpdir() });
const entries = [join(data, 'applications/stomylos.desktop'), join(desktop, 'stomylos.desktop')];
for (const entry of entries) {
  const content = readFileSync(entry, 'utf8');
  assert.ok(content.includes(`Exec="${join(bundle, 'run.sh')}"`));
  assert.ok(content.includes(`TryExec=${join(bundle, 'run.sh')}`));
  assert.ok(content.includes(`Icon=${join(bundle, 'icon.png')}`));
  assert.ok(content.includes('X-Stomylos-Managed=true'));
  assert.equal(statSync(entry).mode & 0o777, 0o755);
  await exec('desktop-file-validate', [entry]);
}
// Run the actual extracted runtime through its launcher, without GUI, SDK or data access.
const runtime = await exec(join(bundle, 'run.sh'), ['-p', 'process.versions.electron'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, cwd: tmpdir() });
assert.equal(runtime.stdout.trim(), '44.1.1');
const applicationEntry = readFileSync(entries[0]); const unrelated = '[Desktop Entry]\nType=Application\nName=Unrelated fixture\nExec=true\n';
writeFileSync(entries[1], unrelated);
await assert.rejects(exec(installer, [], { env, cwd: tmpdir() }), error => error.code === 1);
assert.equal(readFileSync(entries[1], 'utf8'), unrelated);
assert.deepEqual(readFileSync(entries[0]), applicationEntry);
// Verify the source-tree fallback separately, without touching a real shortcut.
writeFileSync(entries[1], applicationEntry);
await exec(resolve('install-desktop.sh'), [], { env, cwd: tmpdir() });
for (const entry of entries) {
  const content = readFileSync(entry, 'utf8');
  assert.ok(content.includes(`Icon=${resolve('assets/icon.png')}`));
  assert.ok(content.includes(`Exec="${resolve('run.sh')}"`));
  await exec('desktop-file-validate', [entry]);
}
const report = { status: 'passed', directory: root, archiveSha256: audit.sha256,
  checks: ['Verified archive extraction into a path with spaces', 'Managed menu and desktop entries installed and validated in isolated XDG paths', 'Portable launcher runs the bundled Electron runtime', 'Unrelated shortcut is preserved without partial replacement'] };
mkdirSync('test-results', { recursive: true }); writeFileSync(process.env.STOMYLOS_INSTALL_REPORT ?? 'test-results/install-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
rmSync(root, { recursive: true, force: true });
