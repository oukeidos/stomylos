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
  const memory = emptyMemory('shared'); memory.traits.push({ id: 'old', text: 'x'.repeat(29000) });
  const encoded = memoryJson(memory); db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(encoded, memoryHash(encoded)); db.close();
  const session = store.createSession(); store.searchMode(session.id, 'off'); store.selectManual(session.id, 'model_04');
  const message = store.submit(session.id, 'I like detailed memories.'); store.commitRoute(session.id, null, 'public_fixture', null);
  store.freezeMemory(session.id); store.end(session.id);
  return { store, dir, id: session.id, message };
}
function update(store: Store, id: string, source: string) {
  const a = store.prepareMemory(id, randomUUID()); store.dispatchMemory(a.id);
  store.saveMemory(a.id, JSON.stringify({ operations: [{ op: 'add', id: null, category: 'experiences', text: 'y'.repeat(2500), source_message_ids: [source] }] }), {});
}
it('stages over-cap updates, commits cleanup atomically with fresh IDs, and keeps other branches gated', () => {
  const { store, id, message } = setup(); update(store, id, message.id);
  expect(memoryCharacters(store.currentMemory())).toBeLessThan(30000);
  expect(store.memoryCandidate(id)?.state).toBe('pending');
  expect(() => store.createSession()).toThrow('end_processing_pending');
  const a = store.prepareCleanup(id, randomUUID()); store.dispatchCleanup(a.id);
  store.receiveCleanup(a.id, 'Traits\nLikes detailed memories. Two sentences stay in one item.\nRelationships\nExperiences\nIntentions', {});
  const committed = store.acceptCleanup(a.id);
  expect(committed.traits[0].id).not.toBe('old');
  expect(store.acceptCleanup(a.id)).toEqual(committed);
  expect(store.memoryJob(id)?.state).toBe('completed');
  expect(() => store.createSession()).toThrow('end_processing_pending');
  store.cancelEnd(id); expect(store.createSession().id).not.toBe(id);
  expect(store.currentMemory()).toEqual(committed);
});
it('force cancellation abandons candidate and permanently rejects retry and late cleanup receipt', () => {
  const { store, id, message } = setup(); update(store, id, message.id);
  const a = store.prepareCleanup(id, randomUUID()); store.dispatchCleanup(a.id); store.cancelEnd(id);
  expect(() => store.receiveCleanup(a.id, 'late', {})).toThrow();
  expect(() => store.retryMemory(id)).toThrow('end_processing_cancelled');
  expect(store.currentMemory().traits[0].id).toBe('old');
  expect(store.createSession().id).not.toBe(id);
});
it('preserves received cleanup and retry allowance over restart without inference', () => {
  const { store, dir, id, message } = setup(); update(store, id, message.id);
  expect(store.takeAutomaticRetry(id, 'cleanup')).toBe(true);
  const a = store.prepareCleanup(id, randomUUID()); store.dispatchCleanup(a.id);
  store.receiveCleanup(a.id, 'Traits\nKeeps useful detail.\nRelationships\nExperiences\nIntentions', {});
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new Store(dir, resolve('native/advisory-lock.node')); stores.push(reopened);
  expect(reopened.takeAutomaticRetry(id, 'cleanup')).toBe(false);
  expect(() => reopened.createSession()).toThrow('end_processing_pending');
  reopened.retryMemory(id);
  expect(reopened.prepareCleanup(id, randomUUID()).id).toBe(a.id);
  expect(reopened.acceptCleanup(a.id).traits[0].text).toBe('Keeps useful detail.');
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
  const content = JSON.stringify({ operations: [{ op: 'add', id: null, category: 'experiences', text: 'y'.repeat(2500), source_message_ids: [message.id] }] });
  store.receiveEndResponse(id, 'update', a.id, content, {});
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new Store(dir, resolve('native/advisory-lock.node')); stores.push(reopened);
  expect(reopened.resumeEndResponse(id, 'update')).toBe(true);
  expect(reopened.memoryCandidate(id)?.update_attempt_id).toBe(a.id);
  expect(reopened.resumeEndResponse(id, 'update')).toBe(false);
  expect(reopened.currentMemory().traits[0].id).toBe('old');
});

it('accepted cleanup lines remain readable even when the model repeats a line', () => {
  const { store, id, message } = setup(); update(store, id, message.id);
  const a = store.prepareCleanup(id, randomUUID()); store.dispatchCleanup(a.id);
  store.receiveCleanup(a.id, 'Traits\nLikes detail.\nLikes detail.\nRelationships\nExperiences\nIntentions', {});
  store.acceptCleanup(a.id);
  expect(store.currentMemory().traits.map(item => item.text)).toEqual(['Likes detail.', 'Likes detail.']);
});

it('recovers durably received grammar while starter replay is retired after restart with the same attempts', () => {
  const { store, dir, id, message } = setup();
  const grammar = store.createRequest(id, 'grammar', JSON.parse(store.session(id).grammar_config!)); store.dispatch(grammar.id);
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
  const doc = emptyMemory('shared'); doc.traits.push({id:'retained',text:'x'.repeat(31000)});
  const document = memoryJson(doc); db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(document,memoryHash(document)); db.close();
  expect(()=>new Store(dir,resolve('native/advisory-lock.node'))).toThrow('memory_recovery_required');
  const after = new Database(join(dir,'stomylos.sqlite3')); expect(after.prepare('SELECT document FROM shared_memory').pluck().get()).toBe(document); after.close();
});

it.each(['stomylos_memory_updater_v4', 'stomylos_memory_updater_v5'])('preserves frozen %s effort across restart/retry and still stages cleanup', async version => {
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
  db.exec(trigger); db.close();
  const first = store.prepareMemory(id, randomUUID()); store.dispatchMemory(first.id);
  store.failMemory(first.id, 'request_timeout');
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new Store(dir, resolve('native/advisory-lock.node')); stores.push(reopened);
  reopened.retryMemory(id); const retry = reopened.prepareMemory(id, randomUUID());
  expect(retry.input_json).toBe(first.input_json);
  expect(reopened.memoryJob(id)!.config).toBe(config);
  expect(memoryBody(JSON.parse(config), JSON.parse(retry.input_json)).reasoning.effort).toBe(version.endsWith('v4') ? 'medium' : 'low');
  reopened.dispatchMemory(retry.id);
  reopened.saveMemory(retry.id, JSON.stringify({ operations: [{ op: 'add', id: null, category: 'experiences', text: 'y'.repeat(2500), source_message_ids: [message.id] }] }), {});
  expect(reopened.memoryCandidate(id)?.state).toBe('pending');
  expect(() => reopened.createSession()).toThrow('end_processing_pending');
});
