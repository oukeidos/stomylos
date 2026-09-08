import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const held = new Set<string>();
export function lockDirectory(directory: string, nativePath: string): () => void {
  if (!path.isAbsolute(directory)) throw new AppFailure('invalid_data_path');
  if (held.has(directory)) throw new AppFailure('database_already_open');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const file = path.join(directory, 'stomylos.lock');
  const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    chmodSync(file, 0o600);
    createRequire(process.execPath)(nativePath).lock(fd);
    held.add(directory);
  } catch (e: any) { closeSync(fd); throw new AppFailure(e?.code === 'database_already_open' ? e.code : 'lock_failed'); }
  let closed = false;
  return () => { if (!closed) { closed = true; closeSync(fd); held.delete(directory); } };
}
