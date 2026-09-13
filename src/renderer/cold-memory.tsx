import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ColdMemory, ColdPage } from '../shared/cold-memory';
import { IconButton } from './icon-button';

export function ColdMemories({ locked, ageSelector, errorText, onBusy }: {
  locked: boolean; ageSelector: ReactNode; errorText(code: unknown): string; onBusy(value: boolean): void;
}) {
  const [page, setPage] = useState<(ColdPage & { offset: number; query: string }) | null>(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0);
  const [target, setTarget] = useState<{ item: ColdMemory; revision: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const serial = useRef(0), search = useRef<HTMLInputElement>(null), mounted = useRef(true);
  const previous = useRef<HTMLButtonElement>(null), nextButton = useRef<HTMLButtonElement>(null);
  const navigationFocus = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
  const refresh = useCallback(async () => {
    const token = ++serial.current;
    setLoading(true); setLoadError('');
    try {
      const next = await window.stomylos.command('coldPage', { query, offset });
      if (!mounted.current || token !== serial.current) return;
      if (offset && !next.items.length) { setOffset(Math.max(0, Math.floor((next.total - 1) / 50) * 50)); return; }
      setPage({...next, offset, query}); setLoading(false);
    } catch (cause) {
      if (mounted.current && token === serial.current) { setLoadError(errorText(cause)); setLoading(false); }
    }
  }, [query, offset, errorText]);
  useEffect(() => {
    const timer = setTimeout(() => { void refresh(); }, 100);
    const unsubscribe = window.stomylos.subscribe(event => { if (['memory-changed','snapshot','session-deleted'].includes(event.type)) void refresh(); });
    return () => { clearTimeout(timer); unsubscribe(); serial.current++; };
  }, [refresh]);
  useLayoutEffect(() => {
    const origin = navigationFocus.current;
    if (loading || !origin) return;
    navigationFocus.current = null;
    if (document.activeElement !== document.body && document.activeElement !== origin) return;
    const button = [origin, previous.current, nextButton.current].find(node => node?.isConnected && !node.disabled);
    (button ?? search.current)?.focus({preventScroll:true});
  }, [loading, page]);
  const changePage = (value: number, button: HTMLButtonElement) => {
    if (loading || busy) return;
    navigationFocus.current = button;
    setLoading(true); setLoadError(''); setOffset(value); setTarget(null);
    // Retry the same requested offset after a failed load.
    if (value === offset) void refresh();
  };
  const changeQuery = (value: string) => {
    setLoading(true); setLoadError(''); setQuery(value); setOffset(0); setTarget(null);
  };
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
        onChange={event => changeQuery(event.target.value)} />
      {query && <IconButton label="Clear search" icon="close" onClick={() => { changeQuery(''); search.current?.focus(); }} />}
    </div><span className="memory-sr-status" role="status" aria-live="polite">{page ? `${page.total} matching older memories` : ''}</span></div>
    {error && <p role="alert">{error}</p>}
    {loadError && <div role="alert"><p>{loadError}</p><button disabled={loading} onClick={() => void refresh()}>Retry loading older memories</button></div>}
    {notice && <p role="status">{notice}</p>}
    {!page && loading && <p role="status">Loading older memories…</p>}
    {page && !page.items.length && <p>{page.query ? 'No matching older memories.' : 'Nothing archived yet. Older notes appear here as recent memory fills up.'}</p>}
    <ul className="memory-items" aria-busy={loading}>{page?.items.map(item => <li key={item.id}>
      <div className="memory-read-row"><div><p className="memory-text">{item.text}</p><p className="note">
        {item.time_basis === 'manual_edit' ? `Edited ${item.edited_at}` : item.time_basis === 'source_message' ? `Reported ${item.observed_at}` : 'Date unknown'}
      </p></div><IconButton icon="trash" label="Delete older memory" disabled={locked || busy} onClick={() => { setTarget({ item, revision: page.revision }); setError(''); setNotice(''); }} /></div>
      {target?.item.id === item.id && <div className="memory-delete-confirmation">
        <strong>Delete this older memory?</strong><p className="note">This note will no longer be recalled. Past chats, transmitted requests, other repeated notes and backups remain unchanged.</p>
        <div className="memory-actions"><button className="danger" disabled={locked || busy} onClick={() => void deleting()}>{busy ? 'Deleting…' : 'Delete older memory'}</button>
          <button disabled={busy} onClick={() => setTarget(null)}>Cancel</button></div>
      </div>}
    </li>)}</ul>
    {page && page.total > 50 && <nav className="memory-pagination" aria-label="Older memory pagination" aria-busy={loading}>
      <span className="memory-page-range" role="status" aria-live="polite" aria-atomic="true">
        <span aria-hidden="true"><strong>{page.offset + 1}–{page.offset + page.items.length}</strong><span className="memory-page-separator">/</span>{page.total}</span>
        <span className="memory-sr-status">{page.offset + 1} through {page.offset + page.items.length} of {page.total} older memories</span>
      </span>
      <div className="memory-page-buttons" role="group" aria-label="Memory pages">
        <IconButton ref={previous} label="Previous page" icon="chevronLeft" disabled={page.offset === 0 || busy || loading}
          onClick={event => changePage(Math.max(0, page.offset - 50), event.currentTarget)} />
        <IconButton ref={nextButton} label="Next page" icon="chevronRight" disabled={page.next === null || busy || loading}
          onClick={event => changePage(page.next!, event.currentTarget)} />
      </div>
    </nav>}
  </section>;
}
