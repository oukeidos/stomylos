import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { validatePatternHtml } from './pattern-report';
import { appIconPath } from './app-icon';

export const reportCsp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'";
export class PatternReportViewer {
  private current: { id: string; window: BrowserWindow; revoke: () => void } | null = null;
  async open(id: string, html: string, createdAt: string) {
    validatePatternHtml(html); this.close();
    const token = randomUUID(), viewerSession = session.fromPartition('pattern-' + token, { cache: false });
    const url = `stomylos-report://document/${token}`;
    let accepted = false, active = true;
    viewerSession.protocol.handle('stomylos-report', request => {
      if (!active || request.url !== url || request.method !== 'GET') return new Response(null, { status: 403 });
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': reportCsp,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    });
    viewerSession.webRequest.onBeforeRequest((details, callback) => {
      const allow = active && !accepted && details.resourceType === 'mainFrame' && details.url === url;
      if (allow) accepted = true;
      callback({ cancel: !allow });
    });
    viewerSession.setPermissionCheckHandler(() => false);
    viewerSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    viewerSession.on('will-download', event => event.preventDefault());
    const title = 'Learning report · ' + new Date(createdAt).toLocaleDateString();
    const win = new BrowserWindow({ width: 1180, height: 860, minWidth: 760, minHeight: 620, show: false,
      title, icon: appIconPath(), backgroundColor: '#f8f7f3', webPreferences: { session: viewerSession, sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true, webviewTag: false, spellcheck: false, navigateOnDragDrop: false, disableDialogs: true } });
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-frame-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.webContents.on('will-prevent-unload', event => event.preventDefault());
    win.on('page-title-updated', event => event.preventDefault());
    const revoke = () => { if (!active) return; active = false; viewerSession.protocol.unhandle('stomylos-report'); void viewerSession.clearStorageData(); };
    this.current = { id, window: win, revoke };
    win.once('closed', () => { revoke(); if (this.current?.window === win) this.current = null; });
    win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.destroy(); });
    // A hung report cannot make the native close button wait for beforeunload.
    win.on('close', event => { event.preventDefault(); win.destroy(); });
    // Do not hold the trusted command queue waiting for arbitrary report scripts.
    win.show();
    void win.loadURL(url).then(() => { if (!win.isDestroyed()) win.setTitle(title); }).catch(() => { if (!win.isDestroyed()) win.destroy(); });
  }
  close(id?: string) {
    const current = this.current;
    if (!current || (id && id !== current.id)) return;
    current.revoke(); if (!current.window.isDestroyed()) current.window.destroy();
    this.current = null;
  }
}
