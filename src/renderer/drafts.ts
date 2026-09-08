import { useSyncExternalStore } from 'react';
type Draft = { text: string; revision: number; saved: number; error: boolean };
const drafts = new Map<string, Draft>(); const listeners = new Set<() => void>();
const dictationIds = new Map<string, Set<string>>();
export function attachDictation(sessionId: string, id: string) { const ids = dictationIds.get(sessionId) ?? new Set<string>(); ids.add(id); dictationIds.set(sessionId, ids); }
export function detachDictation(sessionId: string, id: string) { dictationIds.get(sessionId)?.delete(id); }
let revision = Date.now() * 1000;
const publish = () => { for (const listener of listeners) listener(); };
export function forgetDraft(id: string) { drafts.delete(id); dictationIds.delete(id); publish(); }
export function initializeDraft(id: string, text: string) { if (!drafts.has(id)) drafts.set(id, { text, revision: ++revision, saved: revision, error: false }); }
export function editDraft(id: string, text: string) { const old = drafts.get(id)!; drafts.set(id, { ...old, text, revision: ++revision, error: false }); publish(); }
export function useDraft(id: string) { return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => drafts.get(id)!); }
export function currentDraft(id: string) { return drafts.get(id)!; }
export function nextDraftRevision() { return ++revision; }
export function acceptSavedDraft(id: string, text: string, savedRevision: number) {
  const current = drafts.get(id);
  revision = Math.max(revision, savedRevision);
  if (current && current.revision > savedRevision) return;
  drafts.set(id, { text, revision: savedRevision, saved: savedRevision, error: false }); publish();
}
export function reattachDraft(id: string, text: string, savedRevision: number) {
  const current = drafts.get(id);
  if (current?.text === text && current.revision === current.saved && current.revision !== savedRevision) {
    drafts.set(id, { ...current, revision: savedRevision, saved: savedRevision }); revision = Math.max(revision, savedRevision); publish();
  }
}
export async function flushDraft(id: string, force = false) {
  const draft = drafts.get(id); if (!draft || (!force && draft.revision === draft.saved)) return;
  try {
    await window.stomylos.command('saveDraft', { sessionId: id, text: draft.text, revision: draft.revision, dictationIds: [...dictationIds.get(id) ?? []] });
    const current = drafts.get(id); if (!current) return; drafts.set(id, { ...current, saved: Math.max(current.saved, draft.revision), error: false }); publish();
  } catch (error) { const current = drafts.get(id); if (!current) return; drafts.set(id, { ...current, error: true }); publish(); throw error; }
}
export async function flushAllDrafts() { for (const id of drafts.keys()) await flushDraft(id); }
export function submittedDraft(id: string, submitted: number) {
  dictationIds.delete(id);
  const current = drafts.get(id)!;
  if (current.revision === submitted) drafts.set(id, { text: '', revision: ++revision, saved: revision, error: false });
  publish();
}
