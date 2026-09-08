import { UsageSettings } from './usage';
import { useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Settings } from '../shared/types';
import { memoryCategories, type MemoryDocument } from '../shared/memory';
import { SpeechSettings } from './speech';
import { IconButton } from './icon-button';
import { CredentialSettings } from './credentials';
import { BackupSettings } from './backup';

const tabs = [{ id: 'voice', label: 'Voice' }, { id: 'memory', label: 'Memory' }, { id: 'usage', label: 'Usage & budget' }, { id: 'data', label: 'Connection & data' }] as const;
export type SettingsTab = typeof tabs[number]['id'];

function CurrentMemory({ active }: { active: boolean }) {
  const [document, setDocument] = useState<MemoryDocument | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active) return;
    let generation = 0, alive = true;
    const refresh = () => {
      const request = ++generation; setState('loading');
      void window.stomylos.command('currentMemory', undefined).then(value => {
        if (alive && request === generation) { setDocument(value); setState('ready'); }
      }, () => { if (alive && request === generation) setState('failed'); });
    };
    const off = window.stomylos.subscribe(event => { if (event.type === 'memory-changed') refresh(); });
    refresh(); return () => { alive = false; off(); };
  }, [active, retry]);
  return <>
    <p className="note">Shared by all partners for future chats. Past chats keep the memory they used.</p>
    {state === 'loading' && <p className="note" role="status">Loading memory…</p>}
    {state === 'failed' && <div role="alert"><p>Memory could not be loaded.</p><button onClick={() => setRetry(value => value + 1)}>Retry loading memory</button></div>}
    {state === 'ready' && document && <div className="current-memory">
      {memoryCategories.map(category => <section key={category}><h3>{category[0].toUpperCase() + category.slice(1)}</h3>
        {document[category].length ? <ul>{document[category].map(item => <li key={item.id}>{item.text}</li>)}</ul> : <p className="note">Nothing recorded.</p>}
      </section>)}
      <p className="note">Memories can contain mistakes. Ask a partner to correct or forget a detail in a conversation.</p>
    </div>}
  </>;
}

export function SettingsDialog({ open, onOpenChange, tab, onTabChange, settings, returnFocus, errorText, beforeBackup }: {
  open: boolean; onOpenChange(open: boolean): void; tab: SettingsTab; onTabChange(tab: SettingsTab): void;
  settings: Settings; beforeBackup(): Promise<void>; returnFocus(): void; errorText(error: unknown): string;
}) {
  const [backupBusy, setBackupBusy] = useState(false);
  const id = useId(); const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return <Dialog.Root open={open} onOpenChange={value => { if (!backupBusy) onOpenChange(value); }}><Dialog.Portal><Dialog.Overlay className="modal-overlay" />
    <Dialog.Content className="dialog settings-dialog" aria-describedby={undefined}
      onOpenAutoFocus={event => { event.preventDefault(); buttons.current[tabs.findIndex(item => item.id === tab)]?.focus(); }}
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <div className="dialog-heading"><Dialog.Title>Settings</Dialog.Title><Dialog.Close asChild><IconButton label="Close settings" icon="close" /></Dialog.Close></div>
      <div className="settings-layout">
        <div className="settings-tabs" role="tablist" aria-label="Settings categories" aria-orientation="vertical">
          {tabs.map((item, index) => <button key={item.id} ref={node => { buttons.current[index] = node; }} role="tab" id={`${id}-${item.id}-tab`}
            aria-selected={tab === item.id} aria-controls={`${id}-${item.id}-panel`} tabIndex={tab === item.id ? 0 : -1}
            disabled={backupBusy} onClick={() => onTabChange(item.id)} onKeyDown={event => {
              if (event.isPropagationStopped() || event.nativeEvent.isComposing) return;
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowDown' ? (index + 1) % tabs.length : event.key === 'ArrowUp' ? (index + tabs.length - 1) % tabs.length : -1;
              if (next < 0) return; event.preventDefault(); onTabChange(tabs[next].id); buttons.current[next]?.focus();
            }}>{item.label}</button>)}
        </div>
        {tabs.map(item => <section key={item.id} className="settings-panel" role="tabpanel" id={`${id}-${item.id}-panel`} aria-labelledby={`${id}-${item.id}-tab`} tabIndex={0} hidden={tab !== item.id} inert={tab !== item.id}>
          <h3 className="settings-title">{item.label}</h3>
          {item.id === 'voice' && <SpeechSettings active={open && tab === 'voice'} />}
          {item.id === 'usage' && <UsageSettings active={open && tab === 'usage'} />}
          {item.id === 'memory' && <CurrentMemory active={open && tab === 'memory'} />}
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
}
