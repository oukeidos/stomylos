import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Coordinator } from '../src/main/coordinator';
import { Store, type StoreMethod } from '../src/main/database';
import type { DatabaseClient } from '../src/main/db-client';
import type { Gateway } from '../src/main/transport';
import { AppFailure } from '../src/main/errors';
import type { GenieRange } from '../src/shared/genie';
const range: GenieRange = { start: 0, end: 0, direction: 'none', scope: 'draft' };
let dir: string, store: Store, c: Coordinator, gateway: Gateway, id: string, fail: string | null, lost: boolean;
let events: any[], complete: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  dir = mkdtempSync('/tmp/stomylos-genie-test-'); store = new Store(dir, resolve('native/advisory-lock.node')); fail = null; lost = false; events = [];
  const db = { ready: Promise.resolve(), call: async (method: StoreMethod, ...args: any[]) => {
    if (fail === method) throw new AppFailure('operation_failed');
    const result = (store[method] as Function).apply(store, args);
    if (lost && method === 'saveDraft') { lost = false; throw new AppFailure('operation_failed'); } return result;
  }, close: async () => store.close() } as unknown as DatabaseClient;
  complete = vi.fn(async () => ({ content: '{"reply":"This works.","suggested_text":"I enjoy walking."}', metadata: { usage: { cost: 0.0001 } } }));
  gateway = { complete, stream: vi.fn() } as unknown as Gateway;
  c = new Coordinator(db, gateway, { keyPresent: true, keyPath: '/test/key', dataPath: dir, appVersion: 'test', development: true }, e => events.push(e), () => true);
  await c.initialize(); id = (await c.snapshot()).unfinished!.id;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
const open = async (text = 'I enjoys walking.', r = range) => {
  await c.command('saveDraft', { sessionId: id, text, revision: 1 });
  await c.command('genieOpen', { sessionId: id, text, revision: 1, range: r, operationId: 'open' });
  await vi.waitFor(() => expect(c.genie.snapshot().episode?.phase).toBe('ready'));
  return c.genie.snapshot().episode!;
};
const saving = async () => vi.waitFor(() => expect(events.some(e => e.snapshot?.activity?.storageError)).toBe(true));
it.each(['starter', 'user'] as const)('uses actual %s context and preserves all non-draft database rows through apply/undo', async kind => {
  if (kind === 'user') await c.command('setOpening', { sessionId: id, kind, operationId: 'opening', expectedRevision: 0 });
  const before = store.view(id); const e = await open();
  const packet = JSON.parse(complete.mock.calls[0][0].messages[1].content);
  expect(packet.main_chat).toEqual(before.messages.map(({ role, content }) => ({ role, content })));
  expect(packet.main_chat).toHaveLength(kind === 'user' ? 0 : 1);
  await c.command('genieApply', { episodeId: e.id, candidateId: e.candidateId!, revision: 2, operationId: 'apply' });
  expect(store.session(id).draft).toBe('I enjoy walking.');
  const applied = store.view(id); expect(applied.messages).toEqual(before.messages); expect(applied.requests).toEqual(before.requests);
  expect(applied.memory).toEqual(before.memory); expect(applied.units).toEqual(before.units); expect(applied.renewal).toEqual(before.renewal);
  await c.command('genieUndo', { undoId: 'apply', revision: 3, operationId: 'undo' }); expect(store.session(id).draft).toBe('I enjoys walking.');
  expect(complete).toHaveBeenCalledTimes(1); await c.command('close', undefined);
});
it('preserves the second repeated phrase range and rejects conflicting main commands even through IPC', async () => {
  const text = 'One same. Second same. End.', start = text.lastIndexOf('same');
  const e = await open(text, { start, end: start + 4, direction: 'forward', scope: 'selection' });
  await expect(c.command('deleteSession', { sessionId: id })).rejects.toThrow('delete_requires_ended');
  expect(c.genie.snapshot().episode?.id).toBe(e.id);
  for (const [name, args] of [['sendMessage', { sessionId: id, text, revision: 1 }], ['setOpening', { sessionId: id, kind: 'user', expectedRevision: 0, operationId: 'op' }],
    ['changePartner', { sessionId: id, character: null, operationId: 'partner', expectedRevision: 0 }], ['useSelectedPartner', { sessionId: id }], ['retryPartnerSelection', { sessionId: id }],
    ['saveDraft', { sessionId: id, text: 'changed', revision: 2 }], ['endSession', { sessionId: id }], ['newSession', undefined], ['asrBegin', { sessionId: id }]] as const) {
    await expect(c.command(name, args as any)).rejects.toThrow('genie_busy');
  }
  await c.command('genieApply', { episodeId: e.id, candidateId: e.candidateId!, revision: 2, operationId: 'apply' });
  expect(store.session(id).draft).toBe('One same. Second I enjoy walking.. End.');
  await c.command('saveDraft', { sessionId: id, text: 'Later edit.', revision: 3 });
  expect(c.genie.snapshot().undo).toBeNull();
  expect(c.genie.snapshot().draftResult).toBeNull();
  await expect(c.command('genieUndo', { undoId: 'apply', revision: 4, operationId: 'undo' })).rejects.toThrow('genie_stale');
});
it.each([false, true])('retries only a failed local apply save (lost acknowledgement: %s)', async lostAck => {
  const e = await open(); if (lostAck) lost = true; else fail = 'saveDraft';
  const applying = c.command('genieApply', { episodeId: e.id, candidateId: e.candidateId!, revision: 2, operationId: 'apply' });
  await saving(); expect(c.genie.snapshot().episode?.phase).toBe('saving');
  await expect(c.command('genieClose', { episodeId: e.id })).rejects.toThrow('save_required');
  expect(complete).toHaveBeenCalledTimes(1); fail = null; await c.command('retrySaving', undefined); await applying;
  expect(store.session(id).draft).toBe('I enjoy walking.'); expect(complete).toHaveBeenCalledTimes(1);
  expect(c.genie.snapshot().episode?.open).toBe(false);
});
it('makes no request during source-save failure and rejects unsaved/stale sources', async () => {
  await expect(c.command('genieOpen', { sessionId: id, text: 'not saved', revision: 1, range, operationId: 'bad' })).rejects.toThrow('genie_stale');
  fail = 'saveDraft'; const save = c.command('saveDraft', { sessionId: id, text: 'Original', revision: 1 }); await saving();
  expect(complete).not.toHaveBeenCalled(); fail = null; await c.command('retrySaving', undefined); await save;
  await expect(c.command('genieOpen', { sessionId: id, text: 'Original', revision: 0, range, operationId: 'bad2' })).rejects.toThrow('genie_stale');
});
it('retains the applied draft across process restart without persisting or dispatching help', async () => {
  const e = await open(); await c.command('genieApply', { episodeId: e.id, candidateId: e.candidateId!, revision: 2, operationId: 'apply' });
  await c.command('close', undefined); store = new Store(dir, resolve('native/advisory-lock.node'));
  expect(store.session(id).draft).toBe('I enjoy walking.'); expect(store.requests(id)).toEqual([]);
  expect(c.genie.snapshot().episode).toBeNull(); expect(complete).toHaveBeenCalledTimes(1);
});
it('detects a changed context and retains the original if Apply is stale', async () => {
  const e = await open(); store.setOpening(id, 'outside', 0, 'user');
  await expect(c.command('genieApply', { episodeId: e.id, candidateId: e.candidateId!, revision: 2, operationId: 'apply' })).rejects.toThrow('genie_stale');
  expect(store.session(id).draft).toBe('I enjoys walking.');
});
