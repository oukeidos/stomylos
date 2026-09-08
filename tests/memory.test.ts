import { universalSnapshot } from './time-fixtures';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import cases from './fixtures/memory-cases.json';
import selected from './fixtures/memory-contract.json';
import { applyMemory, emptyMemory, memoryBody, memoryConfig, memoryContext, memoryHash, memoryJson, sharedMemoryVersion } from '../src/main/memory-updater';
import { conversationBody, conversationRequestSnapshot, conversationSnapshot, validateEnvelope } from '../src/main/contracts';
import { Store } from '../src/main/database';
import type { MemoryPacket } from '../src/shared/memory';
import { memoryChanges } from '../src/main/memory-history';

let directory: string, store: Store;
const native = resolve('native/advisory-lock.node');
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'stomylos-memory-')); store = new Store(directory, native); });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function start(partner = 'model_04', text = 'I prefer quiet museums.') {
  const session = store.createSession(); store.searchMode(session.id, 'off'); store.selectManual(session.id, partner);
  const message = store.submit(session.id, text); store.commitRoute(session.id, null, 'public_fixture', null);
  const snapshot = store.freezeMemory(session.id)!;
  return { id: session.id, message, snapshot };
}
function prepare(id: string) { const a = store.prepareMemory(id, randomUUID()); store.dispatchMemory(a.id); return a; }
const addition = (source: string, text = 'Prefers quiet museums.') => JSON.stringify({ operations: [{ op: 'add', id: null, category: 'traits', text, source_message_ids: [source] }] });

it('preserves the selected prompt/schema/settings and all eight exported reducer examples', () => {
  const prompt = readFileSync('src/main/memory-prompt.txt', 'utf8'), schema = readFileSync('src/main/memory-schema.json', 'utf8');
  expect(memoryHash(prompt)).toBe(selected.sha256_files['prompt-v2.txt']);
  expect(memoryHash(schema)).toBe(selected.sha256_files['schema-compatible.json']);
  const config = memoryConfig();
  expect(config.prompt).toBe(prompt);
  expect(config.response_identity).toEqual({ allowed_models: selected.accepted_response_models, provider: selected.expected_response_provider });
  expect(config.parameters).toEqual({ model: selected.model, provider: selected.provider, reasoning: selected.reasoning,
    stream: selected.stream, max_tokens: selected.max_tokens, response_format: { type: 'json_schema', json_schema: { name: 'stomylos_memory_delta_v1', strict: true, schema: JSON.parse(schema) } } });
  for (const example of cases) expect(applyMemory(example.packet as MemoryPacket, example.content), example.name).toEqual(example.expected);
  const packet = cases[3].packet as MemoryPacket;
  expect(memoryBody(config, packet).messages).toEqual([{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(packet) }]);
  expect(() => memoryBody({ ...config, timeout_seconds: 10 }, packet)).toThrow('memory_unsupported_settings');
  const huge = structuredClone(packet); huge.session.messages[0].content = 'x'.repeat(60000);
  expect(() => memoryBody(config, huge)).toThrow('memory_input_too_large');
});

it('rejects malformed patches, invented sources, duplicate targets and over-budget documents without mutating the input', () => {
  const packet = structuredClone(cases[3].packet) as MemoryPacket, before = memoryJson(packet);
  const good = JSON.parse(addition(packet.session.messages[0].id));
  for (const change of [
    (p: any) => p.operations[0].source_message_ids = ['unknown'],
    (p: any) => p.operations[0].source_message_ids = [packet.session.messages[1].id],
    (p: any) => p.operations[0].id = 'invented',
    (p: any) => p.operations[0].text = 'x'.repeat(241),
    (p: any) => p.operations[0].extra = true,
    (p: any) => p.operations = Array(121).fill(p.operations[0])
  ]) { const patch = structuredClone(good); change(patch); expect(() => applyMemory(packet, JSON.stringify(patch))).toThrow(); }
  expect(() => applyMemory(packet, '{"operations":[],"operations":[]}')).toThrow();
  expect(memoryJson(packet)).toBe(before);
  const bounded = { ...packet, limits: { ...packet.limits, max_items: 0 } };
  expect(() => applyMemory(bounded, JSON.stringify(good))).toThrow('memory_budget');
  const existing = cases[0].packet as MemoryPacket;
  const op = { op: 'delete', id: 'm1', category: null, text: null, source_message_ids: [existing.session.messages[0].id] };
  expect(() => applyMemory(existing, JSON.stringify({ operations: [op, op] }))).toThrow('memory_target');
  expect(() => applyMemory(existing, JSON.stringify({ operations: [{ ...op, category: 'relationships' }] }))).toThrow('memory_delete_fields');
  expect(() => applyMemory({ ...packet, session: { ...packet.session, character_id: 'model_03' } }, '{"operations":[]}')).toThrow('memory_character_mismatch');
});

it('freezes one memory per conversation, shares new memory across characters and reuses the snapshot after restart', () => {
  const first = start(); store.end(first.id); const attempt = prepare(first.id);
  const updated = store.saveMemory(attempt.id, addition(first.message.id), {});
  expect(updated.revision).toBe(1);
  expect(store.saveMemory(attempt.id, addition(first.message.id), {})).toEqual(updated);
  expect(() => store.saveMemory(attempt.id, '{"operations":[]}', {})).toThrow('memory_already_resolved');
  expect(() => store.retryMemory(first.id)).toThrow('memory_not_retryable');
  const second = start(); expect(second.snapshot).toEqual(updated);
  const request = store.prepareChat(second.id, randomUUID());
  const saved = JSON.parse(request.config);
  const body = store.chatBody(request.id);
  expect(body.messages[0].content).toContain('Prefers quiet museums.');
  expect(body.messages[0].content).toContain(memoryContext(updated, sharedMemoryVersion));
  expect(body.messages[0].content).toContain('<application_time_context>');
  store.end(second.id); const noop = prepare(second.id); store.saveMemory(noop.id, '{"operations":[]}', {});
  expect(store.view(second.id).memory.current?.revision).toBe(1);
  const other = start('model_03'); expect(other.snapshot).toEqual(updated);
  store.end(other.id); const b = prepare(other.id); store.saveMemory(b.id, addition(other.message.id, 'Enjoys astronomy.'), {});
  store.close(); store = new Store(directory, native);
  expect(store.freezeMemory(second.id)).toEqual(updated);
  expect(store.view(other.id).memory.current?.traits.map(i => i.text)).toEqual(['Prefers quiet museums.', 'Enjoys astronomy.']);
  expect(store.view(first.id).memory.snapshot).toEqual(emptyMemory('shared'));
  expect(store.view(first.id).memory.current).toEqual(store.view(other.id).memory.current);
  expect(store.integrity().foreignKeys).toEqual([]);
});

it('blocks later updates across all characters, retains retry input, and allows explicit skip', () => {
  const first = start(); store.end(first.id); const a = prepare(first.id);
  store.failMemory(a.id, 'request_timeout', null, {});
  const second = start(); store.end(second.id);
  const other = start('model_03'); store.end(other.id);
  expect(store.memoryReady([second.id, other.id])).toBeNull();
  expect(store.view(other.id).memory.blockedBy).toBe(first.id);
  expect(() => prepare(other.id)).toThrow('memory_not_ready');
  expect(store.view(second.id).memory.blockedBy).toBe(first.id);
  expect(() => store.retryMemory(second.id)).toThrow('memory_waiting_for_earlier_session');
  store.retryMemory(first.id); const retry = prepare(first.id);
  expect(retry.input_json).toBe(a.input_json); expect(retry.parent_id).toBe(a.id);
  store.failMemory(retry.id, 'request_timeout', null, {}); store.skipMemory(first.id);
  expect(store.memoryReady([second.id])).toBe(second.id);
  const next = prepare(second.id); expect(JSON.parse(next.input_json).current_memory).toEqual(emptyMemory('shared'));
  store.saveMemory(next.id, '{"operations":[]}', {});
  expect(store.memoryJob(first.id)?.state).toBe('skipped');
});

it('rolls back the whole acceptance transaction after a disk-like fault, then accepts the same saved response once', () => {
  const s = start(); store.end(s.id); const attempt = prepare(s.id), content = addition(s.message.id);
  const raw = new Database(join(directory, 'stomylos.sqlite3'));
  raw.exec("CREATE TRIGGER fail_memory_commit BEFORE UPDATE ON memory_jobs WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'disk failure'); END");
  expect(() => store.saveMemory(attempt.id, content, {})).toThrow();
  expect(store.view(s.id).memory.current).toEqual(emptyMemory('shared'));
  expect(store.view(s.id).memory.attempts[0].status).toBe('dispatched');
  raw.exec('DROP TRIGGER fail_memory_commit'); raw.close();
  const doc = store.saveMemory(attempt.id, content, {}); store.saveMemory(attempt.id, content, {});
  expect(doc.revision).toBe(1); expect(store.view(s.id).memory.attempts).toHaveLength(1);
});

it('marks interrupted attempts on reopen, creates no startup request and skips empty or historical chats', () => {
  const empty = store.createSession(); store.end(empty.id); expect(store.memoryJob(empty.id)).toBeNull();
  const s = start(); store.end(s.id); prepare(s.id);
  store.close(); store = new Store(directory, native);
  expect(store.memoryJob(s.id)?.state).toBe('interrupted');
  expect(store.view(s.id).memory.attempts).toHaveLength(1);
  expect(store.view(s.id).memory.attempts[0].failure).toBe('interrupted_unknown_outcome');
  const old = store.createSession(), raw = new Database(join(directory, 'stomylos.sqlite3'));
  const config = universalSnapshot();
  raw.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(config), old.id); raw.close();
  store.selectManual(old.id, 'model_04'); store.submit(old.id, 'An older active session.'); store.commitRoute(old.id, null, 'fixture', null);
  expect(store.freezeMemory(old.id)).toBeNull(); store.end(old.id); expect(store.memoryJob(old.id)).toBeNull();
});

it('accepts the observed false refusal marker but rejects actual refusal and cross-character/missing snapshots', () => {
  const identity = memoryConfig().response_identity;
  const result = { model: identity.allowed_models[0], provider: identity.provider, choices: [{ finish_reason: 'stop', message: { content: '{"operations":[]}', refusal: false } }] };
  expect(validateEnvelope(result, identity).content).toBe('{"operations":[]}');
  expect(() => validateEnvelope({ ...result, choices: [{ finish_reason: 'stop', message: { content: '{}', refusal: true } }] }, identity)).toThrow('response_refusal');
  const snapshot = conversationSnapshot();
  expect(() => conversationBody(snapshot, 'model_04', 'Question?', [])).toThrow('memory_snapshot_missing');
  snapshot.memory_context = emptyMemory('model_03');
  expect(() => conversationBody(snapshot, 'model_04', 'Question?', [])).toThrow('memory_snapshot_missing');
});

it('lets another model correct and forget shared facts without changing an already active snapshot', () => {
  const first = start('model_04'); store.end(first.id); const a = prepare(first.id);
  store.saveMemory(a.id, addition(first.message.id), {});
  const second = start('model_03', 'I now prefer lively museums.'); store.end(second.id);
  const third = start('model_05', 'Please forget my museum preference.');
  const frozen = structuredClone(third.snapshot), b = prepare(second.id);
  const target = frozen.traits[0].id;
  store.saveMemory(b.id, JSON.stringify({ operations: [{ op: 'update', id: target, category: 'traits', text: 'Prefers lively museums.', source_message_ids: [second.message.id] }] }), {});
  expect(store.freezeMemory(third.id)).toEqual(frozen);
  expect(store.view(third.id).memory.current?.traits[0].text).toBe('Prefers lively museums.');
  store.end(third.id); const c = prepare(third.id);
  expect(JSON.parse(c.input_json).current_memory.traits[0].text).toBe('Prefers lively museums.');
  store.saveMemory(c.id, JSON.stringify({ operations: [{ op: 'delete', id: target, category: null, text: null, source_message_ids: [third.message.id] }] }), {});
  const fourth = start('model_07'); expect(fourth.snapshot.traits).toEqual([]);
  store.deleteSession(third.id); expect(store.view(fourth.id).memory.current?.traits).toEqual([]);
  expect(store.view(second.id).memory.snapshot).toEqual(frozen);
});

it('shows committed per-chat changes from the update input, preserving history across later updates, restart and deletion', () => {
  const first = start(); store.end(first.id);
  const second = start('model_03'); store.end(second.id);
  const a = prepare(first.id); const firstDoc = store.saveMemory(a.id, addition(first.message.id), {});
  const firstHistory = store.view(first.id).memory.changes;
  expect(firstHistory).toMatchObject({ status: 'ready', scope: 'shared', beforeRevision: 0, afterRevision: 1,
    items: [{ kind: 'added', before: null, after: { category: 'traits', text: 'Prefers quiet museums.' } }] });
  const target = firstDoc.traits[0].id, b = prepare(second.id);
  store.saveMemory(b.id, JSON.stringify({ operations: [
    { op: 'update', id: target, category: 'experiences', text: 'Visited a quiet museum.', source_message_ids: [second.message.id] },
    { op: 'add', id: null, category: 'traits', text: 'Enjoys astronomy.', source_message_ids: [second.message.id] }
  ] }), {});
  expect(store.view(second.id).memory.snapshot?.traits).toEqual([]);
  const secondHistory = store.view(second.id).memory.changes;
  expect(secondHistory).toMatchObject({ status: 'ready', beforeRevision: 1, afterRevision: 2 });
  if (secondHistory?.status !== 'ready') throw new Error('Missing history');
  expect(secondHistory.items).toHaveLength(2);
  expect(secondHistory.items).toContainEqual({ id: target, kind: 'updated',
    before: { category: 'traits', text: 'Prefers quiet museums.' }, after: { category: 'experiences', text: 'Visited a quiet museum.' } });
  const third = start(); store.end(third.id); const c = prepare(third.id);
  store.saveMemory(c.id, JSON.stringify({ operations: [{ op: 'delete', id: target, category: null, text: null, source_message_ids: [third.message.id] }] }), {});
  expect(store.view(third.id).memory.changes).toMatchObject({ status: 'ready', items: [
    { id: target, kind: 'deleted', before: { category: 'experiences', text: 'Visited a quiet museum.' }, after: null }
  ] });
  store.close(); store = new Store(directory, native);
  expect(store.view(first.id).memory.changes).toEqual(firstHistory);
  expect(store.view(second.id).memory.changes).toEqual(secondHistory);
  store.deleteSession(second.id);
  expect(() => store.view(second.id)).toThrow();
  expect(store.view(first.id).memory.changes).toEqual(firstHistory);
  expect(store.view(third.id).memory.current?.traits.map(item => item.text)).toEqual(['Enjoys astronomy.']);
  expect(store.integrity().foreignKeys).toEqual([]);
});

it('exposes only the selected successful memory result and distinguishes no-op updates from unresolved jobs', () => {
  const s = start(); expect(store.view(s.id).memory.changes).toBeNull();
  store.end(s.id); expect(store.view(s.id).memory.changes).toBeNull();
  const a = prepare(s.id); expect(store.view(s.id).memory.changes).toBeNull();
  store.failMemory(a.id, 'request_timeout', addition(s.message.id), {});
  expect(store.view(s.id).memory.changes).toBeNull();
  store.retryMemory(s.id); const b = prepare(s.id); store.saveMemory(b.id, '{"operations":[]}', {});
  expect(store.view(s.id).memory.changes).toMatchObject({ status: 'ready', beforeRevision: 0, afterRevision: 0, items: [] });
  const next = start(); store.end(next.id); const c = prepare(next.id); store.failMemory(c.id, 'interrupted', null, {}, true);
  expect(store.view(next.id).memory.changes).toBeNull();
  store.skipMemory(next.id); expect(store.view(next.id).memory.changes).toBeNull();
});

it('ignores unchanged text and ordering even when an accepted operation increments the revision', () => {
  const first = start(); store.end(first.id); const a = prepare(first.id);
  const doc = store.saveMemory(a.id, JSON.stringify({ operations: [
    { op: 'add', id: null, category: 'traits', text: 'Prefers quiet museums.', source_message_ids: [first.message.id] },
    { op: 'add', id: null, category: 'traits', text: 'Enjoys astronomy.', source_message_ids: [first.message.id] }
  ] }), {});
  const second = start(); store.end(second.id); const b = prepare(second.id);
  store.saveMemory(b.id, JSON.stringify({ operations: [{ op: 'update', id: doc.traits[0].id, category: 'traits', text: doc.traits[0].text, source_message_ids: [second.message.id] }] }), {});
  expect(store.view(second.id).memory.changes).toMatchObject({ status: 'ready', beforeRevision: 1, afterRevision: 2, items: [] });
});

it('keeps unreadable memory history local to the history view and supports retained character-scoped records', () => {
  const s = start(); store.end(s.id); const a = prepare(s.id); const doc = store.saveMemory(a.id, addition(s.message.id), {});
  const job = store.memoryJob(s.id)!, raw = new Database(join(directory, 'stomylos.sqlite3'));
  try {
    const saved = raw.prepare('SELECT * FROM memory_attempts WHERE id=?').get(a.id) as typeof a;
    expect(memoryChanges(job, { ...saved, job_id: job.ordinal + 1 })).toEqual({ status: 'unavailable' });
    expect(memoryChanges(job, { ...saved, input_hash: 'bad' })).toEqual({ status: 'unavailable' });
    expect(memoryChanges(job, { ...saved, status: 'failed' })).toEqual({ status: 'unavailable' });
    const legacyInput: MemoryPacket = JSON.parse(saved.input_json); legacyInput.current_memory.character_id = job.character_id;
    const encoded = memoryJson(legacyInput);
    expect(memoryChanges(job, { ...saved, input_json: encoded, input_hash: memoryHash(encoded), result: memoryJson({ ...doc, character_id: job.character_id }) }))
      .toMatchObject({ status: 'ready', scope: 'character', items: [{ kind: 'added' }] });
    for (const result of [null, '{', memoryJson({ ...doc, character_id: 'wrong' })]) {
      raw.prepare('UPDATE memory_attempts SET result=? WHERE id=?').run(result, a.id);
      const view = store.view(s.id);
      expect(view.memory.changes).toEqual({ status: 'unavailable' });
      expect(view.messages.some(message => message.id === s.message.id)).toBe(true);
    }
    raw.prepare('UPDATE memory_jobs SET selected_attempt_id=NULL WHERE session_id=?').run(s.id);
    expect(store.view(s.id).memory.changes).toEqual({ status: 'unavailable' });
  } finally { raw.close(); }
});
