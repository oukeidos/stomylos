import { timed, universalSnapshot } from './time-fixtures';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { characters, config, conversationBody, conversationRequestSnapshot, conversationSnapshot, grammarBody, grammarSnapshot, hash, routerBody, routerSnapshot, transcriptJson, validateGrammar } from '../src/main/contracts';
import { emptyMemory } from '../src/main/memory-updater';
import { starterBody, starterSnapshot, renewalV2 } from '../src/main/starter-renewal';
import { validateCommand } from '../src/main/ipc';
import type { OpeningKind, Message } from '../src/shared/types';

let directory: string, store: Store, raw: Database.Database;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stomylos-opening-'));
  store = new Store(directory, resolve('native/advisory-lock.node'));
  raw = (store as unknown as { db: Database.Database }).db;
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function change(id: string, kind: OpeningKind, operation = randomUUID()) {
  return store.setOpening(id, operation, store.session(id).opening_revision, kind);
}
function newSession() {
  // Complete unrelated end stages in this opening-only fixture before moving on.
  const blocker = store.endBlocker();
  if (blocker) {
    raw.prepare("UPDATE sessions SET analysis_state='skipped' WHERE id=?").run(blocker);
    if (store.endBlocker()) store.cancelEnd(blocker);
  }
  return store.createSession();
}
function direct() { const session = newSession(); change(session.id, 'user'); return store.session(session.id); }
function counts(id: string) { return raw.prepare('SELECT kind,COUNT(*) n FROM starter_events WHERE session_id=? GROUP BY kind ORDER BY kind').all(id); }
it('parks/restores the exact question and keeps drafts, manual choice, preferences and actual feedback across restart', () => {
  const initial = newSession(); const message = store.messages(initial.id)[0];
  store.saveDraft(initial.id, '  한글\r\nA thought.  '); store.selectManual(initial.id, 'model_04');
  const before = store.starterInventory(); change(initial.id, 'user');
  expect(store.messages(initial.id)).toEqual([]);
  expect(store.session(initial.id)).toMatchObject({ starter_id: null, starter_text: null, opening_kind: 'user', manual_character: 'model_04' });
  expect(store.starterInventory()).toEqual(before);
  store.close(); store = new Store(directory, resolve('native/advisory-lock.node'));
  expect(newSession().id).toBe(initial.id);
  expect(store.session(initial.id).draft).toBe('  한글\r\nA thought.  ');
  change(initial.id, 'starter'); expect(store.messages(initial.id)).toEqual([message]);
  change(initial.id, 'user'); store.end(initial.id);
  expect(store.starterJob(initial.id)).toBeNull();
  expect(store.session(initial.id).parked_starter).toBeNull();
  const next = newSession(); expect(next.opening_kind).toBe('user');
  expect(store.messages(next.id)).toEqual([]);
  expect(store.sessionPage().sessions.find(s => s.id === next.id)?.title).toBe('New chat');
  expect(store.starterInventory()).toEqual(before);
});

it('rejects stale/altered operations and preserves the latest committed result under duplicate acknowledgements', () => {
  const session = newSession(), operation = randomUUID();
  const result = store.setOpening(session.id, operation, 0, 'user');
  expect(store.setOpening(session.id, operation, 0, 'user')).toEqual(result);
  expect(() => store.setOpening(session.id, operation, 0, 'starter')).toThrow('opening_operation_conflict');
  change(session.id, 'starter');
  expect(() => store.setOpening(session.id, operation, 0, 'user')).toThrow('opening_changed');
  const now = store.session(session.id);
  store.replaceQuestion(now.id, 'real-skip', now.starter_id!, now.opening_revision);
  expect(() => store.setOpening(now.id, 'stale-switch', now.opening_revision, 'user')).toThrow('opening_changed');
  expect(counts(now.id)).toEqual([{ kind: 'presented', n: 1 }, { kind: 'replaced', n: 1 }]);
});

it('rolls back the entire opening transition on failure without losing the draft or changing the preference', () => {
  const session = newSession(); store.saveDraft(session.id, 'Do not lose this.');
  const before = store.session(session.id), messages = store.messages(session.id);
  raw.exec("CREATE TRIGGER fail_opening BEFORE UPDATE ON opening_preferences BEGIN SELECT RAISE(ABORT,'injected'); END;");
  expect(() => change(session.id, 'user')).toThrow('injected');
  expect(store.session(session.id)).toEqual(before); expect(store.messages(session.id)).toEqual(messages);
  expect(raw.prepare('SELECT kind FROM opening_preferences').get()).toEqual({ kind: 'starter' });
});

it('stores the first direct message at zero, freezes the opening, and preserves grammar and memory source identity', () => {
  const session = direct(); const user = store.submit(session.id, '  I goes walking.\n');
  expect(user.sequence).toBe(0); expect(store.messages(session.id)).toEqual([user]);
  expect(store.session(session.id).parked_starter).toBeNull();
  expect(() => change(session.id, 'starter')).toThrow('opening_is_frozen');
  expect(() => store.submit(session.id, 'Double send')).toThrow('reply_unresolved');
  expect(() => raw.prepare("UPDATE sessions SET opening_kind='starter',starter_id='fake',starter_version='fake',starter_text='Fake?' WHERE id=?").run(session.id)).toThrow('immutable');
  expect(() => raw.prepare('DELETE FROM messages WHERE id=?').run(user.id)).toThrow('immutable');
  store.commitRoute(session.id, null, 'public', null); store.freezeMemory(session.id);
  store.end(session.id);
  expect(store.sessionPage().sessions[0].title).toBe(user.content);
  const source = JSON.parse(grammarBody(grammarSnapshot(), store.messages(session.id)).messages[1].content);
  expect(source).toEqual([{ index: 0, role: 'user', content: user.content }]);
  expect(validateGrammar(JSON.stringify({ units: [{ index: 0, corrected_text: '  I go walking.\n', explanation: 'Use go with I.' }] }), [user])[0].source_message_id).toBe(user.id);
  expect(JSON.parse(store.memoryJob(session.id)!.source).messages.map(({ sent_time, ...message }: any) => { expect(sent_time.utc).toBeTypeOf('string'); return message; })).toEqual([{ id: user.id, role: 'user', origin: 'learner', delivery: 'complete', content: user.content }]);
  expect(counts(session.id)).toEqual([{ kind: 'presented', n: 1 }]);
});

it('ends a skip-only direct draft without online starter work', () => {
  const session=newSession(); store.replaceQuestion(session.id,'skip',session.starter_id!,session.opening_revision);
  change(session.id,'user'); store.saveDraft(session.id,'UNSENT'); store.end(session.id);
  expect(store.starterJob(session.id)).toBeNull(); expect(store.memoryJob(session.id)).toBeNull();
  expect(raw.prepare('SELECT COUNT(*) n FROM starter_skips WHERE session_id=?').get(session.id)).toEqual({n:1});
});

it('keeps catalog counters unchanged for a direct opening', () => {
  const session=direct(),before=raw.prepare('SELECT * FROM starter_catalog_entries').all();
  store.submit(session.id,'Explain how rainbows form.'); store.end(session.id);
  expect(store.starterJob(session.id)).toBeNull();
  expect(raw.prepare('SELECT * FROM starter_catalog_entries').all()).toEqual(before);
});

it('preserves an already-answered parked question and records its reuse', () => {
  const older=newSession(); store.submit(older.id,'An earlier answer.'); store.end(older.id);
  const draft=newSession();
  raw.prepare('UPDATE sessions SET starter_id=?,starter_version=?,starter_text=? WHERE id=?').run(older.starter_id,older.starter_version,older.starter_text,draft.id);
  raw.prepare('UPDATE messages SET content=? WHERE session_id=?').run(older.starter_text,draft.id);
  const original=store.messages(draft.id)[0]; change(draft.id,'user'); change(draft.id,'starter');
  expect(store.messages(draft.id)).toEqual([original]); store.submit(draft.id,'Another answer.');
  expect(raw.prepare('SELECT answer_count FROM starter_catalog_entries WHERE question_id=?').pluck().get(older.starter_id)).toBe(2);
});

it('uses exact historical contracts for old sessions and direct routing/assembly for every selected partner', () => {
  const session = direct(), user = store.submit(session.id, 'Explain gravity.');
  const saved = JSON.parse(store.session(session.id).chat_config);
  expect(JSON.parse(routerBody(null, user.content, saved).messages[1].content)).toEqual({ opening_kind: 'user', first_message: user.content });
  expect(routerSnapshot(saved).version).toBe('stomylos_compact_router_v1_direct');
  expect(routerBody(null, user.content, saved).response_format).toEqual(config.router.response_format);
  const prompt = readFileSync('src/main/direct-router-seven-prompt.txt', 'utf8');
  expect(hash(prompt)).toBe('9aea4092950d333da528772588014540472af3b99599a440d57252d6dfc90711');
  expect(prompt.split('Characters:')[1].split('The first message')[0]).toBe(config.routerPrompt.split('Characters:')[1].split('The starter question')[0]);
  for (const partner of characters) {
    const snapshot = conversationRequestSnapshot(saved); snapshot.memory_context = emptyMemory('shared');
    const body = conversationBody(timed(snapshot, [user]), partner.id, null, [user]);
    expect(body.messages).toHaveLength(2); expect(body.messages[1]).toEqual({ role: 'user', content: user.content });
    expect(body.messages[0].content.startsWith(config.conversationPrompt)).toBe(true);
    expect(body.messages.some((m: any) => m.content.includes('Opening question:'))).toBe(false);
    expect(() => conversationBody(snapshot, partner.id, 'Unseen question?', [user])).toThrow('opening_source_changed');
  }
  const legacy = conversationSnapshot(); delete legacy.router_prompt_version;
  expect(routerSnapshot(legacy).version).toBe(config.router.version);
  expect(routerBody('Known question?', 'Known answer.', legacy).messages[0].content).toBe(config.routerPrompt);
  expect(() => conversationRequestSnapshot({ ...saved, opening: { kind: 'user', version: 'unknown' } })).toThrow('unsupported_opening');
});

it('retains old renewal settings and rejects unknown/new malformed inputs', () => {
  const old = starterSnapshot(() => 0); expect(starterBody(old, '{}').messages[0].content).toBe(old.prompt);
  const newer = starterSnapshot(() => 0, renewalV2);
  expect(() => starterBody(newer, '{}')).toThrow('starter_input_format');
  expect(() => starterBody({ ...old, version: 'unknown' }, '{}')).toThrow('unsupported_starter_settings');
  const session = direct(); store.submit(session.id, 'A direct thought.'); store.end(session.id);
  expect(store.starterJob(session.id)).toBeNull();
});

it('validates the narrow IPC and keeps old unsent sessions on their original contract', () => {
  const args = { sessionId: 'public', operationId: 'operation', expectedRevision: 0, kind: 'user' };
  expect(() => validateCommand('setOpening', args)).not.toThrow();
  for (const changed of [{ ...args, expectedRevision: -1 }, { ...args, kind: 'other' }, { ...args, extra: true }]) expect(() => validateCommand('setOpening', changed)).toThrow('invalid_command');
  const session = newSession();
  raw.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(universalSnapshot()), session.id);
  const saved = store.session(session.id).chat_config;
  expect(() => change(session.id, 'user')).toThrow('unsupported_opening');
  store.submit(session.id, 'An old-session answer.'); store.end(session.id);
  expect(store.session(session.id).chat_config).toBe(saved);
  expect(store.starterJob(session.id)).toBeNull();
  expect(store.integrity().foreignKeys).toEqual([]);
});

it('keeps opening choices frozen when Send, End or a later new session wins', () => {
  const session = direct(); store.submit(session.id, 'A first message.');
  expect(() => store.setOpening(session.id, 'late-switch', 1, 'starter')).toThrow('opening_is_frozen');
  store.end(session.id); const next = newSession();
  expect(() => store.setOpening(session.id, 'later-switch', 1, 'starter')).toThrow('opening_is_frozen');
  expect(store.session(next.id).opening_kind).toBe('user');
  expect(() => store.replaceQuestion(next.id, 'hidden-skip', session.starter_id ?? 'absent', next.opening_revision)).toThrow('opening_changed');
  expect(store.messages(next.id)).toEqual([]);
});

it('removes direct opening metadata with whole-chat deletion while retaining the global preference', () => {
  const session = direct(); store.submit(session.id, 'A deletable direct conversation.'); store.end(session.id);
  const next = newSession(); const preference = raw.prepare('SELECT * FROM opening_preferences').all();
  store.deleteSession(session.id);
  expect(() => store.session(session.id)).toThrow('session_not_found'); expect(store.messages(session.id)).toEqual([]);
  expect(store.session(next.id).opening_kind).toBe('user'); expect(raw.prepare('SELECT * FROM opening_preferences').all()).toEqual(preference);
  expect(store.starterJob(session.id)).toBeNull(); expect(store.integrity().foreignKeys).toEqual([]);
});

it('ages previous skips by ended sessions of both modes while keeping the empty direct input honest', () => {
  const session = newSession(); store.replaceQuestion(session.id, 'old-skip', session.starter_id!, 0);
  change(session.id, 'user'); store.end(session.id);
  for (let i = 0; i < 11; i++) { const empty = newSession(); store.end(empty.id); expect(store.starterJob(empty.id)).toBeNull(); }
  const last = newSession(); store.submit(last.id, 'A new thought.'); store.end(last.id);
  expect(store.starterJob(last.id)).toBeNull();
});
