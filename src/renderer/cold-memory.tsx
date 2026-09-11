import { useCallback, useEffect, useRef, useState } from 'react';
import type { ColdMemory, ColdPage, ColdStatus } from '../shared/cold-memory';
import { IconButton } from './icon-button';

export function ColdMemories({ locked, enabled, errorText, onBusy }: {
  locked: boolean; enabled: boolean; errorText(code: unknown): string; onBusy(value: boolean): void;
}) {
  const [page, setPage] = useState<ColdPage | null>(null), [status, setStatus] = useState<ColdStatus | null>(null);
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0);
  const [target, setTarget] = useState<{ item: ColdMemory; revision: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const serial = useRef(0), search = useRef<HTMLInputElement>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
  const refresh = useCallback(async () => {
    const token = ++serial.current;
    try {
      const [next, current] = await Promise.all([window.stomylos.command('coldPage', { query, offset }), window.stomylos.command('coldStatus', undefined)]);
      if (!mounted.current || token !== serial.current) return;
      if (offset && !next.items.length) { setOffset(Math.max(0, offset - 50)); return; }
      setPage(next); setStatus(current);
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
  return <section aria-label="Older memories">
    <p className="note">Older notes are preserved as originally recorded. A few may return in later chats. Embedding is local; recalled notes are included in your conversation provider requests.</p>
    {status && <div className="note" role="status">
      <p>{status.originals.toLocaleString()} older notes · {status.groups.toLocaleString()} ready groups · {status.pending.toLocaleString()} pending · {status.failed.toLocaleString()} failed</p>
      {(status.indexingFailure || status.failed > 0) && <>
        <p>New memory indexing is paused or needs attention. Existing ready recollections remain available.</p>
        {status.indexingFailure === 'cold_model_missing' || status.indexingFailure === 'cold_model_integrity'
          ? <p>Install the verified local model with <code>npm run model:fetch</code> in the app source folder, then retry indexing.</p> : null}
        <button disabled={!enabled || busy} onClick={async () => {
          try { await window.stomylos.command('coldRetry', undefined); await refresh(); }
          catch (cause) { setError(errorText(cause)); }
        }}>Retry local indexing</button>
      </>}
      {status.oversized > 0 && <p>{status.oversized.toLocaleString()} notes exceed the recollection budget and are retained without shortening.</p>}
      {status.excluded > 0 && <p>{status.excluded.toLocaleString()} notes are excluded from the current groups after processing failures.</p>}
      {status.storageWarning && <p>Your memory store is large. Review disk space and backup size; no notes are automatically deleted.</p>}
    </div>}
    <div className="memory-toolbar"><div className="memory-search">
      <input ref={search} type="search" aria-label="Search older memories" placeholder="Search older memories" value={query} maxLength={1000}
        onChange={event => { setQuery(event.target.value); setOffset(0); setTarget(null); }} />
    </div><span className="memory-count">{page?.total ?? 0}</span></div>
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
