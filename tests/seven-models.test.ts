import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { characters, config, conversationSnapshot, conversationRequestSnapshot, eligible, hash, leastUsed, routerBody, routerScores, routerSnapshot } from '../src/main/contracts';
import { emptyMemory, memoryHash, memoryJson } from '../src/main/memory-updater';
import { routeSearch } from '../src/main/search-router';
import { ChatStream, type Gateway } from '../src/main/transport';
import v5 from '../src/main/conversation-v5-config.json';
import { v5Snapshot } from './time-fixtures';

const ids = ['model_01', 'model_02', 'model_03', 'model_04', 'model_05', 'model_07', 'model_08'];
const models = ['anthropic/claude-fable-5.1', 'xiaomi/mimo-v2.5-pro', 'anthropic/claude-sonnet-5', 'openai/gpt-6-astra', 'google/gemini-3.8-flash', 'bytedance-seed/seed-2-1-turbo', 'deepseek/deepseek-v4-pro-0813'];
let directory: string, store: Store, raw: Database.Database;
function open() { store = new Store(directory, resolve('native/advisory-lock.node')); raw = (store as unknown as { db: Database.Database }).db; }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'stomylos-six-')); open(); });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

it('pins the frozen v5 artifact and selected seven identities, settings and UI contributions', () => {
  expect(hash(readFileSync('src/main/conversation-v5-config.json', 'utf8'))).toBe('1169531c2ec10701c7c7c3db5e11b086216c654a86e010f2e56699cf0d031d24');
  expect(characters.map(c => c.id)).toEqual(ids); expect(characters.map(c => c.model)).toEqual(models);
  expect(characters.map(c => c.label)).toEqual(['Debate', 'Explore', 'Explain', 'Chat', 'Imagine', 'Stories', 'Taste']);
  expect(characters.map(c => c.reasoning)).toEqual(ids.map((_, i) => [1, 5, 6].includes(i) ? { enabled: false, exclude: true } : { effort: 'low', exclude: true }));
  expect(config.conversation.provider).toEqual({ data_collection: 'deny', allow_fallbacks: false });
  expect(config.conversation.max_tokens).toBe(8192);
  expect(config.conversationPrompt).toBe(readFileSync('src/main/reciprocal-replacement-prompt.txt', 'utf8'));
  expect(hash(config.conversationPrompt)).toBe('c70cffeace85121e193f76373a69ccb77785bce8688ab82df88da3f9b95bca00');
});

it('dispatches complete router bundles by saved version and entry and rejects mixed configurations', () => {
  for (const kind of ['starter', 'user'] as const) {
    const old = v5Snapshot(kind), current = conversationSnapshot(kind), question = kind === 'user' ? null : 'Public question?';
    const oldBody = routerBody(question, '  Public answer.\n', old), body = routerBody(question, '  Public answer.\n', current);
    expect(oldBody.response_format).toEqual(v5.router.response_format);
    expect(oldBody.messages[0].content).toBe(kind === 'user' ? readFileSync('src/main/direct-router-prompt.txt', 'utf8') : v5.routerPrompt);
    expect(routerSnapshot(old).version).toBe(kind === 'user' ? 'stomylos_character_router_v3' : 'stomylos_character_router_v2');
    expect(routerSnapshot(current).version).toBe(kind === 'user' ? 'stomylos_compact_router_v1_direct' : 'stomylos_compact_router_v1_starter');
    expect(body.messages[1]).toEqual(oldBody.messages[1]);
    expect(body.response_format.json_schema.name).toBe('stomylos_character_scores_v4');
    expect(body.response_format.json_schema.schema.required).toEqual(ids);
    expect(body.reasoning).toEqual(oldBody.reasoning); expect(body.provider).toEqual(oldBody.provider);
    for (const field of ['characters', 'system_prompt', 'prompt_sha256', 'prompt_id', 'component_hashes', 'version']) {
      expect(() => conversationRequestSnapshot({ ...current, [field]: old[field] })).toThrow();
      expect(() => conversationRequestSnapshot({ ...old, [field]: current[field] })).toThrow();
    }
  }
});

it('requires exactly seven integer score fields, retains overlapping eligibility and preserves fallback/count behavior', () => {
  const scores = Object.fromEntries(ids.map(id => [id, 1])); scores.model_05 = 2; scores.model_07 = 2;
  expect(eligible(routerScores(JSON.stringify(scores)))).toEqual(['model_05', 'model_07']);
  expect(eligible(null)).toEqual(['model_03', 'model_04']);
  expect(eligible(Object.fromEntries(ids.map(id => [id, 1])))).toEqual(['model_03', 'model_04']);
  expect(leastUsed(['model_04', 'model_05', 'model_07'], { model_04: 20, model_05: 1 }, () => 0)).toBe('model_07');
  const valid = JSON.stringify(scores);
  for (const bad of [JSON.stringify({ ...scores, model_06: 2 }), JSON.stringify({ ...scores, model_07: undefined }),
    valid.replace('"model_07":2', '"model_07":2,"model_07":1'), valid.replace('"model_07":2', '"model_07":2,"model_0\\u0037":1'),
    ...['2.0', '2e0', '"2"', '3', '-1', 'null', 'true'].map(token => valid.replace('"model_07":2', `"model_07":${token}`))]) expect(() => routerScores(bad)).toThrow();
  expect(() => routerScores(valid, v5Snapshot())).toThrow();
  expect(Object.keys(routerScores(JSON.stringify(Object.fromEntries(ids.slice(0, 4).map(id => [id, 1]))), v5Snapshot()))).toHaveLength(4);
});

for (const kind of ['starter', 'user'] as const) it(`keeps a v5 unsent draft and interrupted request through restart and opening changes (${kind})`, () => {
  const created = store.createSession();
  if (kind === 'user') store.setOpening(created.id, randomUUID(), 0, kind);
  const saved = JSON.stringify(v5Snapshot(kind)); raw.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(saved, created.id);
  store.saveDraft(created.id, 'An old unsent draft.'); store.close(); open();
  expect(store.session(created.id).chat_config).toBe(saved); expect(store.session(created.id).draft).toBe('An old unsent draft.');
  for (const next of [kind === 'user' ? 'starter' : 'user', kind] as const) {
    const session = store.session(created.id); store.setOpening(session.id, randomUUID(), session.opening_revision, next);
    expect(JSON.parse(store.session(session.id).chat_config).characters).toEqual(v5.conversation.characters);
  }
  expect(() => store.selectManual(created.id, 'model_05')).toThrow('invalid_character');
  store.selectManual(created.id, 'model_04'); store.searchMode(created.id, 'off'); store.submit(created.id, 'An old accepted message.');
  store.commitRoute(created.id, null, 'manual', null);
  const request = store.prepareChat(created.id, randomUUID()), body = store.chatBody(request.id);
  store.dispatch(request.id); const reply = store.prepareReply(created.id, request.id); store.checkpoint(reply.id, 'Retained partial.');
  store.close(); open();
  const retry = store.prepareChat(created.id, randomUUID()); expect(retry.config).toBe(request.config); expect(store.chatBody(retry.id)).toEqual(body);
  expect(body.messages[0].content.startsWith(v5.conversationPrompt)).toBe(true);
  store.dispatch(retry.id); const complete = store.prepareReply(created.id, retry.id); store.finishReply(retry.id, complete.id, 'Saved reply.', {});
  store.end(created.id); store.cancelEnd(created.id); const next = store.createSession(); expect(JSON.parse(next.chat_config).version).toBe('stomylos_conversation_v7');
  expect(JSON.parse(store.session(created.id).chat_config).characters[3].label).toBe('Everyday companion');
});

for (const partner of ids) for (const mode of ['auto', 'off'] as const) it(`preserves ${partner} identity, reasoning and ${mode} search through retry`, async () => {
  const session = store.createSession(); store.setOpening(session.id, randomUUID(), 0, 'user'); store.selectManual(session.id, partner);
  store.searchMode(session.id, mode); store.submit(session.id, 'Please retrieve the latest release notes.'); store.commitRoute(session.id, null, 'manual', null);
  let calls = 0;
  const gateway = { stream: async () => { calls++; return { content: '{"search":true}', metadata: {} }; } } as unknown as Gateway;
  await routeSearch({ view: async () => store.searchView(session.id), prepare: async () => store.searchPrepare(session.id), dispatch: async id => store.searchDispatch(id), finish: async (...args) => store.searchFinish(...args) }, gateway, new AbortController().signal);
  expect(calls).toBe(mode === 'auto' ? 1 : 0);
  const request = store.prepareChat(session.id, randomUUID()), body = store.chatBody(request.id), selected = characters.find(c => c.id === partner)!;
  expect(body.model).toBe(selected.model); expect(body.reasoning).toEqual(selected.reasoning); expect(!!body.tools).toBe(mode === 'auto');
  expect(JSON.parse(request.config).memory_context.character_id).toBe('shared');
  store.dispatch(request.id); store.prepareReply(session.id, request.id); store.close(); open();
  const retry = store.prepareChat(session.id, randomUUID()); expect(store.chatBody(retry.id)).toEqual(body);
  expect(store.session(session.id).character).toBe(partner);
});

it('gives all seven models the same memory while preserving their conversation identities', () => {
  const document = emptyMemory('shared');
  document.traits = ids.map((_, index) => ({ id: `preference-${index}`, text: `Public preference ${index}.` }));
  const encoded = memoryJson(document); raw.prepare('UPDATE shared_memory SET document=?,document_hash=? WHERE id=1').run(encoded, memoryHash(encoded));
  for (const partner of ids) {
    const session = store.createSession(); store.selectManual(session.id, partner); store.searchMode(session.id, 'off');
    store.submit(session.id, 'Tell me about your music.'); store.commitRoute(session.id, null, 'manual', null);
    const request = store.prepareChat(session.id, randomUUID()), body = store.chatBody(request.id);
    for (let other = 0; other < ids.length; other++) expect(body.messages[0].content).toContain(`Public preference ${other}.`);
    store.dispatch(request.id); const reply = store.prepareReply(session.id, request.id); store.finishReply(request.id, reply.id, 'My imagined story.', {}); store.end(session.id);
    expect(JSON.parse(store.memoryJob(session.id)!.source).character_id).toBe(partner);
    const attempt = store.prepareMemory(session.id, randomUUID()); store.dispatchMemory(attempt.id); store.saveMemory(attempt.id, '{"operations":[]}', {}); store.cancelEnd(session.id);
  }
  store.close(); open(); expect(raw.prepare('SELECT document FROM shared_memory').get()).toEqual({ document: encoded });
});

for (const model of models) it(`rejects identity drift and retains search evidence for ${model}`, () => {
  const event = (modelId: string, provider: string, content: string, finish: string | null = null, extra = {}) => `data: ${JSON.stringify({ model: modelId, provider, choices: [{ delta: { content }, finish_reason: finish }], ...extra })}\n\n`;
  const stream = new ChatStream(model, () => undefined, { search: true });
  stream.feed(event(model, 'SelectedProvider', 'Retrieved answer.'));
  expect(() => stream.feed(event(model, 'DifferentProvider', 'changed'))).toThrow();
  const wrong = new ChatStream(model, () => undefined);
  expect(() => wrong.feed(event(model + ':online', 'SelectedProvider', 'wrong identity'))).toThrow();
  const accepted = new ChatStream(model, () => undefined, { search: true });
  accepted.feed(event(model, 'SelectedProvider', 'Retrieved answer.', 'stop', { usage: { cost: 0.001, server_tool_use_details: { web_search_requests: 1 } } }));
  accepted.feed('data: [DONE]\n\n'); const result = accepted.feed('', true)!;
  expect(result.metadata.usage.cost).toBe(0.001); expect(result.metadata.search.web_search_requests).toBe(1);
});

// Frozen 0.15.0 conversations can carry either original per-character or shared memory.
import v6 from '../src/main/conversation-v6-config.json';
import { conversationComponents } from '../src/main/contracts';
function v6Snapshot(kind: 'starter' | 'user', memory = 'stomylos_memory_context_v3') {
  const base = conversationSnapshot(kind); delete base.router_prompt_version;
  return { ...base, ...structuredClone(v6.conversation), memory_version: memory,
    component_hashes: conversationComponents(v6.conversation.version, memory) };
}
for (const kind of ['starter', 'user'] as const) for (const memory of ['stomylos_memory_context_v2', 'stomylos_memory_context_v3']) {
  it(`preserves v6 ${kind} ${memory} drafts, routes and retries after adding Taste`, () => {
    expect(hash(readFileSync('src/main/conversation-v6-config.json', 'utf8'))).toBe('291ea61aa8be5945ac389427ba7bae943de14a1b73e7e2617c8865d1ba6251c7');
    const old = v6Snapshot(kind, memory), snapshot = store.createSession();
    if (kind === 'user') store.setOpening(snapshot.id, randomUUID(), 0, kind);
    raw.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(old), snapshot.id);
    const question = kind === 'user' ? null : 'An old question?';
    const body = routerBody(question, 'Old draft.', old);
    expect(body.response_format).toEqual(v6.router.response_format);
    expect(body.messages[0].content).toBe(readFileSync(`src/main/${kind === 'user' ? 'direct' : kind}-router-six-prompt.txt`, 'utf8'));
    expect(routerSnapshot(old).version).toBe(kind === 'user' ? 'stomylos_character_router_v5' : 'stomylos_character_router_v4');
    expect(() => store.selectManual(snapshot.id, 'model_08')).toThrow('invalid_character');
    store.saveDraft(snapshot.id, 'An old six-model draft.'); store.close(); open();
    expect(JSON.parse(store.session(snapshot.id).chat_config)).toEqual(old);
    const changed = kind === 'user' ? 'starter' : 'user';
    let session = store.session(snapshot.id); store.setOpening(session.id, randomUUID(), session.opening_revision, changed);
    session = store.session(snapshot.id); store.setOpening(session.id, randomUUID(), session.opening_revision, kind);
    expect(JSON.parse(store.session(session.id).chat_config)).toEqual(old);
    store.selectManual(session.id, 'model_07'); store.searchMode(session.id, 'off');
    store.submit(session.id, 'An exact old message.'); store.commitRoute(session.id, null, 'manual', null);
    const req = store.prepareChat(session.id, randomUUID()), oldBody = store.chatBody(req.id);
    store.dispatch(req.id); store.prepareReply(session.id, req.id); store.close(); open();
    const retry = store.prepareChat(session.id, randomUUID()); expect(store.chatBody(retry.id)).toEqual(oldBody);
    expect(JSON.parse(retry.config).version).toBe(v6.conversation.version);
    expect(JSON.parse(retry.config).characters).toEqual(v6.conversation.characters);
    expect(() => conversationRequestSnapshot({ ...old, characters })).toThrow();
    expect(() => conversationRequestSnapshot({ ...conversationSnapshot(kind), characters: old.characters })).toThrow();
  });
}
it('keeps Taste eligible only through fit scores, with no cost preference or persona injection', () => {
  const scores = Object.fromEntries(ids.map(id => [id, 1])); scores.model_04 = 2; scores.model_08 = 2;
  expect(eligible(routerScores(JSON.stringify(scores)))).toEqual(['model_04', 'model_08']);
  expect(leastUsed(['model_04', 'model_08'], { model_04: 1, model_08: 4 }, () => 0)).toBe('model_04');
  for (const kind of ['starter', 'user'] as const) {
    const prompt = routerBody(kind === 'user' ? null : 'Question?', 'Answer.', conversationSnapshot(kind)).messages[0].content;
    expect(prompt).toContain('model_08 — Taste');
    expect(prompt).not.toMatch(/cost|cheap|price|budget/i);
  }
  expect(config.conversation.characters.slice(0, 6)).toEqual(v6.conversation.characters);
  expect(config.router.route_policy).toEqual(v6.router.route_policy);
  expect(config.conversationPrompt).toBe(v6.conversationPrompt);
});
