import { parentPort, workerData } from 'node:worker_threads';
import { exportBackup, prepareBackup, installBackup, recoverRestore } from './backup';
import { failureCode } from './errors';
void (async () => {
  const { action, directory, file, version } = workerData;
  if (action === 'export') return exportBackup(directory, file, version);
  if (action === 'prepare') return prepareBackup(directory, file);
  if (action === 'install') return installBackup(directory, file);
  if (action === 'recover') return recoverRestore(directory);
  throw new Error('Invalid backup operation');
})().then(value => parentPort!.postMessage({ value }), error => {
  const io: Record<string, string> = { ENOSPC: 'backup_disk_full', EACCES: 'backup_permission', EPERM: 'backup_permission', EEXIST: 'backup_destination_exists' };
  parentPort!.postMessage({ error: io[error?.code] ?? failureCode(error) });
}).finally(() => parentPort!.close());
