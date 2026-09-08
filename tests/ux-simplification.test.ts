import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { validateCommand } from '../src/main/ipc';
import { maintenanceNotices } from '../src/renderer/maintenance';
import type { SessionView } from '../src/shared/types';

let directory: string | undefined, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });
function open() {
  directory = mkdtempSync('/tmp/stomylos-ux-unit-'); store = new Store(directory, resolve('native/advisory-lock.node'));
  return new Database(join(directory, 'stomylos.sqlite3'));
}
function rows(db: Database.Database) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row: any) => [row.name, db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()]);
}
it('reads validated current memory without a session or any database mutation', () => {
  const db = open();
  try {
    const before = rows(db), first = store!.currentMemory();
    expect(store!.unfinished()).toBeNull();
    expect(first.character_id).toBe('shared');
    first.traits.push({ id: 'untrusted', text: 'Must not mutate stored memory.' });
    expect(store!.currentMemory().traits).toEqual([]);
    expect(rows(db)).toEqual(before);
  } finally { db.close(); }
});
it('rejects caller input and corrupt stored memory instead of returning an empty document', () => {
  expect(() => validateCommand('currentMemory', undefined)).not.toThrow();
  for (const args of [null, {}, { sessionId: 's' }, { document: {} }]) expect(() => validateCommand('currentMemory', args)).toThrow('invalid_command');
  const db = open();
  try { db.prepare('UPDATE shared_memory SET document_hash=? WHERE id=1').run('corrupt'); expect(() => store!.currentMemory()).toThrow('memory_document_hash'); }
  finally { db.close(); }
});
it('keeps recoverable pending work visible and distinguishes blockers and failures from running work', () => {
  const view = { memory: { job: { state: 'pending' }, blockedBy: null }, renewal: { state: 'failed' } } as SessionView;
  expect(maintenanceNotices(view)).toEqual([{ section: 'memory', text: 'Memory update pending' }, { section: 'starter', text: 'Starter renewal needs attention' }]);
  view.memory.blockedBy = 'earlier';
  expect(maintenanceNotices(view)[0].text).toBe('Memory waiting for an earlier chat');
  view.memory.job!.state = 'running'; view.renewal!.state = 'running';
  expect(maintenanceNotices(view)).toEqual([]);
});
