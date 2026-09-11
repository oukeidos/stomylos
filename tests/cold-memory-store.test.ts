import { afterEach, expect, it } from 'vitest';
import { coldFixture, coldSession, receiveNotes } from './cold-memory-fixtures';
import { ColdMemoryStore, coldHash } from '../src/main/cold-memory-store';
import { memoryCharacters } from '../src/main/memory-render';
const fixtures: ReturnType<typeof coldFixture>[] = [];
const fixture = () => { const f = coldFixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

it('archives every evicted original including same-batch additions, preserving source and Unicode FIFO exactly', () => {
  const { store, db } = fixture(), session = coldSession(store);
  const notes = ['🙂'.repeat(2100), 'A repeated idea.', '한'.repeat(2100), 'A repeated idea.'];
  const attempt = receiveNotes(store, notes); store.acceptMemoryAdd(attempt.id); store.acceptMemoryAdd(attempt.id);
  const cold = new ColdMemoryStore(db).page();
  expect(cold.total).toBe(1); expect(cold.items[0].text).toBe(notes[0]);
  expect(cold.items[0]).toMatchObject({ source_session_id: session.id, item_index: 0, time_basis: 'source_message', text_hash: coldHash(notes[0]) });
  const hot = store.memoryManagement().document;
  expect(hot.database_records.map(r => r.text)).toEqual(notes.slice(1));
  expect(memoryCharacters(hot)).toBeLessThanOrEqual(4000);
  expect(db.prepare('SELECT COUNT(*) FROM memory_item_metadata').pluck().get()).toBe(3);
  expect(db.prepare('SELECT COUNT(*) FROM cold_mutations').pluck().get()).toBe(1);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('rolls back raw COLD failure with HOT, provenance and completion, then applies the saved response after restart', () => {
  const f = fixture(); coldSession(f.store);
  const attempt = receiveNotes(f.store, ['old'.repeat(1000), 'new'.repeat(1000)]);
  f.db.exec("CREATE TRIGGER test_cold_failure BEFORE INSERT ON cold_memories BEGIN SELECT RAISE(ABORT,'archive disk failure'); END;");
  expect(() => f.store.acceptMemoryAdd(attempt.id)).toThrow('archive disk failure');
  expect(f.store.currentMemory().revision).toBe(0);
  expect(f.db.prepare('SELECT COUNT(*) FROM memory_item_metadata').pluck().get()).toBe(0);
  expect(f.db.prepare('SELECT COUNT(*) FROM cold_mutations').pluck().get()).toBe(0);
  expect(f.db.prepare('SELECT status FROM memory_add_attempts').pluck().get()).toBe('received');
  f.db.exec('DROP TRIGGER test_cold_failure'); f.reopen();
  expect(f.store.prepareMemoryAdd(attempt.job_id, 'unused').id).toBe(attempt.id);
  f.store.acceptMemoryAdd(attempt.id);
  expect(new ColdMemoryStore(f.db).page().items[0].text).toBe('old'.repeat(1000));
  expect(f.db.prepare('SELECT COUNT(*) FROM memory_add_attempts').pluck().get()).toBe(1);
});

it('retains HOT and COLD provenance after chat deletion and archives a manual edit with its separate time basis', () => {
  const { store, db } = fixture(), session = coldSession(store);
  store.acceptMemoryAdd(receiveNotes(store, ['first'.repeat(500), 'second'.repeat(500)]).id);
  store.end(session.id);
  const view = store.memoryManagement(), item = view.document.database_records[0];
  const edit = { id: item.id, text: 'Manually corrected old detail.', revision: view.document.revision, hash: view.hash };
  store.commitMemoryEdit(store.prepareMemoryEdit(edit));
  const edited = db.prepare('SELECT edited_at FROM memory_item_metadata WHERE id=?').pluck().get(item.id);
  expect(typeof edited).toBe('string');
  store.deleteSession(session.id);
  expect(db.prepare('SELECT source_session_id FROM memory_item_metadata WHERE id=?').pluck().get(item.id)).toBe(session.id);
  expect(new ColdMemoryStore(db).page().items[0].source_session_id).toBe(session.id);
  coldSession(store, 'More information.'); store.acceptMemoryAdd(receiveNotes(store, ['x'.repeat(3998)]).id);
  const archived = new ColdMemoryStore(db).original(item.id)!;
  expect(archived).toMatchObject({ text: edit.text, edited_at: edited, time_basis: 'manual_edit', source_session_id: session.id });
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('explicit HOT deletion creates no archive, records revocation and original rows reject rewriting', () => {
  const { store, db } = fixture(), session = coldSession(store);
  store.acceptMemoryAdd(receiveNotes(store, ['old'.repeat(1000), 'Retain then delete.']).id);
  store.end(session.id);
  const before = store.memoryManagement(), item = before.document.database_records[0];
  store.commitMemoryEdit(store.prepareMemoryEdit({ id: item.id, text: null, revision: before.document.revision, hash: before.hash }));
  expect(new ColdMemoryStore(db).revoked(item.id)).toBe(true);
  expect(new ColdMemoryStore(db).page().total).toBe(0);
  coldSession(store); store.acceptMemoryAdd(receiveNotes(store, ['x'.repeat(3998)]).id);
  expect(() => db.prepare("UPDATE cold_memories SET text='rewritten'").run()).toThrow('immutable COLD original');
  expect(new ColdMemoryStore(db).page('%').items).toEqual([]);
});
it('searches literal Unicode text with NFC and case normalization without changing original bytes',()=>{
  const {store,db}=fixture();coldSession(store);
  const original='Cafe\u0301 100%_ 기억 😃';store.acceptMemoryAdd(receiveNotes(store,[original,'x'.repeat(3998)]).id);
  const cold=new ColdMemoryStore(db),found=cold.page('CAFÉ 100%_');
  expect(found.total).toBe(1);expect(found.items[0].text).toBe(original);expect(found.items[0].text_hash).toBe(coldHash(original));
  expect(cold.page("' OR 1=1").total).toBe(0);
});
