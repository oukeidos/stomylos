import { flat } from './flat-memory-fixtures';
import { flattenMemory } from '../src/main/memory-flat';
import { grammarSnapshot } from '../src/main/contracts';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { emptyMemory, memoryHash, memoryJson } from '../src/main/memory-updater';
import { memoryCharacters } from '../src/main/memory-render';
const dirs: string[] = [], stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'stomylos-capacity-')); dirs.push(dir);
  const store = new Store(dir, resolve('native/advisory-lock.node')); stores.push(store);
  const db = new Database(join(dir, 'stomylos.sqlite3'));
  const memory = flattenMemory(emptyMemory('shared')); memory.database_records.push({ id: 'old', text: 'x'.repeat(29000) });
  const encoded = memoryJson(memory); db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(encoded, memoryHash(encoded)); db.close();
  const session = store.createSession(); store.searchMode(session.id, 'off'); store.selectManual(session.id, 'model_04');
  const message = store.submit(session.id, 'I like detailed memories.'); store.commitRoute(session.id, null, 'public_fixture', null);
  store.freezeMemory(session.id); store.end(session.id);
  return { store, dir, id: session.id, message };
}
function update(store: Store, id: string, source: string) {
  const a = store.prepareMemory(id, randomUUID()); store.dispatchMemory(a.id);
  store.saveMemory(a.id, JSON.stringify({ add: [{ text: 'y'.repeat(2500), source_message_ids: ['u1'] }], update: [], delete: [] }), {});
}
it('stages over-cap updates, commits cleanup atomically with fresh IDs, and keeps other branches gated', () => {
  const { store, id, message } = setup(); update(store, id, message.id);
  expect(memoryCharacters(store.currentMemory())).toBeLessThan(30000);
  expect(store.memoryCandidate(id)?.state).toBe('pending');
  expect(() => store.createSession()).toThrow('end_processing_pending');
  const a = store.prepareCleanup(id, randomUUID()); store.dispatchCleanup(a.id);
  store.receiveCleanup(a.id, 'Likes detailed memories. Two sentences stay in one item.', {});
  const committed = store.acceptCleanup(a.id);
  expect(flat(committed).database_records[0].id).not.toBe('old');
  expect(store.acceptCleanup(a.id)).toEqual(committed);
  expect(store.memoryJob(id)?.state).toBe('completed');
  expect(store.endBlocker()).toBeNull();
  store.cancelEnd(id); expect(store.createSession().id).not.toBe(id);
  expect(store.currentMemory()).toEqual(committed);
});
it('force cancellation abandons candidate and permanently rejects retry and late cleanup receipt', () => {
  const { store, id, message } = setup(); update(store, id, message.id);
  const a = store.prepareCleanup(id, randomUUID()); store.dispatchCleanup(a.id); store.cancelEnd(id);
  expect(() => store.receiveCleanup(a.id, 'late', {})).toThrow();
  expect(() => store.retryMemory(id)).toThrow('end_processing_cancelled');
  expect(flat(store.currentMemory()).database_records[0].id).toBe('old');
  expect(store.createSession().id).not.toBe(id);
});
it('preserves received cleanup and retry allowance over restart without inference', () => {
  const { store, dir, id, message } = setup(); update(store, id, message.id);
  expect(store.takeAutomaticRetry(id, 'cleanup')).toBe(true);
  const a = store.prepareCleanup(id, randomUUID()); store.dispatchCleanup(a.id);
  store.receiveCleanup(a.id, 'Keeps useful detail.', {});
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new Store(dir, resolve('native/advisory-lock.node')); stores.push(reopened);
  expect(reopened.takeAutomaticRetry(id, 'cleanup')).toBe(false);
  expect(() => reopened.createSession()).toThrow('end_processing_pending');
  reopened.retryMemory(id);
  expect(reopened.prepareCleanup(id, randomUUID()).id).toBe(a.id);
  expect(flat(reopened.acceptCleanup(a.id)).database_records[0].text).toBe('Keeps useful detail.');
});

it('deletes a session with staged cleanup attempts while preserving authoritative memory', () => {
  const { store, id, message } = setup(); update(store, id, message.id);
  const a = store.prepareCleanup(id, randomUUID()); store.dispatchCleanup(a.id);
  store.cancelEnd(id); const before = store.currentMemory();
  store.deleteSession(id);
  expect(store.memoryCandidate(id)).toBeNull();
  expect(store.cleanupAttempts(id)).toEqual([]);
  expect(store.endBlocker()).toBeNull();
  expect(store.currentMemory()).toEqual(before);
});

it('accepts a durably received factual response after restart without a new attempt', () => {
  const { store, dir, id, message } = setup();
  const a = store.prepareMemory(id, randomUUID()); store.dispatchMemory(a.id);
  const content = JSON.stringify({ add: [{ text: 'y'.repeat(2500), source_message_ids: ['u1'] }], update: [], delete: [] });
  store.receiveEndResponse(id, 'update', a.id, content, {});
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new Store(dir, resolve('native/advisory-lock.node')); stores.push(reopened);
  expect(reopened.resumeEndResponse(id, 'update')).toBe(true);
  expect(reopened.memoryCandidate(id)?.update_attempt_id).toBe(a.id);
  expect(reopened.resumeEndResponse(id, 'update')).toBe(false);
  expect(flat(reopened.currentMemory()).database_records[0].id).toBe('old');
});

it('accepted cleanup lines remain readable even when the model repeats a line', () => {
  const { store, id, message } = setup(); update(store, id, message.id);
  const a = store.prepareCleanup(id, randomUUID()); store.dispatchCleanup(a.id);
  store.receiveCleanup(a.id, 'Likes detail.\nLikes detail.', {});
  store.acceptCleanup(a.id);
  expect(flat(store.currentMemory()).database_records.map(item => item.text)).toEqual(['Likes detail.', 'Likes detail.']);
});

it('recovers durably received grammar while starter replay is retired after restart with the same attempts', () => {
  const { store, dir, id, message } = setup();
  const grammar = store.createRequest(id, 'grammar', grammarSnapshot()); store.dispatch(grammar.id);
  store.receiveEndResponse(id, 'grammar', grammar.id, JSON.stringify({units:[{index: 0,corrected_text:message.content,explanation:''}]}), {});
  const starter = { id: 'historical-receipt' };
  store.receiveEndResponse(id, 'starter', starter.id, 'What would you like to explore?\nHow would you describe a favorite place?', {});
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new Store(dir, resolve('native/advisory-lock.node')); stores.push(reopened);
  expect(reopened.resumeEndResponse(id, 'grammar')).toBe(true);
  expect(reopened.resumeEndResponse(id, 'starter')).toBe(false);
  expect(reopened.session(id).selected_analysis_id).toBe(grammar.id);
  expect(reopened.starterJob(id)).toBeNull();
  expect(reopened.resumeEndResponse(id, 'grammar')).toBe(false);
  expect(reopened.resumeEndResponse(id, 'starter')).toBe(false);
});

it('refuses over-cap authoritative memory on restart without truncation or mutation', () => {
  const { store, dir } = setup(); store.close(); stores.splice(stores.indexOf(store), 1);
  const db = new Database(join(dir, 'stomylos.sqlite3'));
  const doc = flattenMemory(emptyMemory('shared')); doc.database_records.push({id:'retained',text:'x'.repeat(31000)});
  const document = memoryJson(doc); db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(document,memoryHash(document)); db.close();
  expect(()=>new Store(dir,resolve('native/advisory-lock.node'))).toThrow('memory_recovery_required');
  const after = new Database(join(dir,'stomylos.sqlite3')); expect(after.prepare('SELECT document FROM shared_memory').pluck().get()).toBe(document); after.close();
});

it.each(['stomylos_memory_updater_v4', 'stomylos_memory_updater_v5', 'stomylos_memory_updater_v6'])('preserves frozen %s effort across restart/retry and still stages cleanup', async version => {
  const { memoryConfig, memoryBody, currentUpdaterVersion } = await import('../src/main/memory-updater');
  const { store, dir, id, message } = setup();
  expect(JSON.parse(store.memoryJob(id)!.config).version).toBe(currentUpdaterVersion);
  expect(JSON.parse(store.memoryJob(id)!.config).parameters.reasoning.effort).toBe('low');
  // Construct an old saved job in isolated test data; production never rewrites one.
  const db = new Database(join(dir, 'stomylos.sqlite3'));
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='immutable_memory_source'").pluck().get() as string;
  const config = memoryJson(memoryConfig(version));
  db.exec('DROP TRIGGER immutable_memory_source');
  db.prepare('UPDATE memory_jobs SET config=?,config_hash=? WHERE session_id=?').run(config, memoryHash(config), id);
  db.exec(trigger);
  const legacy = emptyMemory('shared'); legacy.traits = [{id:'old',text:'x'.repeat(29000)}];
  const encoded = memoryJson(legacy); db.prepare('INSERT INTO memory_legacy_bridge VALUES(1,?,?)').run(encoded,memoryHash(encoded));
  db.close();
  const first = store.prepareMemory(id, randomUUID()); store.dispatchMemory(first.id);
  store.failMemory(first.id, 'request_timeout');
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new Store(dir, resolve('native/advisory-lock.node')); stores.push(reopened);
  reopened.retryMemory(id); const retry = reopened.prepareMemory(id, randomUUID());
  expect(retry.input_json).toBe(first.input_json);
  expect(reopened.memoryJob(id)!.config).toBe(config);
  expect(memoryBody(JSON.parse(config), JSON.parse(retry.input_json)).reasoning.effort).toBe(version.endsWith('v4') ? 'medium' : 'low');
  reopened.dispatchMemory(retry.id);
  reopened.saveMemory(retry.id, JSON.stringify({ operations: [{ op: 'add', id: null, category: 'experiences', text: 'y'.repeat(2500), source_message_ids: [version.endsWith('v6') ? 'u1' : message.id] }] }), {});
  expect(reopened.memoryCandidate(id)?.state).toBe('pending');
  expect(() => reopened.createSession()).toThrow('end_processing_pending');
});

it('rejects stale canonical memory atomically and preserves the raw v7 response on success', () => {
  const {store,dir,id}=setup();
  const a=store.prepareMemory(id,randomUUID());store.dispatchMemory(a.id);
  const content=JSON.stringify({add:[],update:[{id:'m1',text:'Likes detail.',source_message_ids:['u1']}],delete:[]});
  const db=new Database(join(dir,'stomylos.sqlite3'));
  const before=db.prepare('SELECT * FROM shared_memory').get() as {document:string;document_hash:string};
  const changed=JSON.parse(before.document);changed.revision++;
  db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(memoryJson(changed),memoryHash(memoryJson(changed)));
  expect(()=>store.saveMemory(a.id,content,{})).toThrow('memory_stale_input');
  expect(db.prepare('SELECT status FROM memory_attempts WHERE id=?').pluck().get(a.id)).toBe('dispatched');
  db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(before.document,before.document_hash);
  expect(flat(store.saveMemory(a.id,content,{})).database_records).toEqual([{id:'old',text:'Likes detail.'}]);
  expect(db.prepare('SELECT response_content FROM memory_attempts WHERE id=?').pluck().get(a.id)).toBe(content);db.close();
  expect(store.view(id).memory.changes).toMatchObject({status:'ready',items:[{id:'old',kind:'updated'}]});
});

it('rejects a tampered frozen input hash without applying alias output', () => {
  const {store,dir,id}=setup();const a=store.prepareMemory(id,randomUUID());store.dispatchMemory(a.id);
  const db=new Database(join(dir,'stomylos.sqlite3'));
  db.exec('DROP TRIGGER immutable_memory_input');
  db.prepare("UPDATE memory_attempts SET input_hash='corrupt' WHERE id=?").run(a.id);db.close();
  expect(()=>store.saveMemory(a.id,'{"operations":[]}',{})).toThrow('memory_source_changed');
  expect(flat(store.currentMemory()).database_records[0].id).toBe('old');
});
