import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDirectory } from '../src/main/storage';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const directory = mkdtempSync(join(tmpdir(), 'stomylos-path-')); roots.push(directory); return directory; }
it('uses the developer handle independently of the OS username and honors XDG', () => {
  const home = root();
  expect(dataDirectory('linux', { HOME: home })).toBe(join(home, '.local/share/io.github.oukeidos.stomylos'));
  expect(dataDirectory('linux', { HOME: home, XDG_DATA_HOME: 'relative' })).toBe(join(home, '.local/share/io.github.oukeidos.stomylos'));
  const xdg = root();
  expect(dataDirectory('linux', { HOME: home, XDG_DATA_HOME: xdg })).toBe(join(xdg, 'io.github.oukeidos.stomylos'));
});
