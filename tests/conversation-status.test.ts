import { expect, it } from 'vitest';
import { conversationProgress } from '../src/renderer/conversation-status';
import type { Activity, SessionView } from '../src/shared/types';

const view = (patch: Partial<SessionView> = {}) => ({
  session: { id: 's', state: 'active' }, messages: [], ...patch
} as SessionView);
const activity = (patch: Partial<Activity> = {}): Activity => ({
  sessionId: 's', operation: 'reply', phase: 'preparing', requestId: null,
  streamingMessageId: null, streamingText: '', storageError: null, error: null, closing: false, ...patch
});

it('keeps one reply status across either order of phase and message refresh', () => {
  const streaming = view({ messages: [{ delivery: 'streaming', origin: 'model' }] as SessionView['messages'] });
  for (const current of [view(), streaming]) {
    expect(conversationProgress(current, activity()).reply).toBe('Preparing your reply…');
    expect(conversationProgress(current, activity({ phase: 'routing' })).reply).toBe('Choosing your conversation partner…');
    expect(conversationProgress(current, activity({ phase: 'reply' })).reply).toBe('Writing…');
  }
  expect(conversationProgress(streaming, activity({ phase: 'idle' })).reply).toBe('Writing…');
  expect(conversationProgress(view(), activity({ phase: 'idle' })).reply).toBeNull();
});

it('identifies opener activity before its view arrives and never calls Send opener work', () => {
  const staleDraft = view({ session: { id: 's', state: 'draft' } as SessionView['session'],
    opener: { status: 'empty', generated: false, failure: null } });
  expect(conversationProgress(staleDraft, activity({ operation: 'opener' }))).toEqual({ openerBusy: true, reply: null });
  for (const status of ['empty', 'dispatched', 'succeeded']) {
    staleDraft.opener!.status = status;
    expect(conversationProgress(staleDraft, activity())).toEqual({ openerBusy: false, reply: 'Preparing your reply…' });
  }
});

it('keeps opener progress through delayed snapshots and clears it for result or failure', () => {
  const draft = view({ session: { id: 's', state: 'draft' } as SessionView['session'],
    opener: { status: 'dispatched', generated: false, failure: null } });
  expect(conversationProgress(draft, activity({ phase: 'idle' }))).toEqual({ openerBusy: true, reply: null });
  draft.opener = { status: 'failed', generated: false, failure: 'timeout' };
  expect(conversationProgress(draft, activity({ phase: 'idle' }))).toEqual({ openerBusy: false, reply: null });
  draft.opener = { status: 'succeeded', generated: true, failure: null };
  expect(conversationProgress(draft, activity({ phase: 'idle' }))).toEqual({ openerBusy: false, reply: null });
});

it('does not leak other-session or ended progress', () => {
  expect(conversationProgress(view(), activity({ sessionId: 'other', operation: 'opener' }))).toEqual({ openerBusy: false, reply: null });
  const ended = view({ session: { id: 's', state: 'ended' } as SessionView['session'] });
  expect(conversationProgress(ended, activity()).reply).toBeNull();
});
