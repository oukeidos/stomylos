import { expect, it } from 'vitest';
import { coldFixture, coldSession, receiveNotes } from './cold-memory-fixtures';
import { ColdMemoryStore } from '../src/main/cold-memory-store';
import { matchingMemories, memoryDisplayRecords } from '../src/shared/memory-management';

it('shows Recent newest input first, preserves batch order through search and edits, and leaves canonical memory unchanged', () => {
  const f = coldFixture();
  try {
    const { store, db } = f;
    const session = coldSession(store);
    store.acceptMemoryAdd(receiveNotes(store, ['Old match first.', 'Old second.']).id);
    store.submit(session.id, 'Another detail.', 'second');
    store.acceptMemoryAdd(receiveNotes(store, ['New first.', 'New match second.']).id);
    const before = db.prepare('SELECT document,document_hash FROM shared_memory').get();
    const view = store.memoryManagement();
    const text = (items: { text: string }[]) => items.map(item => item.text);
    expect(text(memoryDisplayRecords(view))).toEqual(['New first.', 'New match second.', 'Old match first.', 'Old second.']);
    expect(text(matchingMemories(memoryDisplayRecords(view), 'match'))).toEqual(['New match second.', 'Old match first.']);
    expect(text(view.document.database_records)).toEqual(['Old match first.', 'Old second.', 'New first.', 'New match second.']);
    expect(db.prepare('SELECT document,document_hash FROM shared_memory').get()).toEqual(before);
    store.end(session.id);
    const item = view.document.database_records[0];
    const edited = store.commitMemoryEdit(store.prepareMemoryEdit({ id: item.id, text: 'Edited old match.', revision: view.document.revision, hash: view.hash }));
    expect(edited.displayOrder).toEqual(view.displayOrder);
    expect(text(memoryDisplayRecords(edited))).toEqual(['New first.', 'New match second.', 'Edited old match.', 'Old second.']);
    expect(edited.document.database_records[0].id).toBe(item.id);
  } finally { f.close(); }
});

it('orders Older by original input and batch position before paging and searching, independent of archival and edit times', () => {
  const f = coldFixture();
  try {
    const cold = new ColdMemoryStore(f.db);
    const records = [
      { id: 'z-new', source: 3, index: 0, text: 'New first.' },
      { id: 'a-new', source: 3, index: 1, text: 'New target second.' },
      { id: 'z-old', source: 1, index: 0, text: 'Old target first.' },
      { id: 'a-old', source: 1, index: 1, text: 'Old second.' },
      { id: 'z-mid', source: 2, index: 0, text: 'Middle target first.' },
      { id: 'a-mid', source: 2, index: 1, text: 'Middle second.' }
    ];
    f.db.transaction(() => {
      for (const item of records) {
        f.db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin,edited_at) VALUES(?,?,?,'manual',?)")
          .run(item.id, item.source, item.index, item.source === 1 ? '2026-09-13T00:00:00Z' : '2026-09-12T00:00:00Z');
        cold.archive([item]);
        f.db.prepare('DELETE FROM memory_item_metadata WHERE id=?').run(item.id);
      }
    })();
    const first = cold.page('', 0, 3), second = cold.page('', first.next!, 3);
    expect(first.items.map(item => item.id)).toEqual(['z-new', 'a-new', 'z-mid']);
    expect(second.items.map(item => item.id)).toEqual(['a-mid', 'z-old', 'a-old']);
    expect(second.next).toBeNull();
    const found = cold.page('target', 0, 2);
    expect(found.total).toBe(3);
    expect(found.items.map(item => item.id)).toEqual(['a-new', 'z-mid']);
    expect(cold.page('target', found.next!, 2).items.map(item => item.id)).toEqual(['z-old']);
  } finally { f.close(); }
});
