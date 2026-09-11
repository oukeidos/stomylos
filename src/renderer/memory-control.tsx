import { useEffect, useRef, useState } from 'react';
import type { MemoryPreference } from '../shared/memory-control';
import { IconButton } from './icon-button';

export function MemoryControl({ preference, active, characters, errorText }: { active:boolean; preference?: MemoryPreference; characters?:number; errorText(error:unknown):string }) {
  const [saved,setSaved] = useState(preference), [open,setOpen] = useState(false);
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [recovery,setRecovery] = useState(false);
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
  return <div className="memory-scope memory-control" ref={root}>
    <span className="memory-toggle-state" aria-hidden="true">{saved?.enabled === false ? 'Off' : 'On'}</span>
    <button ref={toggle} type="button" className="memory-toggle" role="switch" aria-label="Use memory" aria-checked={saved?.enabled ?? true}
      disabled={!saved || busy || recovery} onClick={() => void change(!saved?.enabled)}><span /></button>
    <IconButton ref={info} label="About memory" icon="info" aria-expanded={open} aria-controls="memory-info" onClick={() => setOpen(value=>!value)} />
    <span className="memory-sr-status" role="status" aria-live="polite">{busy ? 'Saving memory setting…' : ''}</span>
    {open && <div className="memory-info-popover" id="memory-info" role="region" aria-label="About memory">
      {recovery && busy ? <div role="alert"><p>The memory setting is waiting for storage recovery.</p><button onClick={() => void window.stomylos.command('retrySaving',undefined).catch(cause=>setError(errorText(cause)))}>Retry saving</button></div> :
        error && <div role="alert"><p>Memory setting could not be saved. {error}</p>{retry.current !== null && <button disabled={busy} onClick={() => void change(retry.current!)}>Retry</button>}</div>}
      {notice && <p role="status">{notice}</p>}
      {characters !== undefined && <p>{characters.toLocaleString()} / 4,000 characters. Oldest notes are removed when memory is full.</p>}
      <p>Memory saves notes from your messages for future chats with any partner.</p>
      <p>Off stops memory use and new notes; saved notes stay. It cannot undo memory already used in this chat. Start a new chat after turning memory back on.</p>
      <p>Edit or delete notes here. Asking a partner to forget does not delete them. Existing chats and backups stay unchanged.</p>
      <p>Chats are still saved and sent to AI providers when memory is off.</p>
    </div>}
  </div>;
}
