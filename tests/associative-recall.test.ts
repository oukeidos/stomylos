import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { associativeCharacterCap, associativeSimilarityFloor, renderAssociative, selectAssociative, validateAssociative } from '../src/main/associative-recall';
import { conversationBody, conversationSnapshot } from '../src/main/contracts';
import { memoryControlVersion } from '../src/shared/memory-control';
import { timed } from './time-fixtures';
import type { Message } from '../src/shared/types';
import { coldFixture, receiveNotes } from './cold-memory-fixtures';
import { ColdMemoryStore, coldHash } from '../src/main/cold-memory-store';
import { Store } from '../src/main/database';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';

const q = [{ id: 'current-a', vector: [1, 0] }, { id: 'current-b', vector: [0, 1] }];
const candidate = (id: string, text: string, source_order: number, vector: number[]) => ({ id, text, text_hash: createHash('sha256').update(text).digest('hex'), source_order, vector });

it('ranks strictly earlier records by their best current-ADD cosine score without a recency bonus', () => {
  const selected = selectAssociative(q, [
    candidate('old-lower', 'Lower score but earlier.', 1, [associativeSimilarityFloor, 0]),
    candidate('recent-higher', 'Higher score.', 9, [0.9, 0]),
    candidate('other-query', 'Matches second ADD.', 3, [0, 0.85]),
    candidate('current-a', 'Current ADD must not return.', 10, [1, 0])
  ], 4);
  expect(selected.items.map(item => item.id)).toEqual(['recent-higher', 'other-query', 'old-lower']);
  expect(selected.items.some(item => item.id === 'current-a')).toBe(false);
  expect(selected.block).toBe(renderAssociative(selected.items));
  validateAssociative(selected);
});

it('uses source order then ID only for deterministic equal-score ties and keeps an empty low-confidence result', () => {
  const tied = selectAssociative([{ id: 'query', vector: [1, 0] }], [
    candidate('z', 'Z', 2, [0.8, 0]), candidate('a', 'A', 1, [0.8, 0]), candidate('b', 'B', 1, [0.8, 0])
  ], 0);
  expect(tied.items.map(item => item.id)).toEqual(['a', 'b', 'z']);
  const empty = selectAssociative([{ id: 'query', vector: [1, 0] }], [candidate('old', 'Unrelated', 1, [0.1, 0])], 0);
  expect(empty).toMatchObject({ items: [], block: '', reason: 'empty' });
});

it('enforces the separate dynamic character budget instead of enlarging the user message indefinitely', () => {
  const text = 'x'.repeat(associativeCharacterCap);
  const selected = selectAssociative([{ id: 'query', vector: [1, 0] }], [candidate('old', text, 1, [1, 0])], 0);
  expect(selected.items).toEqual([]);
});

it('keeps the standard system/alternating/final-user wire shape and places recall only in final user content', () => {
  const message: Message = { id: 'u', session_id: 's', sequence: 0, role: 'user', origin: 'learner', delivery: 'complete', request_id: null, content: 'Tell me about hiking.' };
  const snapshot = conversationSnapshot('user');
  snapshot.memory_control = memoryControlVersion;
  const selection = selectAssociative([{ id: 'query', vector: [1, 0] }], [candidate('old', 'The user enjoyed a mountain hike.', 1, [1, 0])], 1);
  snapshot.associative_recall = selection;
  for (const partner of snapshot.characters as { id: string }[]) {
    const body = conversationBody(timed(snapshot, [message]), partner.id, null, [message]);
    expect(body.messages.map((item: any) => item.role)).toEqual(['system', 'user']);
    expect(body.messages[1].content).toBe(message.content + selection.block);
    expect(body.messages[0].content).toContain('associative_recall');
  }
});

it('indexes accepted HOT ADD records and retrieves an earlier COLD record outside the frozen session snapshot', () => {
  const fixture = coldFixture();
  try {
    const store = fixture.store; store.coldInitialize();
    const index = () => {
      store.associativeTick(); const job = store.associativeClaim(); expect(job).not.toBeNull();
      const vector = Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0);
      store.associativeComplete(job!, { vector, inputHash: coldHash(job!.text), chunkCount: 1 });
    };
    const session = store.createSession(); store.searchMode(session.id, 'off'); store.selectManual(session.id, 'model_04');
    const first = store.submit(session.id, 'I enjoyed a mountain hike.', 'first'); store.commitRoute(session.id, null, 'fixture', null);
    expect(store.admitAssociativeMemory(session.id, first.id)).toBe(true);
    const firstAttempt = receiveNotes(store, ['The user enjoyed a mountain hike.']); store.acceptMemoryAdd(firstAttempt.id); index();
    const firstChat = store.startChat(store.prepareChat(session.id, 'first-chat').id); store.finishReply(firstChat.request.id, firstChat.bubble.id, 'That sounds lovely.', {});
    fixture.db.transaction(() => {
      fixture.db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin) VALUES('cold-old',0,0,'legacy')").run();
      new ColdMemoryStore(fixture.db).archive([{ id: 'cold-old', text: 'The user enjoyed mountain hiking.' }]);
      fixture.db.prepare("DELETE FROM memory_item_metadata WHERE id='cold-old'").run();
    })();
    index();
    const second = store.submit(session.id, 'I want to hike again.', 'second');
    const secondAttempt = receiveNotes(store, ['The user wants to hike again.']); store.acceptMemoryAdd(secondAttempt.id); index();
    const selection = store.associativeForMessage(session.id, second.id)!;
    expect(selection.items.map(item => item.text)).toEqual(['The user enjoyed mountain hiking.']);
  } finally { fixture.close(); }
});

it('migrates a schema-32 database to the additive associative index without changing existing memory rows', () => {
  const fixture = coldFixture();
  let upgraded: Store | null = null;
  try {
    const before = fixture.db.prepare('SELECT document,document_hash FROM shared_memory').get();
    fixture.store.close();
    fixture.db.exec('DROP INDEX associative_embedding_queue; DROP TABLE associative_embeddings; PRAGMA user_version=32;'); fixture.db.close();
    upgraded = new Store(fixture.directory, resolve('native/advisory-lock.node'));
    expect(upgraded.integrity()).toEqual({ integrity: [{ integrity_check: 'ok' }], foreignKeys: [] });
    const verify = new Database(resolve(fixture.directory, 'stomylos.sqlite3'));
    try {
      expect(verify.pragma('user_version', { simple: true })).toBe(33);
      expect(verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='associative_embeddings'").pluck().get()).toBe('associative_embeddings');
      expect(verify.prepare('SELECT document,document_hash FROM shared_memory').get()).toEqual(before);
    } finally { verify.close(); }
  } finally {
    upgraded?.close(); rmSync(fixture.directory, { recursive: true, force: true });
  }
});
