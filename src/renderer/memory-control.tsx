import { useEffect, useRef, useState } from 'react';
import type { MemoryPreference } from '../shared/memory-control';
import { IconButton } from './icon-button';
import type { ColdStatus } from '../shared/cold-memory';

export function MemoryControl({ preference, active, characters, errorText, coldStatus, refreshStatus }: { active:boolean; preference?: MemoryPreference; characters?:number; errorText(error:unknown):string; coldStatus:ColdStatus|null; refreshStatus():Promise<void> }) {
  const [saved,setSaved] = useState(preference), [open,setOpen] = useState(false);
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [recovery,setRecovery] = useState(false);
  const [indexBusy,setIndexBusy] = useState(false), [indexError,setIndexError] = useState('');
  const attention = !!coldStatus && !!(coldStatus.indexingFailure || coldStatus.failed || coldStatus.excluded || coldStatus.storageWarning);
  const root = useRef<HTMLDivElement>(null), info = useRef<HTMLButtonElement>(null), toggle = useRef<HTMLButtonElement>(null);
  const retry = useRef<boolean|null>(null), pending = useRef(false);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  useEffect(() => { if (preference) setSaved(preference); }, [preference?.enabled,preference?.revision]);
  useEffect(() => window.stomylos.subscribe(event => {
    if (event.type !== 'snapshot') return;
    if (event.snapshot.settings.memory) setSaved(event.snapshot.settings.memory);
    setRecovery(!!event.snapshot.activity.storageError);
    if (pending.current && event.snapshot.activity.storageError) setOpen(true);
  }), []);
  useEffect(() => {
    if (!open) return;
    const outside = (event:PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event:KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); (info.current ?? toggle.current)?.focus({preventScroll:true});
    };
    document.addEventListener('pointerdown',outside); window.addEventListener('keydown',escape,true);
    return () => { document.removeEventListener('pointerdown',outside); window.removeEventListener('keydown',escape,true); };
  },[open]);
  const change = async (enabled:boolean) => {
    if (!saved || pending.current) return;
    pending.current=true;setBusy(true);setError('');setNotice('');retry.current=enabled;
    try {
      const result=await window.stomylos.command('setMemoryPreference',{enabled,revision:saved.revision});
      setSaved(result);retry.current=null;
      if (!enabled) {
        try { const snapshot=await window.stomylos.command('snapshot',undefined);
        if (snapshot.unfinished) {
          const view=await window.stomylos.command('loadSession',{sessionId:snapshot.unfinished.id});
          if (view.memoryPolicy?.firstEnabled) {setNotice('This chat has already used memory. Start a new chat to continue without it.');setOpen(true);}
        } } catch { /* The preference is already saved; optional context may be unavailable. */ }
      }
    } catch (cause) {
      setError(errorText(cause));setOpen(true);
      try { const snapshot=await window.stomylos.command('snapshot',undefined);setSaved(snapshot.settings.memory); } catch { /* Keep last acknowledged state. */ }
    } finally {pending.current=false;setBusy(false);}
  };
  const retryIndexing = async () => {
    if (indexBusy || !saved?.enabled) return;
    setIndexBusy(true); setIndexError('');
    try { await window.stomylos.command('coldRetry',undefined); await refreshStatus(); }
    catch (cause) { setIndexError(errorText(cause)); }
    finally { setIndexBusy(false); }
  };
  return <div className="memory-scope memory-control" ref={root}>
    {attention && <IconButton label="Memory needs attention" icon="warning" className="memory-attention" aria-expanded={open} aria-controls="memory-info" onClick={() => setOpen(value=>!value)} />}
    <span className="memory-sr-status" role="status" aria-live="polite">{attention ? 'Memory needs attention.' : ''}</span>
    <span className="memory-toggle-state" aria-hidden="true">{saved?.enabled === false ? 'Off' : 'On'}</span>
    <button ref={toggle} type="button" className="memory-toggle" role="switch" aria-label="Use memory" aria-checked={saved?.enabled ?? true}
      disabled={!saved || busy || recovery} onClick={() => void change(!saved?.enabled)}><span /></button>
    <IconButton ref={info} label="About memory" icon="info" aria-expanded={open} aria-controls="memory-info" onClick={() => setOpen(value=>!value)} />
    <span className="memory-sr-status" role="status" aria-live="polite">{busy ? 'Saving memory setting…' : ''}</span>
    {open && <div className="memory-info-popover" id="memory-info" role="region" aria-label="About memory">
      {recovery && busy ? <div role="alert"><p>The memory setting is waiting for storage recovery.</p><button onClick={() => void window.stomylos.command('retrySaving',undefined).catch(cause=>setError(errorText(cause)))}>Retry saving</button></div> :
        error && <div role="alert"><p>Memory setting could not be saved. {error}</p>{retry.current !== null && <button disabled={busy} onClick={() => void change(retry.current!)}>Retry</button>}</div>}
      {notice && <p role="status">{notice}</p>}
      {(attention || indexError) && <div className="memory-status-details">
        {!!(coldStatus?.indexingFailure || coldStatus?.failed || coldStatus?.excluded) && <>
          <p>Some notes are not ready for recall. Existing recollections remain available.</p>
          {coldStatus?.indexingFailure === 'cold_model_missing' || coldStatus?.indexingFailure === 'cold_model_integrity'
            ? <p>Install the verified memory model with <code>npm run model:fetch</code>, then retry.</p> : null}
          <button disabled={!saved?.enabled || indexBusy} onClick={() => void retryIndexing()}>{indexBusy ? 'Retrying…' : 'Retry local indexing'}</button>
        </>}
        {coldStatus?.storageWarning && <p>Memory storage is large. Review disk space and backups.</p>}
        {indexError && <p role="alert">{indexError}</p>}
      </div>}
      <p>Memory saves notes for future chats with any partner. Older notes stay as recorded and may be recalled. Matching is local; notes used in replies go to your AI provider.</p>
      <p>Recent holds up to 3,000 characters; overflow moves to Older. Edit Recent notes or delete either kind here. Asking a partner to forget does not delete notes.</p>
      <p>Off pauses memory use and new notes, keeping saved notes. Already-used memory remains in the current chat. Start a new chat after turning memory back on.</p>
      <p>Chats are still saved and sent when memory is off. Past chats and backups stay unchanged.</p>
      <details className="memory-storage-details"><summary>Storage</summary>
        {characters !== undefined && <p>{characters.toLocaleString()} / 3,000 recent characters</p>}
        {coldStatus ? <>
          <p>{coldStatus.originals.toLocaleString()} older notes · {coldStatus.groups.toLocaleString()} groups</p>
          {coldStatus.oversized > 0 && <p>{coldStatus.oversized.toLocaleString()} notes are too long for recall and remain saved.</p>}
        </> : <p>Older memory status could not be loaded.</p>}
      </details>
    </div>}
  </div>;
}
