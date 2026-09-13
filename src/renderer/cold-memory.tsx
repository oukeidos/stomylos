import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ColdMemory, ColdPage } from '../shared/cold-memory';
import { IconButton } from './icon-button';

export function ColdMemories({ locked, ageSelector, errorText, onBusy }: {
  locked: boolean; ageSelector: ReactNode; errorText(code: unknown): string; onBusy(value: boolean): void;
}) {
  const [page, setPage] = useState<ColdPage | null>(null);
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0);
  const [target, setTarget] = useState<{ item: ColdMemory; revision: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const serial = useRef(0), search = useRef<HTMLInputElement>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
  const refresh = useCallback(async () => {
    const token = ++serial.current;
    try {
      const next = await window.stomylos.command('coldPage', { query, offset });
      if (!mounted.current || token !== serial.current) return;
      if (offset && !next.items.length) { setOffset(Math.max(0, offset - 50)); return; }
      setPage(next);
    } catch (cause) { if (mounted.current && token === serial.current) setError(errorText(cause)); }
  }, [query, offset, errorText]);
  useEffect(() => {
    const timer = setTimeout(() => { void refresh(); }, 100);
    const unsubscribe = window.stomylos.subscribe(event => { if (['memory-changed','snapshot','session-deleted'].includes(event.type)) void refresh(); });
    return () => { clearTimeout(timer); unsubscribe(); serial.current++; };
  }, [refresh]);
  const deleting = async () => {
    if (!target || busy || locked) return;
    setBusy(true); onBusy(true); setError('');
    try {
      await window.stomylos.command('coldDelete', { id: target.item.id, hash: target.item.text_hash, revision: target.revision });
      if (mounted.current) { setTarget(null); setNotice('Older memory deleted from future recollections.'); await refresh(); search.current?.focus(); }
    } catch (cause) { if (mounted.current) { setError(errorText(cause)); await refresh(); } }
    finally { if (mounted.current) setBusy(false); onBusy(false); }
  };
  return <section className="older-memory" aria-label="Older memories">
    <div className="memory-toolbar">{ageSelector}<div className="memory-search">
      <input ref={search} type="search" aria-label="Search older memories" placeholder="Search" value={query} maxLength={1000}
        onChange={event => { setQuery(event.target.value); setOffset(0); setTarget(null); }} />
      {query && <IconButton label="Clear search" icon="close" onClick={() => { setQuery(''); setOffset(0); setTarget(null); search.current?.focus(); }} />}
    </div><span className="memory-sr-status" role="status" aria-live="polite">{page ? `${page.total} matching older memories` : ''}</span></div>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!page && <p>Loading older memories…</p>}
    {page && !page.items.length && <p>{query ? 'No matching older memories.' : 'Nothing archived yet. Older notes appear here as recent memory fills up.'}</p>}
    <ul className="memory-items">{page?.items.map(item => <li key={item.id}>
      <div className="memory-read-row"><div><p className="memory-text">{item.text}</p><p className="note">
        {item.time_basis === 'manual_edit' ? `Edited ${item.edited_at}` : item.time_basis === 'source_message' ? `Reported ${item.observed_at}` : 'Date unknown'}
      </p></div><IconButton icon="trash" label="Delete older memory" disabled={locked || busy} onClick={() => { setTarget({ item, revision: page.revision }); setError(''); setNotice(''); }} /></div>
      {target?.item.id === item.id && <div className="memory-delete-confirmation">
        <strong>Delete this older memory?</strong><p className="note">This note will no longer be recalled. Past chats, transmitted requests, other repeated notes and backups remain unchanged.</p>
        <div className="memory-actions"><button className="danger" disabled={locked || busy} onClick={() => void deleting()}>{busy ? 'Deleting…' : 'Delete older memory'}</button>
          <button disabled={busy} onClick={() => setTarget(null)}>Cancel</button></div>
      </div>}
    </li>)}</ul>
    {page && (offset > 0 || page.next !== null) && <div className="memory-actions">
      <button disabled={offset === 0 || busy} onClick={() => { setOffset(Math.max(0, offset - 50)); setTarget(null); }}>Previous</button>
      <span>{offset + 1}–{offset + page.items.length} of {page.total}</span>
      <button disabled={page.next === null || busy} onClick={() => { setOffset(page.next!); setTarget(null); }}>Next</button>
    </div>}
  </section>;
}
