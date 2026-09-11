// Explicit setup only. App inference never downloads files or follows mutable revisions.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'src/main/memory-embedding-manifest.json'), 'utf8'));
const verifyOnly = process.argv.includes('--verify');
if (process.argv.slice(2).some(a => a !== '--verify')) throw new Error('Usage: node scripts/fetch-memory-model.mjs [--verify]');
if (!/^[a-f0-9]{40}$/.test(manifest.revision) || manifest.upstream !== 'Xenova/bge-small-en-v1.5') throw new Error('Invalid fixed model source');
const target = resolve(root, 'assets/memory-model');
async function valid(path, entry) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes) return false;
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    return digest.digest('hex') === entry.sha256;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
for (const entry of manifest.files) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(entry.path) || entry.path.includes('..') || entry.path.startsWith('/') || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid file manifest');
  const path = resolve(target, entry.path);
  if (await valid(path, entry)) { console.log(`Verified ${entry.path}`); continue; }
  if (verifyOnly) throw new Error(`Missing or invalid ${entry.path}. Run npm run model:fetch.`);
  await mkdir(dirname(path), { recursive: true });
  const partial = path + `.${process.pid}.partial`;
  try {
    const response = await fetch(`https://huggingface.co/${manifest.upstream}/resolve/${manifest.revision}/${entry.path}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
    let bytes = 0;
    const bounded = new Transform({ transform(chunk, _encoding, next) {
      bytes += chunk.length;
      next(bytes > entry.bytes ? new Error('Model download exceeds manifest size') : null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), bounded, createWriteStream(partial, { flags: 'wx', mode: 0o644 }));
    if (!(await valid(partial, entry))) throw new Error(`Model checksum mismatch: ${entry.path}`);
    await rename(partial, path);
    console.log(`Acquired and verified ${entry.path}`);
  } finally { await unlink(partial).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
console.log(`Verified fixed model ${manifest.upstream}@${manifest.revision}; resources remain outside Git.`);
