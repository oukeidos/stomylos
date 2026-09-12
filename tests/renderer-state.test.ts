import { beforeEach, expect, it, vi } from 'vitest';
import type { AppEvent, AppSnapshot, DesktopApi } from '../src/shared/types';
vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get() }));
let receive: (event: AppEvent) => void; let command: ReturnType<typeof vi.fn>;
const snapshot = (revision: number) => ({ revision, activity: {}, sessions: [] } as unknown as AppSnapshot);
beforeEach(() => {
  vi.resetModules(); command = vi.fn().mockResolvedValue(snapshot(0));
  const api = { command, subscribe(listener: (event: AppEvent) => void) { receive = listener; return () => {}; } } as unknown as DesktopApi;
  vi.stubGlobal('window', { stomylos: api }); vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
});
it('does not let late snapshot or stream events replace newer visible text', async () => {
  const client = await import('../src/renderer/client'); await Promise.resolve();
  receive({ type: 'snapshot', snapshot: snapshot(10) }); receive({ type: 'snapshot', snapshot: snapshot(2) });
  expect(client.useApp()?.revision).toBe(10);
  const stream = (revision: number, text: string) => receive({ type: 'stream', revision, sessionId: 's', requestId: 'r', messageId: 'm', text });
  stream(12, 'Newer text'); stream(11, 'Older text');
  expect(client.useStream('m', '', true)).toBe('Newer text');
  receive({ type: 'snapshot', snapshot: { ...snapshot(11), activity: { streamingMessageId: 'm', streamingText: 'Older snapshot text' } } as AppSnapshot });
  expect(client.useStream('m', '', true)).toBe('Newer text');
});
it('refetches an in-flight view invalidated by a newer commit instead of caching stale rows', async () => {
  const client = await import('../src/renderer/client'); await Promise.resolve();
  let complete!: (value: unknown) => void;
  command.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const pending = client.loadView('s'); receive({ type: 'session-changed', sessionId: 's', revision: 4 });
  const fresh = { session: { id: 's', draft: 'Fresh text' }, messages: [], requests: [], units: [] };
  command.mockResolvedValueOnce(fresh); complete({ session: { id: 's', draft: 'Stale text' } });
  expect(await pending).toEqual(fresh); expect(await client.loadView('s')).toEqual(fresh);
});
it('keeps a newer edit unsaved when an older draft acknowledgement arrives', async () => {
  const drafts = await import('../src/renderer/drafts'); drafts.initializeDraft('s', ''); drafts.editDraft('s', 'First');
  let acknowledge!: (value: unknown) => void;
  command.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
  const pending = drafts.flushDraft('s'); const first = drafts.currentDraft('s').revision;
  drafts.editDraft('s', 'Newer'); acknowledge({ revision: first }); await pending;
  expect(drafts.currentDraft('s').text).toBe('Newer');
  expect(drafts.currentDraft('s').saved).toBe(first); expect(drafts.currentDraft('s').revision).toBeGreaterThan(first);
  drafts.submittedDraft('s', first); expect(drafts.currentDraft('s').text).toBe('Newer');
});

it('refreshes every cached model view after a shared memory update', async () => {
  const client = await import('../src/renderer/client'); await Promise.resolve();
  const a = { session: { id: 'a', character: 'model_04' }, memory: { current: { revision: 0 } } };
  const b = { session: { id: 'b', character: 'model_03' }, memory: { current: { revision: 0 } } };
  command.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
  await client.loadView('a'); await client.loadView('b');
  const changed = vi.fn(); client.onViewChanged(changed);
  receive({ type: 'memory-changed', characterId: 'model_04', revision: 5 });
  const fresh = { ...a, memory: { current: { revision: 1 } } }, other = { ...b, memory: fresh.memory }; command.mockResolvedValueOnce(fresh).mockResolvedValueOnce(other);
  expect(await client.loadView('a')).toEqual(fresh); expect(await client.loadView('b')).toEqual(other);
  expect(changed.mock.calls).toEqual([['a'], ['b']]);
});

it('refreshes a completed reply after a memory indexing notification', async () => {
  const client = await import('../src/renderer/client'); await Promise.resolve();
  const { Coordinator } = await import('../src/main/coordinator');
  const controller = new Coordinator({} as any, {} as any, {} as any, receive, () => false);
  const pending = { session: { id: 's' }, messages: [{ role: 'user', content: 'Hello' }] };
  command.mockResolvedValueOnce(pending);
  await client.loadView('s');
  controller.memoryIndexChanged();
  command.mockResolvedValueOnce(pending);
  await client.loadView('s');
  const revision = (controller as unknown as { revision: number }).revision;
  receive({ type: 'session-changed', sessionId: 's', revision: revision + 1 });
  const completed = { ...pending, messages: [...pending.messages, { role: 'assistant', content: 'Hello back' }] };
  command.mockResolvedValueOnce(completed);
  expect(await client.loadView('s')).toEqual(completed);
  expect(revision).toBe(1);
});

it('discards a late view and draft acknowledgement after deleting their chat', async () => {
  const client = await import('../src/renderer/client'); const drafts = await import('../src/renderer/drafts'); await Promise.resolve();
  let finishView!: (value: unknown) => void, finishDraft!: (value: unknown) => void;
  command.mockImplementationOnce(() => new Promise(resolve => { finishView = resolve; }));
  const view = client.loadView('s'); const rejected = expect(view).rejects.toThrow('session_not_found');
  drafts.initializeDraft('s', ''); drafts.editDraft('s', 'Private draft');
  command.mockImplementationOnce(() => new Promise(resolve => { finishDraft = resolve; }));
  const save = drafts.flushDraft('s');
  receive({ type: 'session-deleted', sessionId: 's', revision: 7 }); drafts.forgetDraft('s');
  finishView({ session: { id: 's' }, messages: [] }); finishDraft({ revision: 1 });
  await rejected; await save; expect(drafts.currentDraft('s')).toBeUndefined();
  await expect(client.loadView('s')).rejects.toThrow('session_not_found');
});

it('ends and starts a new chat once after blocking end jobs finish', async () => {
  const client = await import('../src/renderer/client'); await Promise.resolve();
  command.mockImplementation(async (name: string) => {
    if (name === 'snapshot') return { ...snapshot(1), endBlocker: 'old', unfinished: null };
    if (name === 'newSession') return 'new';
  });
  const pending = client.endAndStartSession('old');
  expect(client.endAndStartSession('old')).toBe(pending);
  await vi.waitFor(() => expect(client.useApp()?.endBlocker).toBe('old'));
  expect(command.mock.calls.filter(([name]) => name === 'newSession')).toHaveLength(0);
  // A failed job remains blocking until retry or explicit cancellation resolves it.
  receive({ type: 'snapshot', snapshot: { ...snapshot(2), endBlocker: 'old', unfinished: null } });
  expect(command.mock.calls.filter(([name]) => name === 'newSession')).toHaveLength(0);
  receive({ type: 'snapshot', snapshot: { ...snapshot(3), endBlocker: null, unfinished: null } });
  expect(await pending).toBe('new');
  expect(command.mock.calls.filter(([name]) => name === 'endSession')).toEqual([['endSession', { sessionId: 'old' }]]);
  expect(command.mock.calls.filter(([name]) => name === 'newSession')).toHaveLength(1);
});

it('starts a new chat when ending finishes without blocking jobs', async () => {
  const client = await import('../src/renderer/client'); await Promise.resolve();
  command.mockImplementation(async (name: string) => name === 'snapshot'
    ? { ...snapshot(1), endBlocker: null, unfinished: null } : name === 'newSession' ? 'new' : undefined);
  expect(await client.endAndStartSession('old')).toBe('new');
});

it('does not start a new chat when ending fails and allows an explicit retry', async () => {
  const client = await import('../src/renderer/client'); await Promise.resolve();
  command.mockRejectedValueOnce(new Error('storage_error'));
  await expect(client.endAndStartSession('old')).rejects.toThrow('storage_error');
  expect(command.mock.calls.some(([name]) => name === 'newSession')).toBe(false);
  command.mockImplementation(async (name: string) => name === 'snapshot'
    ? { ...snapshot(1), endBlocker: null, unfinished: null } : name === 'newSession' ? 'new' : undefined);
  expect(await client.endAndStartSession('old')).toBe('new');
});
