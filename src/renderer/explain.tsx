import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { ExplainRecord, ExplainTarget } from '../shared/explain';
import type { Message } from '../shared/types';
import { Icon } from './icons';
import { useGenie, genieBusy } from './genie';
import { captureExplainSelection } from './explain-selection';
let records = new Map<string, ExplainRecord>(), version = 0;
let opened: { sessionId: string; messageId: string; id: string | null; selected: string; origin: HTMLElement | null; token: number; target: ExplainTarget | { sessionId: string; messageId: string } } | null = null;
let error: string | null = null, busy = false, serial = 0;
const listeners = new Set<() => void>();
const notify = () => { version++; listeners.forEach(f => f()); };
function receive(record: ExplainRecord) { if ((records.get(record.id)?.revision ?? -1) > record.revision) return; records.set(record.id, record); notify(); }
window.stomylos.subscribe(event => {
  if (event.type === 'explain') receive(event.record);
  if (event.type === 'session-deleted') { records = new Map([...records].filter(([, r]) => r.session_id !== event.sessionId)); if (opened?.sessionId === event.sessionId) opened = null; notify(); }
});
function useExplain() { useSyncExternalStore(f => { listeners.add(f); return () => { listeners.delete(f); }; }, () => version); }
function fail(cause: unknown) {
  const code = cause instanceof Error ? cause.message : '';
  return code.includes('api_key_missing') ? 'Add your API key in Settings.' : code.includes('genie_busy') ? 'Close Genie first.' : code.includes('stale') || code.includes('selection') ? 'Select the text again.' : 'Could not get the explanation. Please try again.';
}
async function open(target: ExplainTarget | { sessionId: string; messageId: string }, origin: HTMLElement | null) {
  if (genieBusy()) return;
  const token = ++serial; opened = { ...target, id: null, selected: 'source' in target ? target.source.slice(target.start, target.end) : '', origin, token, target }; error = null; busy = true; notify();
  try {
    if ('source' in target) {
      const record = await window.stomylos.command('explainOpen', target); receive(record);
      if (opened?.token === token) opened.id = record.id;
    } else {
      const found = await window.stomylos.command('explainHistory', target); found.forEach(receive);
      if (opened?.token === token && found.length === 1) opened.id = found[0].id;
    }
  } catch (cause) { if (opened?.token === token) error = fail(cause); }
  finally { if (opened?.token === token) { busy = false; notify(); } }
}
export function ExplainHistory({ message }: { message: Message }) {
  useExplain(); const genie = useGenie();
  const found = [...records.values()].some(r => r.message_id === message.id);
  return found ? <button className="icon-button" aria-label="Past explanations" title="Past explanations" disabled={genie.locked}
    onClick={e => void open({ sessionId: message.session_id, messageId: message.id }, e.currentTarget)}><Icon name="explain" /></button> : null;
}
export function Explainable({ message, children }: { message: Message; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState<ReturnType<typeof captureExplainSelection>>(null); const genie = useGenie(); useExplain();
  const enabled = message.delivery === 'complete' && !genie.locked && !opened;
  useEffect(() => {
    const capture = () => { if (document.activeElement === button.current) return; setSelection(enabled && ref.current ? captureExplainSelection(ref.current, message.content) : null); };
    document.addEventListener('selectionchange', capture); document.addEventListener('scroll', capture, true); window.addEventListener('resize', capture);
    capture(); return () => { document.removeEventListener('selectionchange', capture); document.removeEventListener('scroll', capture, true); window.removeEventListener('resize', capture); };
  }, [enabled, message.content]);
  const activate = (origin: HTMLElement | null) => {
    const current = ref.current ? captureExplainSelection(ref.current, message.content) : null;
    const chosen = current ?? (document.activeElement === button.current ? selection : null);
    if (!chosen || !enabled) return;
    void open({ sessionId: message.session_id, messageId: message.id, source: message.content, start: chosen.start, end: chosen.end }, origin);
    setSelection(null);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.altKey && event.key.toLowerCase() === 'e' && !event.isComposing && selection && enabled) { event.preventDefault(); activate(ref.current); } };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  });
  return <div className="explainable" ref={ref} tabIndex={0} aria-label="Reply text. Select with Shift and arrow keys, then press Alt+E to explain."
    onKeyDown={event => {
      if (event.target !== ref.current || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const node = ref.current!, sel = window.getSelection(); if (!sel) return;
      if (!sel.anchorNode || !node.contains(sel.anchorNode)) { const first = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode(); if (!first) return; sel.setPosition(first, 0); }
      event.preventDefault();
      const direction = ['ArrowLeft', 'ArrowUp', 'Home'].includes(event.key) ? 'backward' : 'forward';
      const unit = ['Home','End'].includes(event.key) ? 'lineboundary' : ['ArrowUp','ArrowDown'].includes(event.key) ? 'line' : event.ctrlKey || event.metaKey ? 'word' : 'character';
      (sel as Selection & { modify(a: string, b: string, c: string): void }).modify(event.shiftKey ? 'extend' : 'move', direction, unit);
    }}>{children}{selection && enabled && <button ref={button} className="icon-button explain-selection" aria-label="Explain" title="Explain · Alt+E"
    style={{ left: Math.max(8, Math.min(window.innerWidth - 44, selection.rect.right + 4)), top: Math.max(8, Math.min(window.innerHeight - 44, selection.rect.bottom + 4)) }}
    onPointerDown={event => event.preventDefault()} onClick={event => activate(ref.current)}><Icon name="explain" /></button>}</div>;
}
export function ExplainDialog({ sessionId }: { sessionId: string | null }) {
  useExplain(); const fallback = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    void window.stomylos.command('explainList', { sessionId }).then(found => { if (active) found.forEach(receive); }).catch(() => undefined);
    return () => { active = false; };
  }, [sessionId]);
  const record = opened?.id ? records.get(opened.id) : null;
  const choices = [...records.values()].filter(r => r.message_id === opened?.messageId);
  const close = () => { const origin = opened?.origin; opened = null; serial++; busy = false; notify(); void window.stomylos.command('explainClose', undefined).catch(() => undefined);
    requestAnimationFrame(() => { if (origin?.isConnected) origin.focus({ preventScroll: true }); else document.querySelector<HTMLElement>('[data-explain-return]')?.focus({ preventScroll: true }); }); };
  const retry = async () => {
    if (!record) return; const id = record.id; busy = true; error = null; notify();
    try { receive(await window.stomylos.command('explainRetry', { id })); } catch (cause) { error = fail(cause); } finally { busy = false; notify(); }
  };
  return <Dialog.Root open={!!opened} onOpenChange={value => { if (!value) close(); }}><Dialog.Portal><Dialog.Overlay className="modal-overlay" />
    <Dialog.Content className="dialog explain-dialog" aria-describedby="explain-description" onCloseAutoFocus={e => e.preventDefault()}>
      <div className="dialog-heading"><Dialog.Title>Explain</Dialog.Title><button ref={fallback} className="icon-button" aria-label="Close explanation" title="Close" onClick={close}><Icon name="close" /></button></div>
      <Dialog.Description id="explain-description" className="sr-only">The selected text in easy English.</Dialog.Description>
      {record || opened?.selected ? <>
        {choices.length > 1 && <button className="explain-back" onClick={() => { if (opened) { opened.id = null; opened.selected = ''; notify(); } }}>Past explanations</button>}
        <blockquote className="explain-source">{record?.source.selected_text ?? opened?.selected}</blockquote>
        {record?.content && <div className="explain-meaning">{record.content}</div>}
        {(busy || record?.state === 'pending') && <p role="status" className="note">Thinking…</p>}
        {(record?.state === 'failed' || record?.state === 'interrupted' || record?.state === 'unsaved') && <div className="explain-error"><p role="alert">{record.state === 'unsaved' ? "Couldn't save this explanation." : record.state === 'interrupted' ? 'This explanation was interrupted.' : 'Could not get the explanation.'}</p>
          <button disabled={busy} className="icon-button" aria-label={record.state === 'unsaved' ? 'Retry saving explanation' : 'Retry explanation'} title={record.state === 'unsaved' ? 'Retry saving' : 'Try again'} onClick={() => void retry()}><Icon name="refresh" /></button></div>}
      </> : <div className="explain-list">{busy ? <p role="status">Loading…</p> : choices.length ? choices.map(r => <button key={r.id} onClick={() => { if (opened) { opened.id = r.id; notify(); } }}><span>{r.source.selected_text}</span>{r.state === 'pending' && <small>Thinking…</small>}</button>) : <p>No explanations yet.</p>}</div>}
      {error && <div className="explain-error"><p role="alert" className="draft-error">{error}</p>{!record && <button className="icon-button" aria-label="Retry explanation" title="Try again" disabled={busy} onClick={() => { if (opened) void open(opened.target, opened.origin); }}><Icon name="refresh" /></button>}</div>}
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
