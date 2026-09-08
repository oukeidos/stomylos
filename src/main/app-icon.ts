import { app } from 'electron';
import { join } from 'node:path';

export function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, '../icon.png')
    : join(app.getAppPath(), 'assets/icon.png');
}
