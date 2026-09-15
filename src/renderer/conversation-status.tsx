import type { ReactNode } from 'react';
import type { Activity, SessionView } from '../shared/types';

// Activity and SessionView arrive independently. One status owner handles either
// order; the explicit operation prevents a stale draft from mislabelling Send.
export function conversationProgress(view: SessionView, activity: Activity) {
  const active = activity.sessionId === view.session.id && activity.phase !== 'idle';
  const openerPending = view.session.state === 'draft' && !!view.opener &&
    !view.opener.generated && ['queued', 'dispatched', 'received'].includes(view.opener.status);
  const openerBusy = active ? activity.operation === 'opener' : openerPending;
  let reply: string | null = null;
  if (!openerBusy && view.session.state !== 'ended') {
    if (active) reply = activity.phase === 'routing' ? 'Choosing your conversation partner…'
      : activity.phase === 'preparing' ? 'Preparing your reply…' : 'Writing…';
    else if (view.messages.at(-1)?.delivery === 'streaming') reply = 'Writing…';
  }
  return { openerBusy, reply };
}

export function ConversationStatus({ text }: { text: string | null }) {
  return text ? <p className="conversation-status note" role="status">{text}</p> : null;
}

export function OpenerDock({ busy, failed, children }: { busy: boolean; failed: boolean; children?: ReactNode }) {
  if (!busy && !failed && !children) return null;
  return <div className="starter-dock" aria-label="Conversation starter">
    {busy ? <p className="opener-status" role="status">Thinking…</p>
      : failed ? <p className="opener-status" role="alert">Could not prepare an opener. Use “Give me something” to try again.</p>
      : children}
  </div>;
}
