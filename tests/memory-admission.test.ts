import { expect, it } from 'vitest';
import { coldFixture, receiveNotes } from './cold-memory-fixtures';
import { coldHash } from '../src/main/cold-memory-store';

function start(f: ReturnType<typeof coldFixture>) {
  const session = f.store.createSession();
  f.store.searchMode(session.id, 'off'); f.store.selectManual(session.id, 'model_04');
  const message = f.store.submit(session.id, 'I like hiking.');
  expect(f.store.memoryAddReady()).toBeNull();
  f.store.commitRoute(session.id, null, 'fixture', null);
  expect(f.store.admitAssociativeMemory(session.id, message.id)).toBe(true);
  return { session, message };
}
it('freezes HOT and COLD before current ADD even when query indexing is not ready', () => {
  const f = coldFixture();
  try {
    const { session, message } = start(f);
    const baseline = f.store.view(session.id).memory.snapshot;
    const cold = f.db.prepare('SELECT selection FROM session_cold_recollections WHERE session_id=?').get(session.id);
    const add = receiveNotes(f.store, ['CURRENT_NOTE_SENTINEL']); f.store.acceptMemoryAdd(add.id);
    expect(JSON.stringify(f.store.currentMemory())).toContain('CURRENT_NOTE_SENTINEL');
    expect(f.store.associativeForMessage(session.id, message.id)).toBeNull();
    expect(f.store.view(session.id).memory.snapshot).toEqual(baseline);
    expect(f.db.prepare('SELECT selection FROM session_cold_recollections WHERE session_id=?').get(session.id)).toEqual(cold);
    const request = f.store.startChat(f.store.prepareChat(session.id, 'reply').id);
    expect(JSON.stringify(request.body)).not.toContain('CURRENT_NOTE_SENTINEL');
    expect(f.store.view(session.id).memoryPolicy?.firstEnabled).toBe(true);
  } finally { f.close(); }
});
it.each([false, true])('keeps an Off-first reply without memory after On, including old premature policy=%s', premature => {
  const f = coldFixture();
  try {
    const { session } = start(f);
    const add = receiveNotes(f.store, ['CURRENT_NOTE_SENTINEL']); f.store.acceptMemoryAdd(add.id);
    if (premature) f.db.prepare('INSERT INTO session_memory_policy VALUES(?,?,?)').run(session.id, 1, 0);
    expect(f.store.view(session.id).memoryPolicy?.firstEnabled).toBeNull();
    const q = f.store.prepareChat(session.id, 'first');
    f.store.setMemoryPreference(false, 0);
    const first = f.store.startChat(q.id);
    expect(JSON.parse(first.request.config).memory_context).toBeUndefined();
    f.store.finishReply(first.request.id, first.bubble.id, 'Hello', {});
    expect(f.store.view(session.id).memoryPolicy?.firstEnabled).toBe(false);
    f.store.setMemoryPreference(true, 1); f.store.submit(session.id, 'More thoughts.');
    const second = f.store.startChat(f.store.prepareChat(session.id, 'second').id);
    expect(JSON.parse(second.request.config).memory_context).toBeUndefined();
    expect(f.store.memoryAddReady()).toBeNull();
  } finally { f.close(); }
});
it('retries an unsent first reply with Memory Off without reusing its old memory settings', () => {
  const f = coldFixture();
  try {
    const { session } = start(f);
    const q = f.store.prepareChat(session.id, 'first');
    f.db.prepare('INSERT INTO session_memory_policy VALUES(?,?,?)').run(session.id, 1, 0);
    f.store.failRequest(q.id, 'queued_not_dispatched'); f.store.setMemoryPreference(false, 0);
    const retry = f.store.prepareChat(session.id, 'retry', 'retry');
    expect(retry.parent_id).toBeNull(); expect(JSON.parse(retry.config).memory_context).toBeUndefined();
    f.store.startChat(retry.id); expect(f.store.request(q.id).dispatched_at).toBeNull();
    expect(f.store.request(q.id).config).toBe(q.config);
  } finally { f.close(); }
});
it('excludes duplicate query/supplied text and deduplicates recall across different IDs', () => {
  const f = coldFixture();
  try {
    f.store.coldInitialize(); const { session } = start(f);
    const add = receiveNotes(f.store, ['Repeated hiking note', 'Repeated hiking note', 'Different note']);
    f.store.acceptMemoryAdd(add.id); f.store.associativeTick();
    const vector = Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0);
    let job;
    while ((job = f.store.associativeClaim())) f.store.associativeComplete(job, { vector, inputHash: coldHash(job.text), chunkCount: 1 });
    const all = f.store.associativeSelection([{ id: 'future-query', vector }], 999, []);
    expect(all.items.map(item => item.text)).toEqual(['Repeated hiking note', 'Different note']);
    const duplicate = f.store.associativeSelection([{ id: 'future-query', vector }], 999, [all.items[0].id]);
    expect(duplicate.items.map(item => item.text)).toEqual(['Different note']);
    const queryDuplicate = f.store.associativeSelection([{ id: all.items[0].id, vector }], 999, []);
    expect(queryDuplicate.items.map(item => item.text)).toEqual(['Different note']);
    f.store.startChat(f.store.prepareChat(session.id, 'first').id);
  } finally { f.close(); }
});
