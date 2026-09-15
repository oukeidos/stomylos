import { afterEach, expect, it, vi } from 'vitest';
import { constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireInstance } from '../src/main/instance-lock';
import { lockDirectory } from '../src/main/storage';
const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'stomylos-singleton-')); roots.push(dir); return dir; };
const mock = (primary = true) => ({ setPath: vi.fn(), requestSingleInstanceLock: vi.fn(() => primary), on: vi.fn() });
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it('uses canonical data identity before acquiring Electron and blocks legacy writable lock opens', () => {
  const dir = root(), alias = join(root(), 'alias'); symlinkSync(dir, alias);
  const app = mock(), focus = vi.fn();
  expect(acquireInstance(app, alias, focus)).toBe(dir);
  expect(app.setPath.mock.calls).toEqual([['userData', join(dir, 'chromium')], ['sessionData', join(dir, 'chromium')]]);
  expect(app.setPath.mock.invocationCallOrder[1]).toBeLessThan(app.requestSingleInstanceLock.mock.invocationCallOrder[0]);
  expect(app.on).toHaveBeenCalledWith('second-instance', focus);
  expect(lstatSync(join(dir, 'stomylos.lock')).isDirectory()).toBe(true);
  expect(() => openSync(join(dir, 'stomylos.lock'), constants.O_CREAT | constants.O_RDWR)).toThrow();
});
it('returns before modifying the retired lock path when another instance owns the data', () => {
  const dir = root(), file = join(dir, 'stomylos.lock'); writeFileSync(file, 'untouched');
  const app = mock(false);
  expect(acquireInstance(app, dir, vi.fn())).toBeNull();
  expect(readFileSync(file, 'utf8')).toBe('untouched'); expect(app.on).not.toHaveBeenCalled();
});
it('fails closed on an old lock file without unlinking or overwriting it', () => {
  const dir = root(), file = join(dir, 'stomylos.lock'); writeFileSync(file, 'old inode');
  const before = lstatSync(file).ino;
  expect(() => acquireInstance(mock(), dir, vi.fn())).toThrow('legacy_lock_transition_required');
  expect(lstatSync(file).ino).toBe(before); expect(readFileSync(file, 'utf8')).toBe('old inode');
});
it('rejects aliased Chromium profiles and retired lock paths', () => {
  const dir = root(), other = root(); symlinkSync(other, join(dir, 'chromium'));
  expect(() => acquireInstance(mock(), dir, vi.fn())).toThrow('invalid_profile_path');
  const another = root(); symlinkSync(other, join(another, 'stomylos.lock'));
  expect(() => acquireInstance(mock(), another, vi.fn())).toThrow('legacy_lock_transition_required');
});
it('permits a fresh process to reuse a completed transition', () => {
  const dir = root(); expect(acquireInstance(mock(), dir, vi.fn())).toBe(dir);
  expect(acquireInstance(mock(), dir, vi.fn())).toBe(dir);
});
it('limits direct Store access to disposable directories and prevents duplicate local owners', () => {
  expect(() => lockDirectory('/var/stomylos-forbidden', 'isolated')).toThrow('isolated_data_required');
  const dir = root(), unlock = lockDirectory(dir, 'isolated');
  try { expect(() => lockDirectory(dir, 'isolated')).toThrow('database_already_open'); }
  finally { unlock(); }
  lockDirectory(dir, 'isolated')();
  mkdirSync(join(dir, 'chromium'));
  expect(() => lockDirectory(dir, 'isolated')).toThrow('isolated_data_required');
});

it('rejects temporary aliases to non-temporary data before creating a child', () => {
  const alias = join(root(), 'outside'); symlinkSync('/var', alias);
  expect(() => lockDirectory(join(alias, 'stomylos-must-not-create'), 'isolated')).toThrow('isolated_data_required');
});
