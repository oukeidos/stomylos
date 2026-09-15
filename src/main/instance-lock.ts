import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface InstanceApp {
  setPath(name: 'userData' | 'sessionData', path: string): void;
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: () => void): unknown;
}

/** The canonical userData path is the Electron singleton identity across checkouts. */
export function acquireInstance(app: InstanceApp, directory: string, focus: () => void): string | null {
  if (!isAbsolute(directory)) throw new Error('invalid_data_path');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  directory = realpathSync(directory);
  chmodSync(directory, 0o700);
  const profile = join(directory, 'chromium');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  if (lstatSync(profile).isSymbolicLink()) throw new Error('invalid_profile_path');
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  if (!app.requestSingleInstanceLock()) return null;
  // Never release this lock before process exit, including restore/restart/error UI.
  app.on('second-instance', focus);
  // A directory at the retired lock path makes legacy O_RDWR opens fail closed.
  // Never unlink an old lock file: another process may still hold/open its inode.
  const retired = join(directory, 'stomylos.lock');
  try { mkdirSync(retired, { mode: 0o700 }); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    const entry = lstatSync(retired);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('legacy_lock_transition_required');
    }
  }
  return directory;
}
