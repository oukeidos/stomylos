// Development-only export. Packaged applications use the checked-in PNG.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const previews = process.argv.slice(2);
if (previews.length > 1 || (previews.length === 1 && previews[0] !== '--previews')) {
  throw new Error('Usage: node scripts/render-icon.mjs [--previews]');
}
const root = new URL('../', import.meta.url);
const source = fileURLToPath(new URL('assets/icon.svg', root));
let version;
try {
  version = execFileSync('rsvg-convert', ['--version'], { encoding: 'utf8' }).trim();
} catch {
  throw new Error('Icon export requires rsvg-convert (librsvg). Ordinary builds use assets/icon.png and do not require it.');
}
function render(size, target) {
  execFileSync('rsvg-convert', ['--width', String(size), '--height', String(size), '--output', target, source]);
}
render(512, fileURLToPath(new URL('assets/icon.png', root)));
if (previews.length) {
  const directory = new URL('test-results/icon/', root);
  mkdirSync(directory, { recursive: true });
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    render(size, fileURLToPath(new URL(`icon-${size}.png`, directory)));
  }
}
console.log(`Exported I-2 application icon with ${version}.`);
