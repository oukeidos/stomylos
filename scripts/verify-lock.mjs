// Focused native Electron singleton checks; temporary profiles, no DB or providers.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'stomylos-native-singleton-'));
const children = [];
try {
  await build({ entryPoints: ['src/main/instance-lock.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: join(root, 'lock.cjs') });
  const entry = join(root, 'probe.cjs');
  writeFileSync(entry, `const {app}=require('electron'); const {acquireInstance}=require('./lock.cjs');
const dir=acquireInstance(app, process.argv[2],()=>console.log('FOCUS'));
if (!dir) { console.log('DUPLICATE'); app.exit(0); }
else { app.whenReady().then(()=>console.log('READY')); process.stdin.resume(); process.stdin.on('data',()=>app.quit()); }
`);
  function launch(directory) {
    const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'config') }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [entry, directory], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child); child.output = ''; child.errors = '';
    child.stdout.on('data', bytes => { child.output += bytes; });
    child.stderr.on('data', bytes => { child.errors += bytes; });
    return child;
  }
  async function until(child, predicate) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timeout: ${child.output}\n${child.errors}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  const dir = join(root, 'data'), alias = join(root, 'alias'); mkdirSync(dir); symlinkSync(dir, alias);
  const first = launch(dir); await until(first, () => first.output.includes('READY'));
  const second = launch(alias); await until(second, () => second.exitCode !== null);
  assert.equal(second.exitCode, 0, second.errors); assert.match(second.output, /DUPLICATE/);
  await until(first, () => first.output.includes('FOCUS'));
  const independent = launch(join(root, 'other')); await until(independent, () => independent.output.includes('READY'));
  independent.stdin.write('quit'); await until(independent, () => independent.exitCode !== null);
  first.kill('SIGKILL'); await until(first, () => first.signalCode !== null);
  const recovered = launch(dir); await until(recovered, () => recovered.output.includes('READY'));
  recovered.stdin.write('quit'); await until(recovered, () => recovered.exitCode !== null);
  const reopened = launch(dir); await until(reopened, () => reopened.output.includes('READY'));
  reopened.stdin.write('quit'); await until(reopened, () => reopened.exitCode !== null);
  console.log('PASS: duplicate/alias rejection, focus notification, independent data, crash recovery, clean reopen.');
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 200));
  rmSync(root, { recursive: true, force: true });
}
