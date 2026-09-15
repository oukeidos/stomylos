import { expect, it } from 'vitest';
import { coldFixture } from './cold-memory-fixtures';
import { memoryJson, memoryHash } from '../src/main/memory-updater';
import { ColdMemoryStore } from '../src/main/cold-memory-store';
import { matchingMemories, memoryDisplayRecords } from '../src/shared/memory-management';

it('shows Recent newest input first, shows later batch items first through search and edits, and leaves canonical memory unchanged', () => {
  const f = coldFixture();
  try {
    const { store, db } = f;
    // Seed display provenance directly, independent of retired partners/ADD timing.
    const document = store.memoryManagement().document;
    document.database_records = ['Old match first.', 'Old second.', 'New first.', 'New match second.']
      .map((text, index) => ({ id: 'display-' + index, text }));
    const encoded = memoryJson(document);
    db.transaction(() => {
      db.prepare('UPDATE shared_memory SET document=?,document_hash=? WHERE id=1').run(encoded, memoryHash(encoded));
      document.database_records.forEach((item, index) => db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin) VALUES(?,?,?,'legacy')")
        .run(item.id, Math.floor(index / 2) + 1, index % 2));
    })();
    const before = db.prepare('SELECT document,document_hash FROM shared_memory').get();
    const view = store.memoryManagement();
    const text = (items: { text: string }[]) => items.map(item => item.text);
    expect(text(memoryDisplayRecords(view))).toEqual(['New match second.', 'New first.', 'Old second.', 'Old match first.']);
    expect(text(matchingMemories(memoryDisplayRecords(view), 'match'))).toEqual(['New match second.', 'Old match first.']);
    expect(text(view.document.database_records)).toEqual(['Old match first.', 'Old second.', 'New first.', 'New match second.']);
    expect(db.prepare('SELECT document,document_hash FROM shared_memory').get()).toEqual(before);
    const item = view.document.database_records[0];
    const edited = store.commitMemoryEdit(store.prepareMemoryEdit({ id: item.id, text: 'Edited old match.', revision: view.document.revision, hash: view.hash }));
    expect(edited.displayOrder).toEqual(view.displayOrder);
    expect(text(memoryDisplayRecords(edited))).toEqual(['New match second.', 'New first.', 'Old second.', 'Edited old match.']);
    expect(edited.document.database_records[0].id).toBe(item.id);
  } finally { f.close(); }
});

it('orders Older by descending original input and batch position before paging and searching, independent of archival and edit times', () => {
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
    expect(first.items.map(item => item.id)).toEqual(['a-new', 'z-new', 'a-mid']);
    expect(second.items.map(item => item.id)).toEqual(['z-mid', 'a-old', 'z-old']);
    expect(second.next).toBeNull();
    const found = cold.page('target', 0, 2);
    expect(found.total).toBe(3);
    expect(found.items.map(item => item.id)).toEqual(['a-new', 'z-mid']);
    expect(cold.page('target', found.next!, 2).items.map(item => item.id)).toEqual(['z-old']);
  } finally { f.close(); }
});
