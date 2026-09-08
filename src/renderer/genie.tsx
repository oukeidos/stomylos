import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { Icon } from './icons';
import * as Dialog from '@radix-ui/react-dialog';
import type { GenieRange, GenieSnapshot } from '../shared/genie';
import { acceptSavedDraft, currentDraft, flushDraft, nextDraftRevision, reattachDraft } from './drafts';
import { prepareDictationSend } from './dictation';
import { moveGenieSelection, sourceOffset, displayOffset } from './genie-selection';

let snapshot: GenieSnapshot = { revision: -1, episode: null, undo: null, draftResult: null };
let opening: { id: string; text: string; range: GenieRange; token: string } | null = null;
let pending = false, version = 0;
const listeners = new Set<() => void>();
const notify = () => { version++; for (const f of listeners) f(); };
function receive(value: GenieSnapshot) {
  if (value.revision < snapshot.revision) return;
  if (value.episode && snapshot.episode?.id === value.episode.id && snapshot.episode.followupRevision > value.episode.followupRevision) {
    value = { ...value, episode: { ...value.episode, followup: snapshot.episode.followup, followupRevision: snapshot.episode.followupRevision } };
  }
  snapshot = value;
  if (value.draftResult) { const d = value.draftResult; acceptSavedDraft(d.sessionId, d.text, d.revision); }
  notify();
}
window.stomylos.subscribe(event => { if (event.type === 'genie') receive(event.snapshot); });
void window.stomylos.command('genieSnapshot', undefined).then(receive).catch(() => undefined);
export function useGenie() {
  useSyncExternalStore(f => { listeners.add(f); return () => { listeners.delete(f); }; }, () => version);
  return { ...snapshot, opening, pending, locked: !!opening || pending || !!snapshot.episode?.open };
}
export function genieBusy() { return !!opening || pending || !!snapshot.episode?.open; }
export function captureGenieRange(node: HTMLTextAreaElement, source = node.value): GenieRange {
  return { start: sourceOffset(source, node.selectionStart), end: sourceOffset(source, node.selectionEnd), direction: node.selectionDirection,
    scope: node.selectionStart === node.selectionEnd ? 'draft' : 'selection' };
}
export async function openGenie(id: string, range: GenieRange) {
  if (genieBusy()) return;
  const draft = currentDraft(id), token = crypto.randomUUID();
  opening = { id, text: draft.text, range, token }; notify();
  try {
    await prepareDictationSend(id); await flushDraft(id, true);
    if (opening?.token !== token) return;
    if (currentDraft(id).revision !== draft.revision || currentDraft(id).text !== draft.text) throw new Error('genie_stale');
    const value = await window.stomylos.command('genieOpen', { sessionId: id, text: draft.text, revision: draft.revision, range, operationId: token });
    receive(value);
    if (opening?.token !== token && value.episode?.open) await window.stomylos.command('genieClose', { episodeId: value.episode.id });
  } finally { if (opening?.token === token) opening = null; notify(); }
}
export async function closeGenieForApp() {
  opening = null; notify();
  if (snapshot.episode?.open && snapshot.episode.phase !== 'saving') await window.stomylos.command('genieClose', { episodeId: snapshot.episode.id });
}
const errors: Record<string, string> = {
  genie_limit: 'This help conversation has reached its size limit. Shorten your reply, return to writing, or start over.',
  genie_stale: 'The original draft or conversation changed. Return to writing and open Genie again.',
  genie_busy: 'Wait for this action to finish, or cancel the current request.',
  genie_output: 'Genie could not provide a usable response. You can retry or return to writing.',
  request_timeout: 'Genie took too long to respond. You can retry or return to writing.',
  request_cancelled: 'Request cancelled. The provider may still charge for it; Retry makes a new request.',
  save_required: 'Save your changes before continuing.',
  genie_range: 'Select the text again before requesting help.'
};
export function genieError(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return errors[code] ?? 'Genie could not finish this request. Your original draft is preserved. You can retry or return to writing.';
}
export function GenieDock({ sessionId, textarea, storageError }: { sessionId: string; textarea: RefObject<HTMLTextAreaElement | null>; storageError: string | null }) {
  const state = useGenie(), e = state.episode?.sessionId === sessionId && state.episode.open ? state.episode : null;
  const boot = state.opening?.id === sessionId ? state.opening : null;
  const open = !!boot || !!e?.open;
  const [error, setError] = useState<string | null>(null), [changing, setChanging] = useState(false);
  const [range, setRange] = useState<GenieRange | null>(null);
  const original = useRef<HTMLTextAreaElement>(null), followup = useRef<HTMLTextAreaElement>(null), history = useRef<HTMLDivElement>(null);
  const composing = useRef(false), caret = useRef<GenieRange | null>(null);
  const followHistory = useRef(true);
  const followupRevision = useRef(0);
  useEffect(() => {
    if (e?.open) { reattachDraft(sessionId, e.source.text, e.source.revision); caret.current = e.range; }
  }, [e?.id, sessionId, e?.open]);
  useEffect(() => { setChanging(false); setRange(null); setError(null); if (e?.open) followup.current?.focus(); }, [e?.id]);
  useEffect(() => { const node = history.current; if (node) { followHistory.current = true; node.scrollTop = node.scrollHeight; } }, [e?.turns.length, e?.phase, changing, open]);
  useEffect(() => {
    const node = history.current; if (!node) return;
    const observer = new ResizeObserver(() => { if (followHistory.current) node.scrollTop = node.scrollHeight; });
    observer.observe(node); return () => observer.disconnect();
  }, [open]);
  useEffect(() => { if (changing) original.current?.focus(); }, [changing]);
  const run = (f: () => Promise<unknown>) => { setError(null); void f().catch(cause => setError(genieError(cause))); };
  const close = async () => {
    if (e?.phase === 'saving' || pending) return;
    if (boot) { caret.current = boot.range; opening = null; notify(); }
    if (e?.open) await window.stomylos.command('genieClose', { episodeId: e.id });
  };
  const submit = async () => {
    if (!e || e.phase !== 'ready' || pending || !e.followup.trim() || composing.current) return;
    pending = true; notify();
    try { await window.stomylos.command('genieSubmit', { episodeId: e.id, text: e.followup,
      revision: Math.max(followupRevision.current, e.followupRevision), operationId: crypto.randomUUID() }); }
    finally { pending = false; notify(); followup.current?.focus(); }
  };
  const text = e?.source.text ?? boot?.text ?? '', target = e?.range ?? boot?.range;
  const current = e?.turns.at(-1), saving = e?.phase === 'saving';
  const restoreFocus = () => {
    const node = textarea.current; if (!node) return;
    node.focus({ preventScroll: true });
    const r = snapshot.draftResult?.sessionId === sessionId ? snapshot.draftResult.range : caret.current;
    if (r) { const source = currentDraft(sessionId).text; node.setSelectionRange(displayOffset(source, r.scope === 'draft' ? r.end : r.start), displayOffset(source, r.end), r.direction); }
  };
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) run(close); }}>
    <Dialog.Content className="genie-dock" aria-describedby="genie-description"
      onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (saving || pending) event.preventDefault(); }}
      onOpenAutoFocus={event => { event.preventDefault(); followup.current?.focus(); }}
      onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
      <div className="dialog-heading"><Dialog.Title><Icon name="help" />Genie</Dialog.Title>
        <button className="icon-button" aria-label="Start over" title="Start over" disabled={!e || saving || pending || !!storageError} onClick={() => run(async () => {
          if (!e) return; pending = true; notify();
          try { receive(await window.stomylos.command('genieTarget', { episodeId: e.id, range: e.range, operationId: crypto.randomUUID() })); }
          finally { pending = false; notify(); }
        })}><Icon name="refresh" /></button>
        <button className="icon-button" aria-label="Close Genie" title="Back to writing" disabled={saving || pending} onClick={() => run(close)}><Icon name="close" /></button></div>
      <p className="sr-only" id="genie-description">Help with your unsent draft. Apply a suggestion to your draft, then send it separately. Close or press Escape to return to writing.</p>
      <div className="genie-columns"><section className={`genie-original ${changing ? 'changing-target' : ''}`} aria-label="Original draft">
        <div className="genie-target-heading"><strong>{target?.scope === 'selection' ? 'Selected text' : 'Entire draft'}</strong>
          <button className="icon-button" aria-label="Change target" title="Change target" disabled={!e || saving || pending} onClick={() => { setChanging(true); setRange(null); }}> <Icon name="target" /></button></div>
        {changing ? <><label htmlFor="genie-source">Select a new target in your original draft</label><textarea id="genie-source" ref={original} value={text} readOnly
          onSelect={event => setRange(captureGenieRange(event.currentTarget, text))}
          onKeyDown={event => {
            if (event.altKey || event.nativeEvent.isComposing) return;
            const node = event.currentTarget, next = moveGenieSelection(node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, event.key, event.shiftKey, event.ctrlKey || event.metaKey);
            if (!next) return; event.preventDefault(); node.setSelectionRange(next.start, next.end, next.direction); setRange(captureGenieRange(node, text));
          }}
          onKeyUp={event => setRange(captureGenieRange(event.currentTarget, text))}
          onPointerUp={event => setRange(captureGenieRange(event.currentTarget, text))} />
          <div className="genie-target-actions"><button disabled={!range || range.scope !== 'selection'} onClick={() => run(async () => {
            if (!e || !range) return; pending = true; notify();
            try { receive(await window.stomylos.command('genieTarget', { episodeId: e.id, range, operationId: crypto.randomUUID() })); }
            finally { pending = false; notify(); }
          })}>Help with selection</button><button onClick={() => run(async () => {
            if (!e) return; pending = true; notify();
            try { receive(await window.stomylos.command('genieTarget', { episodeId: e.id, range: { start: 0, end: text.length, direction: 'none', scope: 'draft' }, operationId: crypto.randomUUID() })); }
            finally { pending = false; notify(); }
          })}>Use entire draft</button><button onClick={() => setChanging(false)}>Cancel target change</button></div></>
          : <div className="genie-source-text" hidden={target?.scope !== 'selection'}>{target?.scope === 'selection' && <mark>{text.slice(target.start, target.end)}</mark>}</div>}
        <p className="sr-only">{target?.scope === 'selection' ? 'Only the highlighted text will be replaced.' : 'A suggestion replaces the whole draft.'}</p>
      </section><section className="genie-conversation" aria-label="Expression help">
        <div className="genie-history" ref={history} onScroll={() => { const node = history.current!; followHistory.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32; }}>{e?.turns.map(turn => <div className="genie-turn" key={turn.id}>
          {turn.user && <p className="genie-learner">{turn.user}</p>}
          {turn.reply?.reply && <p>{turn.reply.reply}</p>}
          {turn.reply?.suggested_text !== null && turn.reply?.suggested_text !== undefined && <div className="genie-suggestion"><p>{turn.reply.suggested_text}</p>
            {e.candidateId === turn.id && e.phase === 'ready' && <button className="icon-button primary" aria-label={e.range.scope === 'selection' ? 'Replace selection' : 'Use in draft'} title={e.range.scope === 'selection' ? 'Replace selection in draft' : 'Use in draft'} disabled={pending || !!storageError || changing} onClick={() => run(async () => {
              pending = true; notify();
              try { const result = await window.stomylos.command('genieApply', { episodeId: e.id, candidateId: turn.id,
                revision: nextDraftRevision(), operationId: crypto.randomUUID() }); caret.current = result.range; acceptSavedDraft(sessionId, result.text, result.revision); }
              finally { pending = false; notify(); }
            })}><Icon name="apply" /></button>}
          </div>}
        </div>)}</div>
        <div role="status" className="genie-status">{boot && !e?.open ? 'Saving your draft…' : saving ? 'Saving replacement…' : e?.phase === 'waiting' ? 'Genie is thinking…' : e?.phase === 'ready' && !current?.reply?.reply && !e.candidateId ? 'No replacement suggested.' : ''}</div>
        {current?.error && <p role="alert" className="draft-error">{genieError(current.error)}</p>}
        {(error || storageError) && <p role="alert" className="draft-error">{storageError ? 'Your changes could not be saved. Keep this window open and retry saving.' : error}</p>}
        {storageError && <button onClick={() => run(() => window.stomylos.command('retrySaving', undefined))}>Retry saving</button>}
        <div className="genie-recovery">{e?.phase === 'waiting' && <button onClick={() => run(() => window.stomylos.command('genieCancel', { episodeId: e.id }))}>Cancel request</button>}
          {e && ['failed', 'interrupted'].includes(e.phase) && <button disabled={pending || !!storageError} onClick={() => run(() => window.stomylos.command('genieRetry', { episodeId: e.id, operationId: crypto.randomUUID() }))}>Retry help</button>}
        </div>
        <div className="genie-composer"><label className="sr-only" htmlFor="genie-followup">Tell Genie more</label>
        <textarea id="genie-followup" ref={followup} value={e?.followup ?? ''} disabled={!e || saving || pending} placeholder="Ask Genie…"
          onChange={event => { if (!e) return; const text = event.target.value;
            if (new TextEncoder().encode(text).length > 8000) { setError(errors.genie_limit); return; }
            const revision = Math.max(followupRevision.current, e.followupRevision) + 1; followupRevision.current = revision;
            receive({ ...snapshot, episode: { ...e, followup: text, followupRevision: revision } });
            run(() => window.stomylos.command('genieDraft', { episodeId: e.id, text, revision }));
          }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.repeat && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); run(submit); } }} />
        <button className="primary icon-button" aria-label="Ask Genie" title="Ask Genie · Enter" disabled={!e?.followup.trim() || e.phase !== 'ready' || pending || changing || !!storageError} onClick={() => run(submit)}><Icon name="send" /></button></div>
      </section></div>
    </Dialog.Content></Dialog.Root>;
}
export function UndoGenie({ sessionId, textarea }: { sessionId: string; textarea: RefObject<HTMLTextAreaElement | null> }) {
  const { undo } = useGenie(), [error, setError] = useState<string | null>(null), draft = currentDraft(sessionId);
  if (!undo || undo.sessionId !== sessionId || draft.text !== undo.text || draft.revision !== undo.revision) return null;
  return <div className="genie-undo"><span className="sr-only" role="status">Suggestion added to your draft.</span><button className="icon-button" aria-label="Undo replacement" title="Undo replacement" disabled={pending} onClick={() => {
    pending = true; notify(); setError(null);
    void window.stomylos.command('genieUndo', { undoId: undo.id, revision: nextDraftRevision(), operationId: crypto.randomUUID() }).then(result => {
      acceptSavedDraft(sessionId, result.text, result.revision); const node = textarea.current;
      node?.focus(); node?.setSelectionRange(displayOffset(result.text, result.range.start), displayOffset(result.text, result.range.end), result.range.direction);
    }).catch(cause => setError(genieError(cause))).finally(() => { pending = false; notify(); });
  }}><Icon name="undo" /></button>{error && <span role="alert">{error}</span>}</div>;
}
