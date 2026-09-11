import { BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import type { ExitChoice } from './exit-controller';

const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
<title>Exit without saving?</title><style>
body{margin:0;padding:28px;background:#f8f7f3;color:#34464a;font:15px/1.5 system-ui,sans-serif}
h1{font-size:21px;margin:0 0 12px}p{margin:0 0 16px}.copy-row{display:flex;align-items:center;gap:12px;min-height:40px}
button{font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #67978d;outline-offset:3px}
#copy{border:0;background:none;padding:4px 0;color:#386b61;text-decoration:underline}
#status{font-size:13px}footer{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}
footer button{padding:9px 15px;border:1px solid #cbd6d0;border-radius:8px;background:white;color:inherit}
#exit{background:#a94236;color:white;border-color:#a94236}button:disabled{cursor:default;opacity:.65}
</style><h1>Exit without saving?</h1>
<p>Recent changes may be lost. Previously saved history will remain available.</p>
<div class="copy-row"><button id="copy">Copy unsaved text</button><span id="status" role="status" aria-live="polite"></span></div>
<footer><button id="stay" autofocus>Go back</button><button id="exit">Exit without saving</button></footer></html>`;

/** Independent renderer: the original window's blocked UI cannot hide exit controls. */
export async function showExitDialog(parent: BrowserWindow, copy: () => Promise<string>): Promise<ExitChoice> {
  const window = new BrowserWindow({ parent, modal: true, width: 510, height: 310, resizable: false,
    minimizable: false, maximizable: false, show: false, autoHideMenuBar: true,
    backgroundColor: '#f8f7f3', webPreferences: { preload: join(__dirname, '../preload/exit-dialog.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.removeMenu(); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  return new Promise(resolve => {
    let settled = false, copying = false, fallingBack = false;
    let readyTimer: ReturnType<typeof setTimeout>;
    const finish = (choice: ExitChoice) => {
      if (settled) return; settled = true; clearTimeout(readyTimer);
      ipcMain.removeListener('stomylos:exit-dialog', action);
      if (!window.isDestroyed()) window.destroy(); resolve(choice);
    };
    const action = (event: Electron.IpcMainEvent, value: unknown) => {
      if (settled || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
      if (value === 'stay' || value === 'exit') { finish(value); return; }
      if (value !== 'copy' || copying) return;
      copying = true;
      void copy().then(status => {
        if (!settled) window.webContents.send('stomylos:exit-copy-status', status);
      }, () => { if (!settled) window.webContents.send('stomylos:exit-copy-status', 'Copy failed'); })
        .finally(() => { copying = false; });
    };
    ipcMain.on('stomylos:exit-dialog', action);
    window.on('closed', () => { if (!fallingBack) finish('stay'); });
    const fallback = async () => {
      if (settled || fallingBack) return;
      fallingBack = true; clearTimeout(readyTimer);
      if (!window.isDestroyed()) window.hide();
      try {
        const result = await dialog.showMessageBox(parent, { type: 'warning', title: 'Exit without saving?',
          message: 'Exit without saving?', detail: 'Recent changes may be lost. Previously saved history will remain available. Text copying is unavailable.',
          buttons: ['Go back', 'Exit without saving'], defaultId: 0, cancelId: 0 });
        finish(result.response === 1 ? 'exit' : 'stay');
      } catch { finish('stay'); }
    };
    readyTimer = setTimeout(() => { void fallback(); }, 5000);
    window.webContents.on('render-process-gone', () => { void fallback(); });
    window.once('ready-to-show', () => { clearTimeout(readyTimer); if (!settled && !fallingBack) window.show(); });
    void window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => { void fallback(); });
  });
}
