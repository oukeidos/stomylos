import { MemoryControl } from './memory-control';
import type { MemoryPreference } from '../shared/memory-control';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { IconButton } from './icon-button';
import * as Dialog from '@radix-ui/react-dialog';
import type { MemoryManagement } from '../shared/memory-management';
import { matchingMemories } from '../shared/memory-management';
import { memoryCharacters, memoryCharacterCap } from '../main/memory-render';

export interface MemoryManagerHandle { beforeLeave(): Promise<boolean> }
type Editor = { id: string; mode: 'edit' | 'delete'; original: string; text: string; base: MemoryManagement };
export const MemoryManager = forwardRef<MemoryManagerHandle, {
  preference?: MemoryPreference; active: boolean; errorText(error: unknown): string; openChat(id: string): void;
}>(function MemoryManager({active, preference, errorText, openChat}, ref) {
  const [data, setData] = useState<MemoryManagement | null>(null);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [saveRecovery, setSaveRecovery] = useState(false);
  const [retryingSave, setRetryingSave] = useState(false);
  const [notice, setNotice] = useState('');
  const [discard, setDiscard] = useState(false);
  const discardResolve = useRef<((value: boolean) => void) | null>(null);
  const generation = useRef(0), mounted = useRef(true);
  const search = useRef<HTMLInputElement>(null), textarea = useRef<HTMLTextAreaElement>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; discardResolve.current?.(false); }; }, []);
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    try {
      const value = await window.stomylos.command('memoryManagement', undefined);
      if (mounted.current && generation.current === token) { setData(value); setLoadError(false); }
    } catch { if (mounted.current && generation.current === token) setLoadError(true); }
  }, []);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const unsubscribe = window.stomylos.subscribe(event => {
      if (event.type === 'snapshot') setSaveRecovery(!!event.snapshot.activity.storageError);
      if (['memory-changed', 'session-changed', 'session-deleted', 'snapshot'].includes(event.type)) void refresh();
    });
    return () => { generation.current++; unsubscribe(); };
  }, [active, refresh]);
  useEffect(() => { if (editor?.mode === 'edit') textarea.current?.focus(); }, [editor?.id, editor?.mode]);
  const dirty = editor?.mode === 'edit' && editor.text !== editor.original;
  const beforeLeave = useCallback(async () => {
    if (busyRef.current || discardResolve.current) return false;
    if (!dirty) { setEditor(null); return true; }
    setDiscard(true);
    return new Promise<boolean>(resolve => { discardResolve.current = resolve; });
  }, [dirty]);
  useImperativeHandle(ref, () => ({beforeLeave}), [beforeLeave]);
  const finishDiscard = (accepted: boolean) => {
    setDiscard(false);
    if (accepted) { setEditor(null); setError(''); }
    const resolve = discardResolve.current; discardResolve.current = null; resolve?.(accepted);
  };
  const begin = async (id: string, mode: Editor['mode']) => {
    if (!data || !await beforeLeave()) return;
    const item = data.document.database_records.find(item => item.id === id);
    if (item) { setEditor({id, mode, original:item.text, text:item.text, base:data}); setError(''); setNotice(''); }
  };
  const visible = useMemo(() => {
    if (!data) return [];
    const matches = new Set(matchingMemories(data.document.database_records, query).map(item => item.id));
    const list = data.document.database_records.filter(item => matches.has(item.id) || item.id === editor?.id);
    // Keep a conflicting editor visible even if another operation removed its record.
    if (editor && !list.some(item => item.id === editor.id)) list.push({id:editor.id, text:editor.original});
    return list;
  }, [data, query, editor?.id, editor?.original]);
  const excess = useMemo(() => {
    if (!editor || editor.mode !== 'edit') return 0;
    const document = {...editor.base.document, database_records:editor.base.document.database_records.map(item => item.id === editor.id ? {...item, text:editor.text} : item)};
    return Math.max(0, memoryCharacters(document) - memoryCharacterCap);
  }, [editor]);
  const stale = !!editor && !!data && editor.base.hash !== data.hash;
  const locked = busy || !!data?.blocker || loadError;
  const focusItem = (ids: string[]) => requestAnimationFrame(() => {
    for (const id of ids) {
      const button = rows.current.get(id)?.querySelector<HTMLButtonElement>('button');
      if (button && !button.disabled) { button.focus({preventScroll:true}); return; }
    }
    search.current?.focus({preventScroll:true});
  });
  const cancel = async () => { if (busyRef.current) return; const id = editor?.id; setEditor(null); setError(''); if (id) focusItem([id]); };
  const save = async () => {
    if (!editor || locked || busyRef.current || stale || (editor.mode === 'edit' && (!editor.text.trim() || excess || !dirty))) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    const index = visible.findIndex(item => item.id === editor.id);
    const focus = [editor.mode === 'edit' ? editor.id : '', ...visible.slice(index + 1).map(item => item.id), ...visible.slice(0,index).reverse().map(item => item.id)];
    try {
      const value = await window.stomylos.command('editMemory', {id:editor.id, text:editor.mode === 'delete' ? null : editor.text, revision:editor.base.document.revision, hash:editor.base.hash});
      if (!mounted.current) return;
      generation.current++; setData(value); setLoadError(false); setEditor(null);
      setNotice(editor.mode === 'delete' ? 'Memory deleted' : 'Memory updated'); focusItem(focus);
    } catch (cause) {
      if (mounted.current) { setError(errorText(cause)); await refresh(); }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="current-memory memory-manager" aria-busy={busy}>
    <div className="memory-heading"><h3 className="settings-title">Memory</h3>
      <MemoryControl active={active} preference={preference} errorText={errorText} />
    </div>
    {!data && !loadError && <p role="status">Loading memory…</p>}
    {loadError && <div role="alert"><p>Memory could not be loaded.{editor ? ' Your edit is preserved.' : ''}</p><button onClick={() => void refresh()}>Retry loading memory</button></div>}
    {saveRecovery && busy && <div role="alert"><p>Memory could not be saved. Your edit is preserved.</p><button disabled={retryingSave} onClick={async () => {
      setRetryingSave(true); try { await window.stomylos.command('retrySaving', undefined); } catch (cause) { setError(errorText(cause)); } finally { setRetryingSave(false); }
    }}>{retryingSave ? 'Retrying…' : 'Retry saving memory'}</button></div>}
    {data && <>
      {data.blocker && <div className="memory-lock"><p className="note">{data.blocker.reason === 'chat' ? 'Memory is in use by your current chat. Finish the chat to edit it.' : 'Finish memory processing to edit saved memories.'}</p>
        <button disabled={busy} onClick={async () => { const id = data.blocker!.sessionId; if (await beforeLeave()) openChat(id); }}>{data.blocker.reason === 'chat' ? 'Back to chat' : 'View memory processing'}</button></div>}
      <div className="memory-toolbar"><div className="memory-search"><input ref={search} type="search" aria-label="Search memories" placeholder="Search memories" value={query} onChange={event => { setQuery(event.target.value); setNotice(''); }} />
        {query && <IconButton label="Clear search" icon="close" onClick={() => { setQuery(''); search.current?.focus(); }} />}</div>
        <span className="memory-count" role="status" aria-live="polite" aria-label={`${visible.length} of ${data.document.database_records.length} memories`}>{visible.length} / {data.document.database_records.length}</span>
      </div>
      <div role="status" aria-live="polite">{(notice || !data.document.database_records.length) && <p className="note memory-feedback">{notice || 'Nothing recorded.'}</p>}</div>
      {!visible.length && !!data.document.database_records.length && <p>No matching memories</p>}
      <ul className="memory-items">{visible.map(item => <li key={item.id} data-editing={editor?.id === item.id || undefined} ref={node => { if (node) rows.current.set(item.id,node); else rows.current.delete(item.id); }}>
        {editor?.id === item.id ? <>
          {editor.mode === 'edit' ? <><label className="field-label" htmlFor="memory-edit-text">Edit memory</label>
            <textarea ref={textarea} id="memory-edit-text" rows={4} value={editor.text} disabled={busy} onChange={event => setEditor({...editor,text:event.target.value})}
              onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); } }} />
            {!editor.text.trim() && <p className="note">Enter a detail to save, or use Delete to remove this memory.</p>}
            {excess > 0 && <p className="note" role="alert">Memory is over capacity. Remove {excess.toLocaleString()} characters to save.</p>}
          </> : <><strong>Delete this memory?</strong><p className="memory-text">{editor.original}</p><p className="note">This removes the saved detail. Existing chats and backups are unchanged.</p></>}
          {stale && <div role="alert"><p>Saved memory changed. Review the latest version before saving. Your edit is preserved.</p>
            {data.document.database_records.some(record => record.id === editor.id) ? <><p className="memory-text">{item.text}</p><button disabled={busy} onClick={() => { setEditor({...editor,base:data,original:item.text}); setError(''); }}>Use latest version</button></> : <p>This memory has been deleted. Cancel this edit to continue.</p>}</div>}
          {error && <p role="alert">{error}</p>}
          <div className="memory-actions"><button className={editor.mode === 'delete' ? 'danger' : 'primary'} disabled={locked || stale || (editor.mode === 'edit' && (!dirty || !editor.text.trim() || excess > 0))} onClick={() => void save()}>{busy ? 'Saving…' : editor.mode === 'edit' ? 'Save' : 'Delete memory'}</button><button disabled={busy} onClick={() => void cancel()}>Cancel</button></div>
        </> : <div className="memory-read-row"><p className="memory-text">{item.text}</p><div className="memory-row-actions"><IconButton label="Edit" icon="edit" disabled={locked} onClick={() => void begin(item.id,'edit')} /><IconButton label="Delete" icon="trash" disabled={locked} onClick={() => void begin(item.id,'delete')} /></div></div>}
      </li>)}</ul>
    </>}
    <Dialog.Root open={discard} onOpenChange={open => { if (!open) finishDiscard(false); }}><Dialog.Portal><Dialog.Overlay className="modal-overlay" />
      <Dialog.Content className="dialog" aria-describedby="memory-discard-description"><Dialog.Title>Discard memory changes?</Dialog.Title><Dialog.Description id="memory-discard-description">Your unsaved edit will be lost.</Dialog.Description>
        <div className="dialog-actions"><button onClick={() => finishDiscard(false)}>Keep editing</button><button onClick={() => finishDiscard(true)}>Discard changes</button></div>
      </Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
});
