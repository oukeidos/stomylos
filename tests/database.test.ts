import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import goldens from './fixtures/contract-goldens.json';
import cRuntime from '../src/main/c-conversation-config.json';
import { Store } from '../src/main/database';
import { config, conversationSnapshot, grammarSnapshot, hash, routerSnapshot, transcriptJson } from '../src/main/contracts';

let directory: string; let store: Store;
const native = resolve('native/advisory-lock.node');
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'stomylos-store-')); store = new Store(directory, native); });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function answer(text = '  I enjoy quiet mornings.\n') {
  const session = store.createSession(); store.saveDraft(session.id, text);
  const learner = store.submit(session.id, text);
  store.commitRoute(session.id, null, 'test_offline', null);
  return { session: store.session(session.id), learner };
}
function reply(id: string, text = 'A quiet morning leaves room to notice small things.') {
  const request = store.createRequest(id, 'chat', conversationSnapshot()); store.dispatch(request.id);
  const message = store.prepareReply(id, request.id);
  store.finishReply(request.id, message.id, text, {}); return request;
}
describe('durable session transactions', () => {
  it('pages long history without transferring frozen settings and locates the unfinished session independently', () => {
    for (let index = 0; index < 85; index++) store.end(store.createSession().id);
    const active = store.createSession(); const first = store.sessionPage(); const second = store.sessionPage(40); const last = store.sessionPage(80);
    expect([first.sessions.length, second.sessions.length, last.sessions.length]).toEqual([40, 40, 6]);
    expect([first.hasMore, second.hasMore, last.hasMore]).toEqual([true, true, false]);
    expect(new Set([...first.sessions, ...second.sessions, ...last.sessions].map(s => s.id)).size).toBe(86);
    expect(first.sessions[0]).not.toHaveProperty('chat_config'); expect(store.unfinished()?.id).toBe(active.id);
  });
  it('keeps one unfinished session and exact drafts across reopen', () => {
    const first = store.createSession(); expect(store.createSession().id).toBe(first.id);
    store.saveDraft(first.id, '  한글\r\nwith spacing  ');
    store.close(); store = new Store(directory, native);
    expect(store.session(first.id).draft).toBe('  한글\r\nwith spacing  ');
    expect(store.messages(first.id)[0].content).toBe(first.starter_text);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'stomylos.sqlite3')).mode & 0o777).toBe(0o600);
    expect(store.integrity()).toEqual({ integrity: [{ integrity_check: 'ok' }], foreignKeys: [] });
  });
  it('atomically commits exact learner text and freezes its source', () => {
    const { session, learner } = answer();
    expect(learner.content).toBe('  I enjoy quiet mornings.\n'); expect(store.session(session.id).draft).toBe('');
    expect(() => store.submit(session.id, 'Double send')).toThrow('reply_unresolved');
    expect(() => store.replaceQuestion(session.id, 'active-skip', session.starter_id!, session.opening_revision)).toThrow('opening_is_frozen');
    const request = reply(session.id);
    expect(request.source_hash).toBe(hash(transcriptJson(store.messages(session.id, learner.sequence))));
    expect(request.config_hash).toBe(hash(request.config));
    store.saveDraft(session.id, 'Unsent text'); store.end(session.id);
    expect(store.session(session.id).draft).toBe('Unsent text');
    expect(() => store.submit(session.id, 'Late callback')).toThrow('invalid_submission');
    expect(store.createSession().id).not.toBe(session.id);
  });
  it('preserves failed partial text on its attempt when replacing the provisional bubble', () => {
    const { session } = answer();
    const first = store.createRequest(session.id, 'chat', conversationSnapshot()); store.dispatch(first.id);
    const partial = store.prepareReply(session.id, first.id); store.checkpoint(partial.id, 'A partial');
    store.failRequest(first.id, 'stream_incomplete', 'A partial');
    const second = store.createRequest(session.id, 'chat', conversationSnapshot(), first.id);
    expect(second.source_hash).toBe(first.source_hash); store.dispatch(second.id);
    const replacement = store.prepareReply(session.id, second.id);
    store.finishReply(second.id, replacement.id, 'A full reply.', {});
    store.finishReply(second.id, replacement.id, 'A full reply.', {});
    expect(store.messages(session.id).map(m => m.content)).toEqual([session.starter_text, '  I enjoy quiet mornings.\n', 'A full reply.']);
    expect(store.request(first.id).response_content).toBe('A partial');
  });
  it('recovers dispatched work without sending and does not reroute', () => {
    const { session } = answer(); const partner = session.character;
    const request = store.createRequest(session.id, 'chat', conversationSnapshot()); store.dispatch(request.id);
    const bubble = store.prepareReply(session.id, request.id); store.checkpoint(bubble.id, 'Saved checkpoint');
    store.close(); store = new Store(directory, native);
    expect(store.request(request.id).failure).toBe('interrupted_unknown_outcome');
    expect(store.request(request.id).response_content).toBe('Saved checkpoint');
    expect(store.messages(session.id).at(-1)).toMatchObject({ content: 'Saved checkpoint', delivery: 'interrupted' });
    expect(store.commitRoute(session.id, null, 'recovery', null)).toBe(partner);
  });
  it('distinguishes undispatched queued grammar from interrupted remote analysis', () => {
    const { session } = answer(); store.end(session.id);
    const first = store.createRequest(session.id, 'grammar', grammarSnapshot());
    store.close(); store = new Store(directory, native);
    expect(store.session(session.id).analysis_state).toBe('pending');
    expect(store.request(first.id).failure).toBe('queued_not_dispatched');
    const second = store.createRequest(session.id, 'grammar', grammarSnapshot(), first.id); store.dispatch(second.id);
    store.close(); store = new Store(directory, native);
    expect(store.session(session.id).analysis_state).toBe('failed');
    expect(store.request(second.id).failure).toBe('interrupted_unknown_outcome');
  });
  it('links duplicate text occurrences separately and saves all evidence once', () => {
    const { session, learner } = answer('I like it.'); reply(session.id);
    const second = store.submit(session.id, learner.content); store.end(session.id);
    const request = store.createRequest(session.id, 'grammar', grammarSnapshot()); store.dispatch(request.id);
    const unit = { index: 0, corrected_text: learner.content, explanation: '' };
    expect(() => store.saveAnalysis(request.id, JSON.stringify({ units: [unit] }), {})).toThrow('grammar_source_count');
    expect(store.units(session.id)).toEqual([]); expect(store.request(request.id).status).toBe('dispatched');
    const content = JSON.stringify({ units: [unit, { ...unit, index: 1 }] });
    store.saveAnalysis(request.id, content, {}); store.saveAnalysis(request.id, content, {});
    expect(store.units(session.id).map(u => [u.source_message_id, u.ordinal])).toEqual([[learner.id, 0], [second.id, 1]]);
    expect(store.session(session.id).analysis_state).toBe('completed');
    expect(() => store.createRequest(session.id, 'grammar', grammarSnapshot())).toThrow('analysis_not_retryable');
  });
  it('rejects an unsupported version without resetting the file', () => {
    const session = store.createSession(); store.close();
    const raw = new Database(join(directory, 'stomylos.sqlite3')); raw.pragma('user_version = 99'); raw.close();
    expect(() => new Store(directory, native)).toThrow('unsupported_schema_version');
    const check = new Database(join(directory, 'stomylos.sqlite3'), { readonly: true });
    expect(check.pragma('user_version', { simple: true })).toBe(99);
    expect(check.prepare('SELECT id FROM sessions').get()).toEqual({ id: session.id }); check.close();
  });
  it('recovers an interrupted request without creating startup backups on repeated opens', () => {
    const { session } = answer(); const request = store.createRequest(session.id, 'chat', conversationSnapshot()); store.dispatch(request.id);
    store.close(); store = new Store(directory, native);
    expect(store.request(request.id).status).toBe('interrupted');
    store.close(); store = new Store(directory, native);
    expect(store.request(request.id).status).toBe('interrupted');
    expect(existsSync(join(directory, 'backups'))).toBe(false);
  });
  it('does not depend on a backup directory to open existing history', () => {
    const { session } = answer(); store.close();
    writeFileSync(join(directory, 'backups'), 'Public obstruction fixture.');
    store = new Store(directory, native);
    expect(store.session(session.id).id).toBe(session.id);
  });
});

for (const partner of ['warm_reflection', 'everyday_listening']) {
  it(`preserves historical ${partner} selection and settings across reopen`, () => {
    const id = store.createSession().id;
    const saved = JSON.stringify({ ...goldens.legacy.conversation_snapshot, version: 'stomylos_conversation_v2', max_tokens: 8192 });
    const raw = new Database(join(directory, 'stomylos.sqlite3'));
    raw.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(saved, id); raw.close();
    store.selectManual(id, partner); store.submit(id, 'A public old-session answer.');
    store.close(); store = new Store(directory, native);
    store.commitRoute(id, null, 'router_already_attempted', null);
    const expected = partner === 'warm_reflection' ? 'google/gemini-3.1-pro-preview' : 'aion-labs/aion-3.0-mini';
    expect(store.session(id)).toMatchObject({ model: expected, character: partner, chat_config: saved });
    store.end(id);
    const next = JSON.parse(store.createSession().chat_config);
    expect(next.version).toBe('stomylos_conversation_v7');
    expect(next.characters).toHaveLength(7);
    expect(next.characters.find((c: { id: string }) => c.id === 'model_04').model).toBe('openai/gpt-6-astra');
  });
}

it('retains a saved C session while new sessions receive reciprocal v6', () => {
  const id = store.createSession().id;
  const saved = JSON.stringify({ ...cRuntime.conversation, system_prompt: cRuntime.conversationPrompt,
    prompt_sha256: hash(cRuntime.conversationPrompt) });
  const raw = new Database(join(directory, 'stomylos.sqlite3'));
  raw.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(saved, id); raw.close();
  store.selectManual(id, 'model_04'); store.submit(id, 'A public C-session answer.');
  store.close(); store = new Store(directory, native);
  store.commitRoute(id, null, 'router_already_attempted', null);
  expect(store.session(id).chat_config).toBe(saved);
  store.end(id);
  const next = JSON.parse(store.createSession().chat_config);
  expect(next.version).toBe('stomylos_conversation_v7');
  expect(next.system_prompt).toBe(config.conversationPrompt);
  expect(next.seed_template).toBe(config.conversation.seed_template);
});

it('recovers a frozen legacy grammar response across restart without changing its format', () => {
  const {session,learner}=answer();reply(session.id);store.end(session.id);
  const old=goldens.legacy.grammar_snapshot;
  const request=store.createRequest(session.id,'grammar',old);store.dispatch(request.id);
  const content=JSON.stringify({units:[{text:learner.content,corrected_text:learner.content,explanation:''}]});
  store.receiveEndResponse(session.id,'grammar',request.id,content,{});
  store.close();store=new Store(directory,native);
  expect(store.request(request.id).config).toBe(JSON.stringify(old));
  store.resumeEndResponse(session.id,'grammar');
  expect(store.units(session.id)[0]).toMatchObject({text:learner.content,source_message_id:learner.id});
});
