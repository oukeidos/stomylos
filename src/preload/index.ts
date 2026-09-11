import { explainCommands } from '../shared/explain';
import { patternCommands } from '../shared/pattern-report';
import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, DesktopApi } from '../shared/types';
import { genieCommands } from '../shared/genie';
const allowed = new Set<string>([...explainCommands, ...patternCommands, ...genieCommands, 'exitOptions', 'exitPrepared', 'exitCopyText', 'usageSnapshot', 'usageBudget', 'setSessionBookmark', 'deleteSession', 'retryDeletionCleanup', 'asrSnapshot', 'asrContext', 'asrBegin', 'asrChunk', 'asrFinish', 'asrTranscribe', 'asrCancel', 'asrRetrySave', 'asrInserted', 'speechVoice', 'speechPreview', 'speechPreviewStop', 'speechRecover', 'speechSnapshot', 'speechMode', 'speechContext', 'speechListen', 'speechRetrySave', 'speechStop', 'speechClear', 'retryMemoryAdd', 'skipMemoryAdd', 'setMemoryPreference', 'memoryManagement', 'editMemory', 'currentMemory', 'snapshot', 'listSessions', 'loadSession', 'saveDraft', 'replaceStarter', 'setOpening', 'selectPartner', 'changePartner', 'useSelectedPartner', 'retryPartnerSelection', 'sendMessage',
  'searchMode', 'retryReply', 'endSession', 'newSession', 'retryAnalysis', 'retryStarterRenewal', 'continueEnd', 'cancelEnd', 'retryMemory', 'skipMemory', 'retrySaving', 'backupExport', 'backupRestore', 'refreshKey', 'manageKey', 'close']);
const api: DesktopApi = {
  async command(name, args) {
    if (!allowed.has(name)) throw new Error('invalid_command');
    const result = await ipcRenderer.invoke('stomylos:command', name, args);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  subscribe(listener) {
    const callback = (_event: Electron.IpcRendererEvent, value: AppEvent) => listener(value);
    ipcRenderer.on('stomylos:event', callback);
    return () => ipcRenderer.removeListener('stomylos:event', callback);
  }
};
contextBridge.exposeInMainWorld('stomylos', api);
