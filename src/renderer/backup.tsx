import { useState } from 'react';

const errors: Record<string, string> = {
  backup_busy: 'Finish generation, recording and saving, and close Genie before trying again.',
  backup_invalid: 'This is not a supported Stomylos backup.',
  backup_database_invalid: 'The backup database failed its integrity checks. Your current data has not been replaced.',
  backup_checksum_mismatch: 'The backup is damaged or incomplete. Choose another backup.',
  backup_source_changed: 'The files changed during verification. Please try again.',
  backup_destination_invalid: 'Save the backup outside the live Stomylos data folder.',
  backup_destination_exists: 'A file already exists at that location. Choose a new filename.',
  backup_database_busy: 'The database is not ready for backup. Close and reopen Stomylos, then try again.',
  backup_disk_full: 'There is not enough free space. Free space for the backup and temporary verification copies, then retry.',
  backup_permission: 'The files could not be accessed. Check the selected folder’s permissions.',
  backup_too_large: 'This backup exceeds the supported size (2 GiB of data) or file-count limit.',
  external_migration_required: 'This backup needs the matching external database conversion before it can be restored.',
  unsupported_schema_version: 'This backup needs an application with a compatible database version.',
  unsupported_schema_structure: 'This backup has an incompatible database structure.',
  backup_recovery_required: 'A previous restore needs recovery. Close and reopen Stomylos before retrying.',
  save_required: 'Save your latest changes before continuing.',
};
export function BackupSettings({ beforeBackup, busy, onBusy }: { beforeBackup(): Promise<void>; busy: boolean; onBusy(value: boolean): void }) {
  const [status, setStatus] = useState(''), [error, setError] = useState(''), [path, setPath] = useState('');
  async function run(name: 'backupExport' | 'backupRestore') {
    if (busy) return;
    onBusy(true); setError(''); setPath(''); setStatus(name === 'backupExport' ? 'Preparing backup…' : 'Checking backup…');
    let stopWatching = () => {};
    try {
      const saveFailed = new Promise<never>((_, reject) => {
        stopWatching = window.stomylos.subscribe(event => {
          if (event.type === 'snapshot' && event.snapshot.activity.storageError) reject(new Error('save_required'));
        });
      });
      await Promise.race([beforeBackup(), saveFailed]);
      stopWatching();
      const result = await window.stomylos.command(name, undefined);
      setStatus(result.restored ? 'Backup restored. Restarting…' : result.path ? 'Backup saved and verified.' : 'Cancelled.');
      setPath(result.path ?? '');
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      setStatus(''); setError(errors[code] ?? 'The backup operation could not finish. Check the file, free space and permissions. If the app restarts, it will check for interrupted restore work.');
    } finally { stopWatching(); onBusy(false); }
  }
  return <section className="setting" aria-busy={busy}>
    <strong>Backup and restore</strong>
    <p className="note">Save conversations, drafts, memory, reports and saved voice data in one file. Backups contain private content and are not encrypted. API keys, device cost records and monthly budgets are excluded.</p>
    <div className="settings-row backup-actions"><button disabled={busy} onClick={() => void run('backupExport')}>Export backup</button><button disabled={busy} onClick={() => void run('backupRestore')}>Restore backup</button></div>
    <p className="note">Restoring replaces this computer’s history and restarts Stomylos. Cost records and the monthly budget stay on this computer. A copy of the previous data is kept for recovery.</p>
    {status && <p role="status" className="note">{status}</p>}
    {path && <code style={{ overflowWrap: 'anywhere' }}>{path}</code>}
    {error && <p role="alert" className="speech-error">{error}</p>}
  </section>;
}
