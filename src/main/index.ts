import { MemoryEmbeddingController } from './memory-embedding-controller';
import { showExitDialog } from './exit-dialog';
import { ExitController } from './exit-controller';
import { UsageStore } from './usage-store';
import { PatternReportViewer } from './pattern-report-viewer';
import { verifyPatternRuntime } from './pattern-report';
import { SpeechController, SpeechTransport } from './tts';
import { SpeechStore } from './speech-store';
import { DictationController } from './asr';
import { DictationStore } from './asr-store';
import { AsrTransport } from './asr-transport';
import { CaptureWorker } from './asr-worker-client';
import { app, BrowserWindow, dialog, ipcMain, protocol, session, powerMonitor, shell, safeStorage, clipboard } from 'electron';
import { markdownWebUrl } from '../shared/markdown-link';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { DatabaseClient } from './db-client';
import { Coordinator } from './coordinator';
import { OpenRouter } from './transport';
import { appVersion, verifyRuntime } from './contracts';
import { appIconPath } from './app-icon';
import { dataDirectory, keyFilePath, lockDirectory } from './storage';
import { BackupController, backupJob } from './backup-controller';
import { Credentials } from './credentials';
import { launchData } from './launch-policy';
import { failureCode, AppFailure } from './errors';
import { validateCommand } from './ipc';
import type { AppEvent } from '../shared/types';
import { verifyStarterRuntime } from './starter-renewal';

protocol.registerSchemesAsPrivileged([{ scheme: 'stomylos-report', privileges: { standard: true, secure: true } }, { scheme: 'stomylos', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.enableSandbox();
let window: BrowserWindow | null = null; let coordinator: Coordinator | null = null; let allowExit = false;
const override = process.env.STOMYLOS_DATA_DIR;
const normalDirectory = dataDirectory(process.platform, process.env, process.platform === 'darwin' ? app.getPath('appData') : undefined);
let launch: ReturnType<typeof launchData> | undefined;
try { launch = launchData(app.isPackaged, process.argv, process.env, normalDirectory); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); app.exit(1); }
if (launch) {
  const { directory, normalData } = launch;
  let unlockData: (() => void) | undefined;
  let startupDatabase: DatabaseClient | undefined;
  let exitingAdmission = false;
  const restart = () => { if (exitingAdmission) return; allowExit = true; app.relaunch(); setTimeout(() => app.quit(), 100); };
  const backups = new BackupController(directory, appVersion, restart);
  app.on('will-quit', () => unlockData?.());
  app.setPath('userData', join(directory, 'chromium'));
  app.setPath('sessionData', join(directory, 'chromium'));
  void app.whenReady().then(async () => {
    if (process.env.STOMYLOS_LIVE_VERIFY === '1') throw new AppFailure('legacy_verification_disabled');
    verifyRuntime(); verifyStarterRuntime(); verifyPatternRuntime();
    const renderer = resolve(__dirname, '../renderer');
    protocol.handle('stomylos', async request => {
      const url = new URL(request.url);
      if (url.hostname !== 'app' || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 });
      if (url.pathname.startsWith('/speech/') || url.pathname.startsWith('/dictation/')) {
        try {
          const dictation = url.pathname.startsWith('/dictation/');
          const bytes = dictation ? coordinator!.dictation!.audio(url.pathname.slice('/dictation/'.length)) : await coordinator!.speech!.audio(url.pathname.slice('/speech/'.length));
          const headers: Record<string, string> = { 'Content-Type': dictation ? 'audio/flac' : 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
          const range = request.headers.get('range');
          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } });
            const start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
            const end = match[1] && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } });
            headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`; headers['Content-Length'] = String(end-start+1);
            return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes.subarray(start, end+1)), { status: 206, headers });
          }
          headers['Content-Length'] = String(bytes.length);
          return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers });
        } catch { return new Response(null, { status: 404 }); }
      }
      let file: string;
      try { file = resolve(renderer, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)); }
      catch { return new Response(null, { status: 400 }); }
      if (!file.startsWith(renderer + sep)) return new Response(null, { status: 403 });
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      if (!types[extname(file)]) return new Response(null, { status: 404 });
      try { return new Response(await readFile(file), { headers: { 'Content-Type': types[extname(file)],
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; media-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'" } }); }
      catch { return new Response(null, { status: 404 }); }
    });
    const ownedAppFrame = (contents: Electron.WebContents | null, main: boolean, url?: string) => {
      if (!window || contents !== window.webContents || !main) return false;
      try { const requested = new URL(url ?? ''); return requested.protocol === 'stomylos:' && requested.host === 'app' && window.webContents.mainFrame.url.startsWith('stomylos://app/'); }
      catch { return false; }
    };
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const media = details as Electron.MediaAccessPermissionRequest;
      const owned = ownedAppFrame(contents, details.isMainFrame, details.requestingUrl);
      callback(owned && (permission === 'clipboard-sanitized-write' ||
        permission === 'media' && !!coordinator?.dictation?.permissionAllowed &&
        media.mediaTypes?.length === 1 && media.mediaTypes[0] === 'audio'));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) =>
      ownedAppFrame(contents, details.isMainFrame, details.requestingUrl ?? origin) &&
      (permission === 'clipboard-sanitized-write' ||
        permission === 'media' && !!coordinator?.dictation?.permissionAllowed &&
        (details.mediaType === 'audio' || details.mediaType === 'unknown')));

    unlockData = lockDirectory(directory, join(app.getAppPath(), 'native/advisory-lock.node'));
    await backupJob('recover', directory);
    const endpoint = process.env.STOMYLOS_TEST_ENDPOINT;
    if (endpoint) { const url = new URL(endpoint); if ((app.isPackaged && !(process.env.STOMYLOS_PACKAGED_TEST === '1' && override && !normalData)) || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new AppFailure('invalid_test_endpoint'); }
    const keyPath = keyFilePath(process.platform, process.env);
    const credentials = new Credentials(join(directory, 'api-credentials.json'), keyPath, process.platform, safeStorage,
      endpoint ? 'simulation' : normalData ? 'personal' : 'development');
    const emit = (event: AppEvent) => { if (window && !window.isDestroyed()) window.webContents.send('stomylos:event', event); };
    const db = new DatabaseClient(join(__dirname, 'db-worker.js'), directory, join(app.getAppPath(), 'native/advisory-lock.node'), () => {
      coordinator?.databaseFailed();
    }, true);
    startupDatabase = db;
    await db.ready; // Acquire the application's data lock before accessing credentials.
    const usage = new UsageStore(directory, () => emit({ type: 'usage-changed' }));
    app.on('will-quit', () => usage.close());
    const keyPresent = credentials.refresh();
    const providerKey = () => { if (exitingAdmission) throw new AppFailure('closing'); return credentials.currentKey(); };
    coordinator = new Coordinator(db, new OpenRouter(providerKey, endpoint, usage), {
      keyPresent, credentials: credentials.snapshot(), keyPath, dataPath: directory, appVersion, development: !normalData, simulation: !!endpoint
    }, emit, () => credentials.refresh(), credentials);
    coordinator.patternViewer = new PatternReportViewer();
    coordinator.cold = new MemoryEmbeddingController(db, join(__dirname, 'memory-embedding-worker.js'),
      app.isPackaged ? join(process.resourcesPath, 'memory-model') : join(__dirname, '../../assets/memory-model'),
      () => coordinator!.memoryIndexChanged());
    await coordinator.initialize();
    coordinator.speech = new SpeechController(new SpeechStore(directory),
      new SpeechTransport(providerKey, endpoint ? new URL('/audio/speech', endpoint).href : undefined, undefined, undefined, undefined, usage),
      async (sessionId, messageId) => {
        const messages = await db.call('messages', sessionId);
        const message = messages.find(m => m.id === messageId);
        if (!message) throw new AppFailure('speech_source_missing');
        return message;
      }, emit);
    await coordinator.speech.initialize();
    coordinator.dictation = new DictationController(new DictationStore(directory),
      new AsrTransport(providerKey, endpoint ? new URL('/audio/transcriptions', endpoint).href : undefined, undefined, undefined, usage),
      () => CaptureWorker.create(join(__dirname, 'asr-worker.js')),
      snapshot => emit({ type: 'dictation', snapshot }), locked => coordinator!.speech!.captureLock(locked));
    await coordinator.dictation.initialize();
    await coordinator.cleanupDeletions();
    window = new BrowserWindow({ width: 1180, height: 860, minWidth: 760, minHeight: 620,
      icon: appIconPath(),
      title: normalData ? 'Stomylos' : 'Stomylos — Development', backgroundColor: '#f8f7f3', show: false,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true,
        nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', webSecurity: true, spellcheck: false } });
    const interruptCapture = () => { if (coordinator?.dictation?.capturing) emit({ type: 'dictation-interrupt' }); };
    window.on('minimize', interruptCapture); window.on('hide', interruptCapture);
    powerMonitor.on('suspend', interruptCapture);
    window.webContents.on('render-process-gone', () => {
      const asr = coordinator?.dictation, id = asr?.snapshot().activeId;
      if (asr?.capturing && id) void asr.finish(id, 'interrupted').catch(() => undefined);
    });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(({ url }) => {
      const external = markdownWebUrl(url);
      if (external) void shell.openExternal(external).catch(() => {
        dialog.showErrorBox('Could not open link', 'The default browser could not open this link. You can copy its address and open it in your browser.');
      });
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    let copySequence = 0;
    let copyPending: { id: number; resolve(text: string): void } | undefined;
    const exits = new ExitController({
      prepare: (id, retry) => emit({ type: 'close-requested', revision: id, retry }),
      cancel: () => { emit({ type: 'close-cancelled' }); coordinator!.cancelExitPreparation(); },
      finishPreparation: current => coordinator!.prepareExit(current),
      failed: () => coordinator!.exitFailed(),
      choose: copy => showExitDialog(window!, copy),
      copy: async () => {
        const id = ++copySequence;
        let timer: ReturnType<typeof setTimeout>;
        try {
          const text = await new Promise<string>((resolve, reject) => {
            copyPending = { id, resolve };
            timer = setTimeout(() => reject(new Error('renderer_unavailable')), 1500);
            emit({ type: 'exit-copy-requested', id });
          });
          if (!text) return 'No text available';
          await clipboard.writeText(text);
          if (await clipboard.readText() !== text) throw new Error('clipboard_failed');
          return text.includes('[Copy truncated:') ? 'Copied (partial)' : 'Copied';
        } finally { clearTimeout(timer!); copyPending = undefined; }
      },
      teardown: () => { exitingAdmission = true; return coordinator!.emergencyTeardown(); },
      // Immediate exit retains the OS-owned data lock until process death and cannot
      // re-enter before-quit or wait for a stuck worker/renderer.
      exit: () => { allowExit = true; app.exit(0); }
    });
    ipcMain.handle('stomylos:command', async (event, name: unknown, args: unknown) => {
      try {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new AppFailure('invalid_sender');
        validateCommand(name, args);
        if (exits.exiting) throw new AppFailure('closing');
        if (name === 'exitOptions' || name === 'close') { exits.request(true); return { ok: true, value: name === 'close' ? false : undefined }; }
        if (name === 'exitPrepared') {
          const value = args as { id: number; outcome: 'ready' | 'cancelled' | 'blocked' };
          void exits.prepared(value.id, value.outcome); return { ok: true };
        }
        if (name === 'exitCopyText') {
          const value = args as { id: number; text: string };
          if (copyPending?.id === value.id) copyPending.resolve(value.text);
          return { ok: true };
        }
        const value = name === 'usageSnapshot' ? usage.snapshot() : name === 'usageBudget' ? usage.setBudget((args as { amount: string | null }).amount) : name === 'backupExport' || name === 'backupRestore' ? await backups.run(name, coordinator) : await coordinator!.command(name, args as never);
        return { ok: true, value };
      } catch (error) { return { ok: false, error: failureCode(error) }; }
    });
    window.on('close', event => { if (!allowExit) { event.preventDefault(); exits.request(); } });
    window.once('ready-to-show', () => window!.show());
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadURL('stomylos://app/');
  }).catch(async error => {
    const code = failureCode(error);
    const explanations: Record<string, string> = {
      memory_recovery_required: 'Saved memory exceeds the supported limit. It has not been truncated or sent to a model. Preserve the database and use a compatible backup or a verified repair before continuing.',
      migration_integrity_failed: 'Database upgrade validation failed. Your database and pre-upgrade recovery backup have been preserved. Do not delete them; retry after resolving storage problems or use a verified repair.',
      migration_backup_invalid: 'The pre-upgrade recovery backup is invalid. The database was not upgraded. Preserve both files and use a verified repair before retrying.',
      database_already_open: 'Another Stomylos window or the legacy app is using this history. Close it, then open Stomylos again.',
      starter_catalog_newer: 'This history has a newer question catalog. It has not been downgraded. Open it with the newer application version.',
      starter_catalog_corrupt: 'The question catalog failed verification. The database has not been silently overwritten. Use a verified backup or a valid application build.',
      unsupported_schema_version: 'This history uses an unsupported database version. It has not been reset. Open it with the matching application version.',
      external_migration_required: 'This history needs the one-time external database update for this release. It has not been changed. Complete that update before opening this version of Stomylos.',
      unsupported_schema_structure: 'This history has an unsupported database structure. It has not been reset.',
    };
    const explanation = explanations[code] ?? `The application could not open its local history (${code}). Check available disk space and folder permissions, then try again.`;
    if (unlockData && code !== 'backup_recovery_required') {
      await startupDatabase?.close().catch(() => undefined);
      coordinator = null;
      const answer = await dialog.showMessageBox({ type: 'error', title: 'Stomylos could not start', message: explanation,
        detail: 'You can restore a compatible backup. Existing files will be preserved before replacement.',
        buttons: ['Quit', 'Restore backup'], defaultId: 0, cancelId: 0 });
      if (answer.response === 1) {
        try { if ((await backups.run('backupRestore', null)).restored) return; }
        catch { dialog.showErrorBox('Restore failed', 'The backup could not be restored. Existing files and any recovery copy have been preserved. Check the backup, free space and folder permissions, then reopen Stomylos.'); }
      }
    } else dialog.showErrorBox('Stomylos could not start', explanation);
    app.exit(1);
  });
}
app.on('before-quit', event => { if (!allowExit && window && !window.isDestroyed()) { event.preventDefault(); window.close(); } });
app.on('window-all-closed', () => { if (allowExit) app.quit(); });
