import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Credentials, type SecureStorage } from '../src/main/credentials';
import { dataDirectory, keyFilePath } from '../src/main/storage';
import { validateCommand } from '../src/main/ipc';
import { Coordinator } from '../src/main/coordinator';
import { Store } from '../src/main/database';
import type { DatabaseClient } from '../src/main/db-client';
import type { Gateway } from '../src/main/transport';
import type { AppEvent, Settings } from '../src/shared/types';

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));

let directory: string, file: string, envFile: string, secure: SecureStorage, manager: Credentials;
const first = 'public-test-key-one', second = 'public-test-key-two', legacy = 'public-test-legacy';
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), 'stomylos-credentials-'));
  file = join(directory, 'api-credentials.json'); envFile = join(directory, '.env');
  const encryptionKey = randomBytes(32);
  secure = {
    isEncryptionAvailable: vi.fn(() => true), getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptString: vi.fn(value => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    }),
    decryptString: vi.fn(value => {
      const cipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    })
  };
  manager = new Credentials(file, envFile, 'linux', secure, 'personal');
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
function putEnv(text = `OPENROUTER_API_KEY=${legacy}\n`) { fs.writeFileSync(envFile, text, { mode: 0o600 }); }
function restart(os = 'linux') { const next = new Credentials(file, envFile, os, secure, 'personal'); next.refresh(); return next; }

it.each(['linux', 'darwin', 'win32'])('saves, reopens, replaces and deletes with the common %s adapter contract', os => {
  manager = restart(os); putEnv();
  manager.manage({ action: 'save', key: first });
  expect(manager.currentKey()).toBe(first);
  const bytes = fs.readFileSync(file);
  expect(bytes.includes(first)).toBe(false);
  expect(Buffer.from(JSON.parse(bytes.toString()).encrypted, 'base64').includes(first)).toBe(false);
  expect(restart(os).currentKey()).toBe(first);
  manager.manage({ action: 'save', key: second }); expect(restart(os).currentKey()).toBe(second);
  manager.manage({ action: 'delete' });
  expect(restart(os).snapshot()).toMatchObject({ source: 'none', saved: false, mode: 'disabled' });
  expect(restart(os).currentKey()).toBeNull(); expect(fs.readFileSync(envFile, 'utf8')).toContain(legacy);
  if (os !== 'linux') expect(secure.getSelectedStorageBackend).not.toHaveBeenCalled();
});
it('uses legacy files only when no secure key is stored, retaining quoted/export syntax', () => {
  putEnv(`export OPENROUTER_API_KEY='${legacy}' # retained\n`);
  expect(manager.refresh()).toBe(true); expect(manager.snapshot().source).toBe('env');
  manager.manage({ action: 'save', key: first });
  putEnv('OPENROUTER_API_KEY=broken\nOPENROUTER_API_KEY=duplicate\n');
  expect(manager.refresh()).toBe(true); expect(manager.currentKey()).toBe(first);
  expect(manager.snapshot()).toMatchObject({ source: 'secure', problem: null });
});
it('preserves explicit env selection across restart and switches back without deleting the secure key', () => {
  putEnv(); manager.manage({ action: 'save', key: first });
  manager.manage({ action: 'mode', mode: 'env' });
  expect(restart().currentKey()).toBe(legacy); expect(restart().snapshot().saved).toBe(true);
  manager.manage({ action: 'mode', mode: 'auto' }); expect(restart().currentKey()).toBe(first);
  manager.manage({ action: 'mode', mode: 'disabled' }); expect(restart().currentKey()).toBeNull();
});
it('imports and verifies the legacy key without changing the legacy file', () => {
  putEnv(); const before = fs.readFileSync(envFile);
  manager.manage({ action: 'import' });
  expect(restart().currentKey()).toBe(legacy); expect(restart().snapshot().source).toBe('secure');
  expect(fs.readFileSync(envFile)).toEqual(before); expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(directory).sort()).toEqual(['.env', 'api-credentials.json']);
});
it.each(['basic_text', 'unknown', 'unexpected-provider'])('rejects unprotected or unknown Linux backend %s while allowing legacy use', backend => {
  vi.mocked(secure.getSelectedStorageBackend).mockReturnValue(backend); putEnv();
  expect(manager.refresh()).toBe(true); expect(manager.snapshot().secureAvailable).toBe(false);
  expect(() => manager.manage({ action: 'save', key: first })).toThrow('secure_storage_unavailable');
  expect(secure.encryptString).not.toHaveBeenCalled(); expect(fs.existsSync(file)).toBe(false);
});
it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])('accepts the protected Linux backend %s', backend => {
  vi.mocked(secure.getSelectedStorageBackend).mockReturnValue(backend);
  manager.manage({ action: 'save', key: first }); expect(restart().currentKey()).toBe(first);
});
it('blocks silent fallback when a saved key is unavailable, and permits explicit env recovery', () => {
  putEnv(); manager.manage({ action: 'save', key: first });
  vi.mocked(secure.isEncryptionAvailable).mockReturnValue(false);
  expect(manager.refresh()).toBe(false);
  expect(manager.snapshot()).toMatchObject({ saved: true, source: 'none', problem: 'secure_storage_unavailable' });
  manager.manage({ action: 'mode', mode: 'env' }); expect(restart().currentKey()).toBe(legacy);
});
it('clears an old cached key on decryption failure without selecting legacy credentials', () => {
  putEnv(); manager.manage({ action: 'save', key: first });
  vi.mocked(secure.decryptString).mockImplementation(() => { throw new Error(`sensitive ${first}`); });
  expect(manager.refresh()).toBe(false); expect(manager.currentKey()).toBeNull();
  expect(manager.snapshot().problem).toBe('credential_decrypt_failed');
  expect(JSON.stringify(manager.snapshot())).not.toContain(first);
});
it('keeps the old file and active key when encryption verification fails', () => {
  manager.manage({ action: 'save', key: first }); const before = fs.readFileSync(file);
  vi.mocked(secure.decryptString).mockReturnValue('different');
  expect(() => manager.manage({ action: 'save', key: second })).toThrow('credential_encrypt_failed');
  expect(fs.readFileSync(file)).toEqual(before); expect(manager.currentKey()).toBe(first);
});
it('keeps the old file, key and mode when atomic replacement fails, including deletion', () => {
  manager.manage({ action: 'save', key: first }); const before = fs.readFileSync(file);
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('synthetic disk failure'); });
  for (const change of [{ action: 'save', key: second }, { action: 'delete' }, { action: 'mode', mode: 'disabled' }] as const) {
    expect(() => manager.manage(change)).toThrow('credential_save_failed');
    expect(fs.readFileSync(file)).toEqual(before); expect(manager.currentKey()).toBe(first);
    expect(manager.snapshot().mode).toBe('auto');
  }
  expect(fs.readdirSync(directory)).toEqual(['api-credentials.json']);
});
it('does not silently use env on corrupt storage and allows explicit reset', () => {
  putEnv(); fs.writeFileSync(file, '{broken');
  expect(manager.refresh()).toBe(false); expect(manager.snapshot().problem).toBe('credential_file_unreadable');
  manager.manage({ action: 'delete' }); expect(restart().snapshot().mode).toBe('disabled');
  manager.manage({ action: 'mode', mode: 'env' }); expect(manager.currentKey()).toBe(legacy);
});
it('rejects symlink and oversized credential files without exposing or changing their contents', () => {
  putEnv(); fs.symlinkSync(envFile, file); expect(manager.refresh()).toBe(false);
  expect(manager.snapshot().problem).toBe('credential_file_unreadable');
  fs.unlinkSync(file); fs.writeFileSync(file, 'x'.repeat(65537)); expect(manager.refresh()).toBe(false);
  expect(fs.readFileSync(envFile, 'utf8')).toContain(legacy);
});
it('reports malformed legacy files and preserves the selected secure key on a failed env switch', () => {
  putEnv('OPENROUTER_API_KEY=one\nOPENROUTER_API_KEY=two');
  expect(manager.refresh()).toBe(false); expect(manager.snapshot().problem).toBe('duplicate_api_key');
  manager.manage({ action: 'save', key: first });
  expect(() => manager.manage({ action: 'mode', mode: 'env' })).toThrow('duplicate_api_key');
  expect(restart().currentKey()).toBe(first);
});
it.each(['development', 'simulation'] as const)('never reads or probes real credentials in %s', context => {
  manager.manage({ action: 'save', key: first }); putEnv(); vi.clearAllMocks();
  const read = vi.spyOn(fs, 'readFileSync'); const check = vi.spyOn(fs, 'lstatSync');
  const isolated = new Credentials(file, envFile, 'linux', secure, context);
  isolated.refresh();
  expect(isolated.currentKey()).toBe(context === 'simulation' ? 'offline-test-key' : null);
  for (const change of [{ action: 'save', key: second }, { action: 'import' }, { action: 'delete' }, { action: 'mode', mode: 'env' }] as const)
    expect(() => isolated.manage(change)).toThrow('credential_management_disabled');
  expect(read).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
  expect(secure.isEncryptionAvailable).not.toHaveBeenCalled(); expect(secure.decryptString).not.toHaveBeenCalled();
});
it('validates the narrow IPC boundary without accepting caller paths or malformed keys', () => {
  for (const args of [{ action: 'save', key: first }, { action: 'delete' }, { action: 'import' }, { action: 'mode', mode: 'env' }])
    expect(() => validateCommand('manageKey', args)).not.toThrow();
  for (const args of [undefined, { action: 'save', key: '' }, { action: 'save', key: 'a\nb' }, { action: 'save', key: 'a'.repeat(4097) },
    { action: 'save', key: first, path: '/other' }, { action: 'read' }, { action: 'delete', key: first }, { action: 'mode', mode: 'other' }])
    expect(() => validateCommand('manageKey', args)).toThrow('invalid_command');
});
it('uses native local paths and preserves the existing legacy home path on all three OSes', () => {
  expect(dataDirectory('linux', { HOME: '/home/test' })).toBe('/home/test/.local/share/io.github.oukeidos.stomylos');
  expect(dataDirectory('darwin', {}, '/Users/test/Library/Application Support')).toBe('/Users/test/Library/Application Support/io.github.oukeidos.stomylos');
  expect(dataDirectory('win32', { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' })).toBe('C:\\Users\\test\\AppData\\Local\\Stomylos');
  expect(dataDirectory('win32', { USERPROFILE: 'C:\\Users\\test' })).toBe('C:\\Users\\test\\AppData\\Local\\Stomylos');
  expect(keyFilePath('win32', { USERPROFILE: 'C:\\Users\\test' })).toBe('C:\\Users\\test\\.stomylos\\.env');
  expect(keyFilePath('darwin', { HOME: '/Users/test' })).toBe('/Users/test/.stomylos/.env');
});
it('publishes source and availability through the coordinator without leaking keys or invoking providers', async () => {
  const store = new Store(directory, resolve('native/advisory-lock.node'));
  const db = { ready: Promise.resolve(), call: async (name: string, ...args: any[]) => (store as any)[name](...args) } as DatabaseClient;
  const gateway = { complete: vi.fn(), stream: vi.fn() } as unknown as Gateway;
  const settings: Settings = { keyPresent: false, keyPath: envFile, dataPath: directory, appVersion: 'test', development: false };
  const events: AppEvent[] = [];
  const controller = new Coordinator(db, gateway, settings, event => events.push(event), () => manager.refresh(), manager);
  try {
    await controller.initialize();
    await controller.command('manageKey', { action: 'save', key: first });
    expect((await controller.snapshot()).settings).toMatchObject({ keyPresent: true, credentials: { source: 'secure' } });
    vi.mocked(secure.encryptString).mockImplementation(() => { throw new Error(second); });
    await expect(controller.command('manageKey', { action: 'save', key: second })).rejects.toThrow('credential_encrypt_failed');
    expect((await controller.snapshot()).settings.keyPresent).toBe(true);
    await controller.command('refreshKey', undefined);
    await controller.command('manageKey', { action: 'delete' });
    expect((await controller.snapshot()).settings).toMatchObject({ keyPresent: false, credentials: { source: 'none', mode: 'disabled' } });
    expect(JSON.stringify(events)).not.toContain(first); expect(JSON.stringify(events)).not.toContain(second);
    expect(gateway.complete).not.toHaveBeenCalled(); expect(gateway.stream).not.toHaveBeenCalled();
  } finally { store.close(); }
});
