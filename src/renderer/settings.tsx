import { MemoryManager, type MemoryManagerHandle } from './memory-manager';
import { UsageSettings } from './usage';
import { forwardRef, useImperativeHandle, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Settings } from '../shared/types';
import { SpeechSettings } from './speech';
import { IconButton } from './icon-button';
import { CredentialSettings } from './credentials';
import { BackupSettings } from './backup';

const tabs = [{ id: 'voice', label: 'Voice' }, { id: 'memory', label: 'Memory' }, { id: 'usage', label: 'Usage & budget' }, { id: 'data', label: 'Connection & data' }] as const;
export type SettingsTab = typeof tabs[number]['id'];

export interface SettingsHandle { beforeLeave(): Promise<boolean> }
export const SettingsDialog = forwardRef<SettingsHandle, {
  open: boolean; onOpenChange(open: boolean): void; tab: SettingsTab; onTabChange(tab: SettingsTab): void;
  settings: Settings; beforeBackup(): Promise<void>; returnFocus(): void; errorText(error: unknown): string; openChat(id: string): void;
}>(function SettingsDialog({ open, onOpenChange, tab, onTabChange, settings, returnFocus, errorText, beforeBackup, openChat }, ref) {
  const memory = useRef<MemoryManagerHandle>(null);
  const leave = async () => !backupBusy && (await memory.current?.beforeLeave() ?? true);
  useImperativeHandle(ref, () => ({beforeLeave:leave}));
  const changeTab = async (next: SettingsTab) => { if (next === tab) return true; if (!await leave()) return false; onTabChange(next); return true; };
  const [backupBusy, setBackupBusy] = useState(false);
  const id = useId(); const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return <Dialog.Root open={open} onOpenChange={value => { if (value) onOpenChange(true); else void leave().then(ok => { if (ok) onOpenChange(false); }); }}><Dialog.Portal><Dialog.Overlay className="modal-overlay" />
    <Dialog.Content className="dialog settings-dialog" aria-describedby={undefined}
      onOpenAutoFocus={event => { event.preventDefault(); buttons.current[tabs.findIndex(item => item.id === tab)]?.focus(); }}
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <div className="dialog-heading"><Dialog.Title>Settings</Dialog.Title><Dialog.Close asChild><IconButton label="Close settings" icon="close" /></Dialog.Close></div>
      <div className="settings-layout">
        <div className="settings-tabs" role="tablist" aria-label="Settings categories" aria-orientation="vertical">
          {tabs.map((item, index) => <button key={item.id} ref={node => { buttons.current[index] = node; }} role="tab" id={`${id}-${item.id}-tab`}
            aria-selected={tab === item.id} aria-controls={`${id}-${item.id}-panel`} tabIndex={tab === item.id ? 0 : -1}
            disabled={backupBusy} onClick={() => void changeTab(item.id)} onKeyDown={event => {
              if (event.isPropagationStopped() || event.nativeEvent.isComposing) return;
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowDown' ? (index + 1) % tabs.length : event.key === 'ArrowUp' ? (index + tabs.length - 1) % tabs.length : -1;
              if (next < 0) return; event.preventDefault(); void changeTab(tabs[next].id).then(changed => { if (changed) buttons.current[next]?.focus(); });
            }}>{item.label}</button>)}
        </div>
        {tabs.map(item => <section key={item.id} className="settings-panel" role="tabpanel" id={`${id}-${item.id}-panel`} aria-labelledby={`${id}-${item.id}-tab`} tabIndex={0} hidden={tab !== item.id} inert={tab !== item.id}>
          {item.id !== 'memory' && <h3 className="settings-title">{item.label}</h3>}
          {item.id === 'voice' && <SpeechSettings active={open && tab === 'voice'} />}
          {item.id === 'usage' && <UsageSettings active={open && tab === 'usage'} />}
          {item.id === 'memory' && <MemoryManager ref={memory} active={open && tab === 'memory'} errorText={errorText} openChat={id => { onOpenChange(false); openChat(id); }} />}
          {item.id === 'data' && <>
            <CredentialSettings active={open && tab === 'data'} settings={settings} errorText={errorText} />
            <section className="setting"><strong>History on this computer</strong><p className="note">Model requests go through OpenRouter to external providers. Provider retention policies apply.</p><details className="settings-details"><summary>Storage details</summary><code>{settings.dataPath}</code></details></section>
            <BackupSettings beforeBackup={beforeBackup} busy={backupBusy} onBusy={setBackupBusy} />
            <SpeechSettings section="data" />
          </>}
        </section>)}
      </div>
      <div className="settings-version"><small>Stomylos {settings.appVersion}{settings.development ? ' · Development build' : ''}</small></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
});
