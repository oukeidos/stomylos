import { MemoryInputRecovery } from './memory-input-recovery';
import type { Json } from '../shared/types';
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { SessionView } from '../shared/types';
import { loadView, onViewChanged } from './client';
import { Icon } from './icons';
import { endProcessingState } from './end-processing-state';

/** Follows the global blocker, including unfinished work restored on startup. */
export function EndProcessingDialog({ sessionId, storageError, errorText, automaticMemory = false }: {
  sessionId: string; storageError: string | null; errorText(error: unknown): string; automaticMemory?: boolean;
}) {
  const [view, setView] = useState<SessionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const reload = useRef(() => {});
  useEffect(() => {
    let alive = true;
    const refresh = () => { void loadView(sessionId).then(next => {
      if (alive) { setView(next); setLoadError(null); }
    }).catch(error => { if (alive) setLoadError(errorText(error)); }); };
    reload.current = refresh;
    refresh();
    const unsubscribe = onViewChanged(id => { if (id === sessionId) refresh(); });
    return () => { alive = false; unsubscribe(); };
  }, [sessionId, errorText]);
  const { rows, failed, retryable } = endProcessingState(view, automaticMemory);
  const act = async (command: 'continueEnd' | 'cancelEnd' | 'retrySaving' | 'retryMemoryAdd' | 'skipMemoryAdd', job?: Json) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setActionError(null);
    try {
      if (command === 'retrySaving') await window.stomylos.command(command, undefined);
      else if(command==='retryMemoryAdd'||command==='skipMemoryAdd') {
        if(!job)throw new Error('Memory input missing');
        await window.stomylos.command(command,{sessionId:job.session_id,jobId:job.ordinal});
      } else await window.stomylos.command(command, { sessionId });
      reload.current();
    } catch (error) { setActionError(errorText(error)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <Dialog.Root open><Dialog.Portal>
    <Dialog.Overlay className="modal-overlay end-processing-overlay" />
    <Dialog.Content className="dialog end-processing-dialog" onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus(); }} onEscapeKeyDown={event => event.preventDefault()}
      onInteractOutside={event => event.preventDefault()} onCloseAutoFocus={event => {
        event.preventDefault(); requestAnimationFrame(() => document.querySelector<HTMLElement>('main[aria-label="Conversation"]')?.focus({ preventScroll: true }));
      }}>
      <div className="end-processing-header">
      <div className="end-processing-symbol" aria-hidden="true">{failed || loadError || storageError ? <Icon name="info" /> : <span className="end-spinner" />}</div>
      <Dialog.Title ref={heading} tabIndex={-1}>Finishing your chat</Dialog.Title>
      <Dialog.Description>Your chat is saved.</Dialog.Description>
      </div>
      <div className="end-processing-body" role="region" aria-label="Memory processing details" tabIndex={0}>
      {!view ? <div className="end-processing-loading" role="status">Checking processing status…</div> :
      <ul className="end-processing-stages" aria-label="Processing stages" aria-live="polite">
        {rows.map(({id: stage, label, state}) => {
          const status = ({ completed: 'Done', skipped: 'Not needed', running: 'Working', pending: 'Waiting', failed: 'Needs attention', interrupted: 'Interrupted' } as Record<string, string>)[state] ?? state;
          return <li key={stage} className={state === 'running' ? 'active' : ''}>
            <span>{label}</span><span className={`end-stage-state ${state}`} role="img" aria-label={status} title={status}>
              {state === 'running' ? <span className="end-spinner" aria-hidden="true" /> : state === 'completed' ? <Icon name="check" /> :
                ['failed', 'interrupted'].includes(state) ? <span>Retry needed</span> : <span aria-hidden="true">{state === 'skipped' ? '—' : '·'}</span>}
            </span>
          </li>;
        })}
      </ul>}
      <p className="note">Cancel remaining skips unfinished memory generation; your chat stays saved.</p>
      <MemoryInputRecovery jobs={view?.memory.addJobs ?? []} disabled={busy || !!storageError} onAction={(command,job)=>void act(command,job)} />
      {(actionError || loadError || storageError) && <p className="end-processing-error" role="alert">{actionError || loadError || 'Changes could not be saved. Retry saving to continue.'}</p>}
      </div>
      <div className="end-processing-actions">
        <button disabled={busy || !!storageError} onClick={() => void act('cancelEnd')}>Cancel remaining</button>
        {storageError ? <button className="primary" disabled={busy} onClick={() => void act('retrySaving')}>Retry saving</button> :
          loadError ? <button className="primary" disabled={busy} onClick={() => reload.current()}>Reload status</button> :
          retryable && !(view?.memory.addJobs?.some(job=>['failed','interrupted'].includes(job.state))) && <button className="primary" disabled={busy} onClick={() => void act('continueEnd')}>Try again</button>}
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
