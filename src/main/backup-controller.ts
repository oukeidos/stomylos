import { Worker } from 'node:worker_threads';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dialog } from 'electron';
import type { Coordinator } from './coordinator';
import type { PreparedBackup } from './backup';
import type { BackupResult } from '../shared/backup';
import { AppFailure } from './errors';

export function backupJob<T>(action: string, directory: string, file?: string, version?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'backup-worker.js'), { workerData: { action, directory, file, version } });
    let received = false;
    worker.once('message', result => { received = true; result.error ? reject(new AppFailure(result.error)) : resolve(result.value); });
    worker.once('error', () => reject(new AppFailure('backup_worker_failed')));
    worker.once('exit', () => { if (!received) reject(new AppFailure('backup_worker_failed')); });
  });
}
export class BackupController {
  private busy = false;
  constructor(private directory: string, private version: string, private restart: () => void) {}
  async run(action: 'backupExport' | 'backupRestore', coordinator: Coordinator | null): Promise<BackupResult> {
    if (this.busy) throw new AppFailure('backup_busy');
    this.busy = true;
    let prepared: PreparedBackup | undefined, closed = false;
    try {
      if (action === 'backupExport') {
        const choice = await dialog.showSaveDialog({ title: 'Export backup', buttonLabel: 'Export backup',
          defaultPath: `stomylos-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.stomylos-backup`,
          filters: [{ name: 'Stomylos backup', extensions: ['stomylos-backup'] }] });
        if (choice.canceled || !choice.filePath) return {};
        if (!coordinator) throw new AppFailure('backup_unavailable');
        return await coordinator.withBackup(() => backupJob<BackupResult>('export', this.directory, choice.filePath, this.version));
      }
      const choice = await dialog.showOpenDialog({ title: 'Restore backup', buttonLabel: 'Choose backup', properties: ['openFile'],
        filters: [{ name: 'Stomylos backup', extensions: ['stomylos-backup'] }] });
      if (choice.canceled || !choice.filePaths[0]) return {};
      prepared = await backupJob<PreparedBackup>('prepare', this.directory, choice.filePaths[0]);
      const summary = prepared.summary;
      const answer = await dialog.showMessageBox({ type: 'warning', title: 'Restore backup?',
        message: 'Replace this computer’s history with this backup?',
        detail: `Created: ${new Date(summary.createdAt).toLocaleString()}\nStomylos ${summary.appVersion} · ${summary.conversations} conversations\n\nCurrent conversations, drafts, memory, reports and voice data will be replaced, not merged. A verified copy of the current files will be kept in a restore-recovery folder inside the data folder. Your API key stays unchanged. Stomylos will restart.`,
        buttons: ['Cancel', 'Restore and restart'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1) return {};
      const install = async () => {
        if (coordinator && !await coordinator.closeForRestore()) throw new AppFailure('save_required');
        closed = true;
        const recovery = await backupJob<string>('install', this.directory, prepared!.directory);
        await dialog.showMessageBox({ type: 'info', title: 'Backup restored', message: 'Your backup has been restored.',
          detail: `The previous data is preserved at:\n${recovery}\n\nStomylos will now restart.`, buttons: ['Restart'] });
        return { restored: true };
      };
      return coordinator ? await coordinator.withBackup(install) : await install();
    } catch (error) {
      if (closed) await dialog.showMessageBox({ type: 'error', title: 'Restore could not finish',
        message: 'The restore could not finish. Stomylos will restart to check recovery.',
        detail: 'Previous data copies have been retained. Check free space and folder permissions if startup cannot complete.', buttons: ['Restart'] });
      throw error;
    } finally {
      if (prepared) await rm(prepared.directory, { recursive: true, force: true }).catch(() => undefined);
      this.busy = false;
      // Once the DB is closed, always reopen through startup validation/recovery.
      if (closed) this.restart();
    }
  }
}
