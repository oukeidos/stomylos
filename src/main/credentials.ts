import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KeyAction, KeyStatus, KeyMode } from '../shared/credentials';
import { validApiKey } from '../shared/credentials';
import { AppFailure, failureCode } from './errors';
import { loadKey } from './storage';

export interface SecureStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
interface CredentialFile { version: 1; mode: KeyMode; encrypted: string | null }
const empty = (): CredentialFile => ({ version: 1, mode: 'auto', encrypted: null });

// Intentionally use the matched synchronous safeStorage pair: on Linux its
// selected backend can be checked explicitly. Do not mix ciphertext/providers
// with the async API, whose fallback provider has a different contract.
export class Credentials {
  private key: string | null = null;
  private status: KeyStatus = { mode: 'auto', source: 'none', saved: false, secureAvailable: false, problem: null };
  constructor(private file: string, private envFile: string, private os: string,
    private secure: SecureStorage, private context: 'personal' | 'development' | 'simulation') {}
  currentKey = () => this.key;
  snapshot(): KeyStatus { return { ...this.status }; }
  private available(): boolean {
    try {
      return ['linux', 'darwin', 'win32'].includes(this.os) && this.secure.isEncryptionAvailable() &&
        (this.os !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.secure.getSelectedStorageBackend()));
    } catch { return false; }
  }
  private read(): CredentialFile {
    let fd: number | undefined;
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('invalid');
      fd = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const value = JSON.parse(readFileSync(fd, 'utf8'));
      if (!value || value.version !== 1 || !['auto', 'env', 'disabled'].includes(value.mode) ||
        Object.keys(value).length !== 3 || !(value.encrypted === null ||
          typeof value.encrypted === 'string' && value.encrypted.length > 0 && value.encrypted.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.encrypted))) throw new Error('invalid');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      throw new AppFailure('credential_file_unreadable');
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  private write(value: CredentialFile) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      if (this.os !== 'win32') fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined;
      // This replaces the complete record, including source selection, atomically.
      renameSync(temporary, this.file);
    } catch { throw new AppFailure('credential_save_failed'); }
    finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* No plaintext is ever written. */ }
    }
  }
  private resolve(record: CredentialFile): { key: string | null; source: KeyStatus['source'] } {
    if (record.mode === 'disabled') return { key: null, source: 'none' };
    if (record.mode === 'auto' && record.encrypted !== null) {
      if (!this.available()) throw new AppFailure('secure_storage_unavailable');
      let key: string;
      try { key = this.secure.decryptString(Buffer.from(record.encrypted, 'base64')); }
      catch { throw new AppFailure('credential_decrypt_failed'); }
      if (!validApiKey(key)) throw new AppFailure('credential_decrypt_failed');
      return { key, source: 'secure' };
    }
    const key = loadKey(this.envFile);
    if (key !== null && !validApiKey(key)) throw new AppFailure('invalid_key_file');
    return { key, source: key ? 'env' : 'none' };
  }
  private apply(record: CredentialFile, resolved: ReturnType<Credentials['resolve']>) {
    this.key = resolved.key;
    this.status = { mode: record.mode, source: resolved.source, saved: record.encrypted !== null, secureAvailable: this.available(), problem: null };
  }
  refresh(): boolean {
    this.key = null;
    this.status = { mode: 'auto', source: 'none', saved: false, secureAvailable: false, problem: null };
    // Preview and development never even probe the OS secret store or home file.
    if (this.context !== 'personal') {
      this.key = this.context === 'simulation' ? 'offline-test-key' : null;
      this.status.source = this.key ? 'test' : 'none';
      return !!this.key;
    }
    this.status.secureAvailable = this.available();
    try {
      const record = this.read();
      this.status.mode = record.mode; this.status.saved = record.encrypted !== null;
      this.apply(record, this.resolve(record));
    } catch (error) { this.status.problem = failureCode(error); }
    return !!this.key;
  }
  manage(change: KeyAction): void {
    if (this.context !== 'personal') throw new AppFailure('credential_management_disabled');
    let record: CredentialFile, resolved: ReturnType<Credentials['resolve']>;
    if (change.action === 'save' || change.action === 'import') {
      const key = change.action === 'save' ? change.key.trim() : loadKey(this.envFile);
      if (!validApiKey(key)) throw new AppFailure(change.action === 'import' ? 'invalid_key_file' : 'invalid_api_key');
      if (!this.available()) throw new AppFailure('secure_storage_unavailable');
      let bytes: Buffer;
      try {
        bytes = this.secure.encryptString(key);
        if (!bytes.length || this.secure.decryptString(bytes) !== key) throw new Error('mismatch');
      } catch { throw new AppFailure('credential_encrypt_failed'); }
      record = { version: 1, mode: 'auto', encrypted: bytes.toString('base64') };
      resolved = { key, source: 'secure' };
    } else if (change.action === 'delete') {
      // Keep a disabled tombstone so an old .env key cannot silently reactivate.
      record = { version: 1, mode: 'disabled', encrypted: null };
      resolved = { key: null, source: 'none' };
    } else {
      record = { ...this.read(), mode: change.mode };
      resolved = this.resolve(record);
    }
    this.write(record);
    this.apply(record, resolved);
  }
}
