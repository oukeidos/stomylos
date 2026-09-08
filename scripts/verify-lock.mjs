import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const modulePath = process.env.STOMYLOS_LOCK_MODULE ? resolve(process.env.STOMYLOS_LOCK_MODULE) : resolve('native/advisory-lock.node');
const lock = require(modulePath).lock;
const directory = mkdtempSync(join(tmpdir(), 'stomylos-lock-parity-'));
const file = join(directory, 'stomylos.lock');
const probe = `import fcntl,sys
f=open(sys.argv[1], 'a+')
try: fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
 print('LOCKED',flush=True)
 sys.exit(23)
print('READY',flush=True)
if sys.argv[2]=='hold': sys.stdin.readline()
f.close()
`;
const fd = openSync(file, 'a', 0o600);
lock(fd);
const denied = spawnSync('python3', ['-u', '-c', probe, file, 'probe'], { encoding: 'utf8', timeout: 15000 });
closeSync(fd);
assert.equal(denied.status, 23, denied.stderr || denied.error?.message);
assert.match(denied.stdout, /LOCKED/);
const child = spawn('python3', ['-u', '-c', probe, file, 'hold'], { stdio: ['pipe', 'pipe', 'pipe'] });
try {
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Python lock probe did not become ready')), 15000);
    child.on('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Python probe exited early: ${code}`)); });
    child.stdout.on('data', data => { if (data.toString().includes('READY')) { clearTimeout(timer); done(); } });
  });
  const second = openSync(file, 'a', 0o600);
  try { assert.throws(() => lock(second), error => error.code === 'database_already_open'); }
  finally { closeSync(second); }
} finally { child.stdin.end('release\n'); }
await new Promise((done, reject) => { child.once('exit', code => code === 0 ? done() : reject(new Error(`Python exit ${code}`))); });
const final = openSync(file, 'a', 0o600); lock(final); closeSync(final);
console.log(`PASS: ${modulePath}: Node-held lock rejects Python; Python-held lock rejects Node; clean release permits reopen.`);
