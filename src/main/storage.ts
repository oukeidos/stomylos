import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appId } from './contracts';
import { AppFailure } from './errors';

export function dataDirectory(os: string, env: NodeJS.ProcessEnv, nativeBase?: string): string {
  if (os === 'linux') {
    if (env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME)) return path.posix.join(env.XDG_DATA_HOME, appId);
    if (env.HOME && path.posix.isAbsolute(env.HOME)) return path.posix.join(env.HOME, '.local/share', appId);
  }
  if (os === 'darwin' && nativeBase && path.posix.isAbsolute(nativeBase)) return path.posix.join(nativeBase, appId);
  if (os === 'win32') {
    const base = nativeBase ?? env.LOCALAPPDATA ?? (env.USERPROFILE && path.win32.join(env.USERPROFILE, 'AppData', 'Local'));
    if (base && path.win32.isAbsolute(base)) return path.win32.join(base, 'Stomylos');
  }
  throw new AppFailure('application_data_path_unavailable');
}
export function keyFilePath(os: string, env: NodeJS.ProcessEnv): string {
  const home = env[os === 'win32' ? 'USERPROFILE' : 'HOME']; const p = os === 'win32' ? path.win32 : path.posix;
  if (!home || !p.isAbsolute(home)) throw new AppFailure('home_path_unavailable');
  return p.join(home, '.stomylos', '.env');
}
export function parseKey(text: string): string | null {
  let result: string | null = null;
  for (const line of text.split('\n')) {
    let value = line.trim().replace(/^export\s+/, ''); const equal = value.indexOf('=');
    if (equal < 0 || value.slice(0, equal).trim() !== 'OPENROUTER_API_KEY') continue;
    if (result !== null) throw new AppFailure('duplicate_api_key');
    value = value.slice(equal + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const end = value.indexOf(value[0], 1); const suffix = value.slice(end + 1).trim();
      if (end < 0 || (suffix && !suffix.startsWith('#'))) throw new AppFailure('invalid_key_file');
      value = value.slice(1, end);
    } else value = value.split(/\s+#/)[0].trim();
    if (!value || /\s|\$|`/.test(value)) throw new AppFailure('invalid_key_file');
    result = value;
  }
  return result;
}
export function loadKey(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    if (statSync(file).size > 64 * 1024) throw new AppFailure('invalid_key_file');
    return parseKey(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)));
  } catch (e) { if (e instanceof AppFailure) throw e; throw new AppFailure('key_file_unreadable'); }
}
/** Direct stores are for disposable tests only; Electron owns production exclusion. */
export type StoreAccess = 'electron' | 'isolated';
const held = new Set<string>();
export function lockDirectory(directory: string, access: StoreAccess): () => void {
  if (!path.isAbsolute(directory)) throw new AppFailure('invalid_data_path');
  if (access === 'electron') return () => undefined;
  if (access !== 'isolated') throw new AppFailure('electron_lock_required');
  // Check before creating anything outside the temporary tree, then resolve aliases.
  const relative = path.relative(realpathSync(tmpdir()), directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new AppFailure('isolated_data_required');
  let ancestor = directory;
  const missing: string[] = [];
  while (!existsSync(ancestor)) { missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  const canonical = path.join(realpathSync(ancestor), ...missing);
  const actual = path.relative(realpathSync(tmpdir()), canonical);
  if (!actual || actual.startsWith('..') || path.isAbsolute(actual) || existsSync(path.join(canonical, 'chromium'))) throw new AppFailure('isolated_data_required');
  mkdirSync(canonical, { recursive: true, mode: 0o700 });
  if (held.has(canonical)) throw new AppFailure('database_already_open');
  chmodSync(canonical, 0o700);
  held.add(canonical);
  let closed = false;
  return () => { if (!closed) { closed = true; held.delete(canonical); } };
}
