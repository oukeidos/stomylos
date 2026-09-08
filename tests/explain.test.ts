import contractFixtures from './fixtures/explain-contract.json';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { ExplainController } from '../src/main/explain-controller';
import { explainBody, explainRange } from '../src/main/explain';
import { validateCommand } from '../src/main/ipc';
import type { DatabaseClient } from '../src/main/db-client';
import type { ExplainRecord, ExplainTarget } from '../src/shared/explain';
import type { Completion, Gateway } from '../src/main/transport';
let dir: string, store: Store, db: Database.Database, controller: ExplainController;
let calls: { resolve: (r: Completion) => void; reject: (e: Error) => void; signal: AbortSignal; body: any }[], events: ExplainRecord[];
const native = resolve('native/advisory-lock.node');
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stomylos-explain-test-')); store = new Store(dir, native); db = (store as unknown as { db: Database.Database }).db; calls = []; events = [];
  const gateway = { complete: (body: any, _identity: any, signal: AbortSignal) => new Promise<Completion>((resolve, reject) => calls.push({ resolve, reject, signal, body })) } as unknown as Gateway;
  const port = { call: async (method: string, ...args: any[]) => (store as any)[method](...args) } as DatabaseClient;
  controller = new ExplainController(port, gateway, r => events.push(r), () => true);
});
afterEach(async () => { await controller.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); });
function target(source = '🙂 You are on the home stretch.', selected = 'on the home stretch'): ExplainTarget {
  const unfinished = store.unfinished(); if (unfinished) store.end(unfinished.id);
  const session = store.createSession(); store.setOpening(session.id, randomUUID(), session.opening_revision, 'user');
  const user = store.submit(session.id, 'I am nearly finished.'); const id = randomUUID();
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES(?,?,?,'assistant',?,'model','complete')").run(id, session.id, user.sequence + 1, source);
  const start = source.indexOf(selected); return { sessionId: session.id, messageId: id, source, start, end: start + selected.length };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
it('uses exact selected prompt and messages, with pinned Luna xhigh and no schema', () => {
  const t = target(), r = store.explainPrepare(t), body = explainBody(r.source);
  expect(body).toMatchObject({ model: 'openai/gpt-5.6-luna', reasoning: { effort: 'xhigh' }, stream: false, max_tokens: 4096,
    provider: { only: ['openai/flex'], allow_fallbacks: false, require_parameters: true } });
  expect(body).not.toHaveProperty('response_format');
  expect(body.messages[0].content).toBe(readFileSync('src/main/explain-prompt.txt', 'utf8').trim());
  expect(body.messages[1].content).toBe(JSON.stringify({ preceding_message: 'I am nearly finished.', full_passage: t.source, selected_text: 'on the home stretch', selection: { start: t.start, end: t.end, offset_unit: 'utf16' } }));
  expect(createHash('sha256').update(readFileSync('src/main/explain-prompt.txt')).digest('hex')).toBe('db57fd309c90ce6e09b229c05c2470f145190ed0d72258a09522bba7aad94ab1');
  for (const fixture of contractFixtures) expect(explainBody(fixture.source as typeof r.source)).toEqual(fixture.body);
});
it('deduplicates pending and saved targets; closing does not cancel, notify or reopen', async () => {
  const t = target(), r = await controller.open(t); expect((await controller.open(t)).id).toBe(r.id); expect(calls).toHaveLength(1);
  controller.closeDialog(); expect(calls[0].signal.aborted).toBe(false);
  calls[0].resolve({ content: 'You are almost done.', metadata: { cost: 0.01 } }); await settle();
  expect(controller.visible).toBe(false); expect(store.explainGet(r.id).content).toBe('You are almost done.');
  expect((await controller.open(t)).state).toBe('ready'); expect(calls).toHaveLength(1);
  store.close(); store = new Store(dir, native); expect(store.explainGet(r.id).state).toBe('ready');
});
it('keeps different ranges and changed contexts separate with original snapshots', () => {
  const t = target(), r = store.explainPrepare(t);
  const second = store.explainPrepare({ ...t, start: 3, end: t.source.length }); expect(second.id).not.toBe(r.id);
  // Change context in a disposable fixture after removing the immutable-source guard only here.
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='messages'").all() as { name: string; sql: string }[];
  for (const tr of triggers) db.exec(`DROP TRIGGER "${tr.name}"`);
  db.prepare("UPDATE messages SET content='I have a different question.' WHERE session_id=? AND role='user'").run(t.sessionId);
  const changed = store.explainPrepare(t); expect(changed.id).not.toBe(r.id); expect(store.explainGet(r.id).source.preceding_message).toBe('I am nearly finished.');
  for (const tr of triggers) db.exec(tr.sql);
});
it('does not invent prior context and rejects stale, partial and split-surrogate targets', () => {
  const t = target(); expect(() => store.explainPrepare({ ...t, source: 'changed' })).toThrow();
  expect(() => explainRange(t.source, 1, 3)).toThrow();
  const guards = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='messages'").all() as { name: string; sql: string }[];
  for (const guard of guards) db.exec(`DROP TRIGGER "${guard.name}"`);
  db.prepare("UPDATE messages SET delivery='interrupted' WHERE id=?").run(t.messageId);
  for (const guard of guards) db.exec(guard.sql); expect(() => store.explainPrepare(t)).toThrow();
  const next = randomUUID(), source = 'A reply without prior context.';
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES(?,?,?,'assistant',?,'model','complete')").run(next, t.sessionId, store.messages(t.sessionId).at(-1)!.sequence + 1, source);
  expect(store.explainPrepare({ sessionId: t.sessionId, messageId: next, source, start: 0, end: source.length }).source.preceding_message).toBeNull();
  store.end(t.sessionId);
  const session = store.createSession(), id = randomUUID();
  db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES(?,?,1,'assistant',?,'model','complete')").run(id, session.id, source);
  expect(store.explainPrepare({ sessionId: session.id, messageId: id, source, start: 0, end: source.length }).source.preceding_message).toBeNull();

});
it('requires explicit retry for a provider failure and reuses the frozen request', async () => {
  const t = target(), r = await controller.open(t); calls[0].reject(new Error('failed')); await settle();
  expect((await controller.open(t)).state).toBe('failed'); expect(calls).toHaveLength(1);
  await controller.retry(r.id); expect(calls).toHaveLength(2); expect(calls[1].body).toEqual(calls[0].body);
  calls[1].resolve({ content: 'Almost finished.', metadata: {} }); await settle();
});
it('retries local saving without a new model call and keeps content visible', async () => {
  const r = await controller.open(target());
  db.exec("CREATE TRIGGER explain_save_fault BEFORE UPDATE OF content ON explanations WHEN NEW.state='ready' BEGIN SELECT RAISE(ABORT,'test'); END;");
  calls[0].resolve({ content: 'Almost done.', metadata: {} }); await settle();
  expect(events.at(-1)).toMatchObject({ state: 'unsaved', content: 'Almost done.' });
  controller.closeDialog(); expect((await controller.list(r.session_id))[0].state).toBe('unsaved');
  db.exec('DROP TRIGGER explain_save_fault'); await controller.retry(r.id);
  expect(store.explainGet(r.id)).toMatchObject({ state: 'ready', content: 'Almost done.' }); expect(calls).toHaveLength(1);
});
it('supports independent targets and discards late completion after deletion', async () => {
  const a = target(), b = target('A different answer.', 'different'); const r = await controller.open(a); await controller.open(b); expect(calls).toHaveLength(2);
  await controller.dispose(a.sessionId); store.end(a.sessionId); store.deleteSession(a.sessionId);
  calls[0].resolve({ content: 'Too late.', metadata: {} }); calls[1].resolve({ content: 'Not the same.', metadata: {} }); await settle();
  expect(store.explainList(a.sessionId)).toEqual([]); expect(store.explainList(b.sessionId)[0].state).toBe('ready'); expect(events.filter(e => e.id === r.id && e.state === 'ready')).toEqual([]);
});
it('interrupts shutdown without waiting for the provider or replaying on reopen', async () => {
  const r = await controller.open(target()); await controller.dispose(); expect(calls[0].signal.aborted).toBe(true);
  store.close(); store = new Store(dir, native); expect(store.explainGet(r.id).state).toBe('interrupted'); expect(calls).toHaveLength(1);
  calls[0].resolve({ content: 'Late.', metadata: {} }); await settle(); expect(store.explainGet(r.id).content).toBeNull();
});
it('validates renderer commands and rejects source/range injection', () => {
  const t = target(); expect(() => validateCommand('explainOpen', t)).not.toThrow();
  for (const bad of [{ ...t, start: -1 }, { ...t, end: 999999 }, { ...t, context: 'fake' }]) expect(() => validateCommand('explainOpen', bad)).toThrow();
  expect(() => validateCommand('explainRetry', { id: '../x' })).toThrow();
});
