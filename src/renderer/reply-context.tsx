import { useEffect, useRef, useState } from 'react';
import type { SessionView } from '../shared/types';
import type { ReplyContextView, ReplyMode } from '../shared/reply-context';
import { IconButton } from './icon-button';

export function useReplyContext(view: SessionView, focusInput: () => void) {
  const initial = view.replyContext;
  const [confirmed, setConfirmed] = useState(initial);
  const current = useRef(initial);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const attempt = useRef<{ sessionId: string; operationId: string; expectedRevision: number; mode: ReplyMode } | null>(null);
  const icon = useRef<HTMLButtonElement>(null);
  const bindIcon = useRef((node: HTMLButtonElement | null) => {
    if (!node && icon.current && document.activeElement === icon.current) focusInput();
    icon.current = node;
  }).current;
  const accept = (next: ReplyContextView | undefined) => {
    if (!next || (current.current && (next.revision < current.current.revision || (next.revision === current.current.revision && !current.current.canChange && next.canChange)))) return;
    current.current = next; setConfirmed(next);
  };
  useEffect(() => { accept(view.replyContext); }, [view.replyContext]);
  // The incoming committed state hides the button immediately, without waiting for an effect.
  const editable = !!confirmed?.canChange && !!view.replyContext?.canChange;
  useEffect(() => {
    if (!saving) { setPending(false); return; }
    const timer = setTimeout(() => setPending(true), 500);
    return () => clearTimeout(timer);
  }, [saving]);
  async function persist(retry = false) {
    if (busy.current || !current.current?.canChange || !view.replyContext?.canChange) return;
    if (!retry) attempt.current = { sessionId: view.session.id, operationId: crypto.randomUUID(),
      expectedRevision: current.current.revision, mode: current.current.mode === 'one_point' ? 'standard' : 'one_point' };
    if (!attempt.current) return;
    busy.current = true; setSaving(true); setFailed(false);
    try {
      accept(await window.stomylos.command('setReplyContext', attempt.current)); attempt.current = null;
    } catch {
      setFailed(true);
      try {
        const fresh = await window.stomylos.command('loadSession', { sessionId: view.session.id }); accept(fresh.replyContext);
        if (attempt.current && fresh.replyContext) {
          if (fresh.replyContext.mode === attempt.current.mode) { setFailed(false); attempt.current = null; }
          else if (fresh.replyContext.canChange && fresh.replyContext.revision !== attempt.current.expectedRevision) {
            attempt.current = { ...attempt.current, operationId: crypto.randomUUID(), expectedRevision: fresh.replyContext.revision };
          }
        }
      } catch { /* Keep the last confirmed selection and explicit retry. */ }
    } finally { busy.current = false; setSaving(false); }
  }
  return {
    busy, saving, failed: editable && failed, revision: current.current?.revision,
    control: (disabled: boolean) => editable && <IconButton ref={bindIcon} label="Lighter replies" icon="feather"
      className="reply-context-action" aria-pressed={confirmed?.mode === 'one_point'} aria-busy={pending}
      tooltip="Encourages shorter replies"
      disabled={disabled || saving} onClick={() => void persist()} />,
    recovery: <>{editable && pending && <span className="sr-only" role="status">Saving reply choice…</span>}{editable && failed && <p className="destructive" role="alert">Couldn’t save. Try again. <button disabled={saving} onClick={() => void persist(true)}>Retry</button></p>}</>,
  };
}
