import { useSyncExternalStore } from 'react';
import type { AppEvent, AppSnapshot, SessionView } from '../shared/types';
const listeners = new Set<() => void>();
const streamListeners = new Map<string, Set<() => void>>();
const streamText = new Map<string, string>();
const streamRevisions = new Map<string, number>();
const cached = new Map<string, SessionView>();
const inflight = new Map<string, Promise<SessionView>>();
let snapshot: AppSnapshot | null = null;
let startupError = false;
let frame = 0; const dirty = new Set<string>();
const invalidation = new Map<string, number>();
const viewListeners = new Set<(id: string) => void>();
const deleted = new Set<string>();
const deletionListeners = new Set<(id: string) => void>();
const closeListeners = new Set<(id: number, retry: boolean, current: () => boolean) => void>();
let closeId = 0;
function event(value: AppEvent) {
  if (value.type === 'session-deleted') {
    deleted.add(value.sessionId); cached.delete(value.sessionId);
    invalidation.set(value.sessionId, value.revision);
    if (snapshot) snapshot = { ...snapshot, revision: value.revision, sessions: snapshot.sessions.filter(s => s.id !== value.sessionId) };
    for (const listener of deletionListeners) listener(value.sessionId);
    for (const listener of listeners) listener();
  } else if (value.type === 'memory-changed') {
    const affected = new Set(cached.keys());
    for (const id of inflight.keys()) affected.add(id);
    for (const id of affected) {
      if (value.revision <= (invalidation.get(id) ?? -1)) continue;
      cached.delete(id); invalidation.set(id, value.revision);
      for (const listener of viewListeners) listener(id);
    }
  } else if (value.type === 'snapshot') {
    if (!snapshot || value.snapshot.revision >= snapshot.revision) {
      snapshot = value.snapshot;
      if (snapshot.activity.streamingMessageId) updateStream(snapshot.activity.streamingMessageId, snapshot.activity.streamingText, snapshot.revision);
      for (const listener of listeners) listener();
    }
  } else if (value.type === 'stream') {
    if (value.revision >= (snapshot?.revision ?? -1)) updateStream(value.messageId, value.text, value.revision);
  } else if (value.type === 'session-changed') {
    if (value.revision <= (invalidation.get(value.sessionId) ?? -1)) return;
    cached.delete(value.sessionId); invalidation.set(value.sessionId, value.revision);
    for (const listener of viewListeners) listener(value.sessionId);
  } else if (value.type === 'close-cancelled') closeId = 0;
  else if (value.type === 'close-requested') {
    closeId = value.revision;
    for (const listener of closeListeners) listener(value.revision, !!value.retry, () => closeId === value.revision);
  }
}
function updateStream(id: string, text: string, revision: number) {
  if (revision < (streamRevisions.get(id) ?? -1)) return;
  streamRevisions.set(id, revision); streamText.set(id, text); dirty.add(id);
  while (streamText.size > 8) { const oldest = streamText.keys().next().value!; streamText.delete(oldest); streamRevisions.delete(oldest); }
  if (!frame) frame = requestAnimationFrame(() => {
    frame = 0; for (const changed of dirty) for (const listener of streamListeners.get(changed) ?? []) listener(); dirty.clear();
  });
}
window.stomylos.subscribe(event);
export function reloadSnapshot() {
  startupError = false;
  void window.stomylos.command('snapshot', undefined).then(value => event({ type: 'snapshot', snapshot: value })).catch(() => {
    startupError = true; for (const listener of listeners) listener();
  });
}
reloadSnapshot();
export function useApp() { return useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback); }, () => snapshot); }
export function useStartupError() { return useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback); }, () => startupError); }
export function useStream(id: string, fallback: string, active: boolean) {
  return useSyncExternalStore(callback => {
    let list = streamListeners.get(id); if (!list) { list = new Set(); streamListeners.set(id, list); }
    list.add(callback); return () => { list!.delete(callback); if (!list!.size) streamListeners.delete(id); };
  }, () => active ? streamText.get(id) ?? fallback : fallback);
}
export const isDeleted = (id: string) => deleted.has(id);
export const onDeleted = (listener: (id: string) => void) => { deletionListeners.add(listener); return () => { deletionListeners.delete(listener); }; };
export async function loadView(id: string): Promise<SessionView> {
  if (deleted.has(id)) throw new Error('session_not_found');
  const existing = cached.get(id); if (existing) return existing;
  const pending = inflight.get(id); if (pending) return pending;
  const revision = invalidation.get(id);
  const promise = window.stomylos.command('loadSession', { sessionId: id }).then(async view => {
    inflight.delete(id);
    if (deleted.has(id)) throw new Error('session_not_found');
    if (invalidation.get(id) !== revision) return loadView(id);
    cached.set(id, view);
    while (cached.size > 8) cached.delete(cached.keys().next().value!);
    return view;
  }, error => { inflight.delete(id); throw error; });
  inflight.set(id, promise); return promise;
}
export const onViewChanged = (listener: (id: string) => void) => { viewListeners.add(listener); return () => { viewListeners.delete(listener); }; };
export const onClose = (listener: (id: number, retry: boolean, current: () => boolean) => void) => { closeListeners.add(listener); return () => { closeListeners.delete(listener); }; };
