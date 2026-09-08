import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppSnapshot, HistoryFilter, SessionPage } from '../shared/types';
import { isDeleted, onDeleted } from './client';

export function useHistory(app: AppSnapshot | null) {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [offset, setOffset] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [page, setPage] = useState<{ key: string; page: SessionPage } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const key = `${filter}:${offset}:${app?.revision}:${generation}`;
  const current = useRef(key); current.current = key;
  const first = filter === 'all' && offset === 0;
  useEffect(() => {
    setFailure(null);
    if (!app || first) return;
    let alive = true;
    void window.stomylos.command('listSessions', { offset, filter }).then(result => {
      if (!alive || current.current !== key) return;
      setPage({ key, page: result });
      if (result.offset !== offset) setOffset(result.offset);
    }, () => { if (alive && current.current === key) setFailure(key); });
    return () => { alive = false; };
  }, [key, first]);
  const matched = page?.page.filter === filter && page.page.offset === offset;
  return {
    filter, offset,
    sessions: first ? app?.sessions ?? [] : matched ? page.page.sessions : [],
    hasMore: first ? app?.historyHasMore ?? false : matched ? page.page.hasMore : false,
    loading: !first && page?.key !== key && failure !== key,
    failed: failure === key,
    choose: (next: HistoryFilter) => { setFilter(next); setOffset(0); setGeneration(value => value + 1); },
    move: (next: number) => { setOffset(Math.max(0, next)); setGeneration(value => value + 1); },
    retry: () => setGeneration(value => value + 1),
    reset: () => { setFilter('all'); setOffset(0); setGeneration(value => value + 1); }
  };
}

type Undo = { sessionId: string; serial: number };
export function useBookmarks(selected: string | null, committed: (id: string, marked: boolean) => void) {
  const busy = useRef(new Set<string>());
  const [pending, setPending] = useState(new Set<string>());
  const [undo, setUndo] = useState<Undo | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const serial = useRef(0);
  const currentSelection = useRef({ id: selected, generation: 0 });
  if (currentSelection.current.id !== selected) currentSelection.current = { id: selected, generation: currentSelection.current.generation + 1 };
  useEffect(() => { setUndo(null); }, [selected]);
  useEffect(() => onDeleted(id => { setUndo(value => value?.sessionId === id ? null : value); }), []);
  const set = async (sessionId: string, bookmarked: boolean) => {
    if (busy.current.has(sessionId)) return;
    const origin = currentSelection.current.generation;
    busy.current.add(sessionId); setPending(new Set(busy.current));
    try {
      const result = await window.stomylos.command('setSessionBookmark', { sessionId, bookmarked });
      if (isDeleted(sessionId)) return;
      committed(sessionId, result.bookmarked);
      setAnnouncement(result.bookmarked ? 'Chat bookmarked.' : 'Bookmark removed.');
      setUndo(!result.bookmarked && origin === currentSelection.current.generation ? { sessionId, serial: ++serial.current } : null);
    } finally { busy.current.delete(sessionId); setPending(new Set(busy.current)); }
  };
  return { set, pending, undo, announcement, dismiss: () => setUndo(null) };
}

export function BookmarkUndo({ undo, disabled, restore, dismiss }: {
  undo: Undo; disabled: boolean; restore: () => void; dismiss: () => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const action = useRef(dismiss); action.current = dismiss;
  const lifetime = useRef({ serial: undo.serial, remaining: 8000 });
  useLayoutEffect(() => {
    const element = node.current!;
    if (lifetime.current.serial !== undo.serial) lifetime.current = { serial: undo.serial, remaining: 8000 };
    let started = 0, timer: ReturnType<typeof setTimeout> | undefined;
    let hovered = element.matches(':hover'), focused = element.contains(document.activeElement);
    const pause = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; lifetime.current.remaining -= performance.now() - started; } };
    const resume = () => { if (hovered || focused || disabled || timer !== undefined) return; started = performance.now(); timer = setTimeout(() => action.current(), Math.max(0, lifetime.current.remaining)); };
    const enter = () => { hovered = true; pause(); };
    const leave = () => { hovered = false; resume(); };
    const focus = () => { focused = true; pause(); };
    const blur = (event: FocusEvent) => { if (!element.contains(event.relatedTarget as Node | null)) { focused = false; resume(); } };
    element.addEventListener('pointerenter', enter); element.addEventListener('pointerleave', leave);
    element.addEventListener('focusin', focus); element.addEventListener('focusout', blur); resume();
    return () => { pause(); element.removeEventListener('pointerenter', enter); element.removeEventListener('pointerleave', leave); element.removeEventListener('focusin', focus); element.removeEventListener('focusout', blur); };
  }, [undo.serial, disabled]);
  return <div className="bookmark-undo" ref={node}><span>Bookmark removed.</span><button disabled={disabled} onClick={restore}>Undo</button></div>;
}
