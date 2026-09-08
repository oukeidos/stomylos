import { expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { memoryVersion } from '../src/main/memory-updater';
const root = process.env.STOMYLOS_MEMORY_CONTINUITY_DIR!;
it('refuses v2 unchanged, opens the externally converted copy, preserves original rows and enables only new memory sessions', () => {
  const original = join(root, 'original'), converted = join(root, 'converted');
  const bytes = readFileSync(join(original, 'stomylos.sqlite3'));
  expect(() => new Store(original, resolve('native/advisory-lock.node'))).toThrow('external_migration_required');
  expect(readFileSync(join(original, 'stomylos.sqlite3'))).toEqual(bytes);
  const old = new Database(join(original, 'stomylos.sqlite3'), { readonly: true });
  const raw = new Database(join(converted, 'stomylos.sqlite3'), { readonly: true });
  const tables = (old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(t => t.name);
  expect(tables).toHaveLength(12); expect(raw.pragma('user_version', { simple: true })).toBe(3);
  let store = new Store(converted, resolve('native/advisory-lock.node'));
  try {
    for (const table of tables) expect(raw.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()).toEqual(old.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
    for (const session of store.sessions()) expect(store.memoryJob(session.id)).toBeNull();
    const active = store.unfinished()!; expect(store.session(active.id).draft).toBe('  Exact draft\n한글  ');
    store.end(active.id); expect(store.memoryJob(active.id)).toBeNull();
    const fresh = store.createSession(); expect(JSON.parse(fresh.chat_config).memory_version).toBe(memoryVersion);
    store.selectManual(fresh.id, 'model_04'); store.submit(fresh.id, 'A new memory-enabled conversation.');
    store.commitRoute(fresh.id, null, 'public_fixture', null); const snapshot = store.freezeMemory(fresh.id);
    expect(snapshot?.revision).toBe(0); store.end(fresh.id); expect(store.memoryJob(fresh.id)?.state).toBe('pending');
    store.close(); store = new Store(converted, resolve('native/advisory-lock.node'));
    expect(store.freezeMemory(fresh.id)).toEqual(snapshot);
    expect(store.memoryJob(fresh.id)?.state).toBe('pending'); expect(store.view(fresh.id).memory.attempts).toHaveLength(0);
    expect(store.integrity().foreignKeys).toEqual([]);
    writeFileSync(join(root, 'product-continuity.json'), JSON.stringify({ status: 'passed', unchangedTables: tables, memoryBackfill: false, newMemoryJob: true, startupRequests: 0 }, null, 2));
  } finally { store.close(); raw.close(); old.close(); }
});
