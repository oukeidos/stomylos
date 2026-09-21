import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/database';
import * as contracts from '../src/main/contracts';
import { memoryContext } from '../src/main/memory-updater';
import { publicTime } from './time-fixtures';
import { recordedTime } from '../src/main/time-context';
import { withSearch } from '../src/main/search-contract';

let directory: string, store: Store, clock = publicTime;
function open() { store = new Store(directory, 'isolated' as const, () => 0, () => clock); }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'stomylos-cache-')); clock = publicTime; open(); });
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(directory, { recursive: true, force: true }); });
function start(partner = 'model_01') {
  const s = store.createSession();
  // Frozen pre-date sessions continue to exercise the historical cache contract.
  const db = new Database(join(directory, 'stomylos.sqlite3'));
  const saved = JSON.parse(s.chat_config); delete saved.conversation_date_version;
  db.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(saved), s.id); db.close();
  store.searchMode(s.id, 'off');
  store.setOpening(s.id, randomUUID(), s.opening_revision, 'user');
  store.selectManual(s.id, partner); store.submit(s.id, 'Tomorrow I will visit a museum.');
  store.commitRoute(s.id, null, 'fixture', null);
  return s.id;
}
function finish(id: string, requestId: string) {
  const started = store.startChat(requestId);
  store.finishReply(started.request.id, started.bubble.id, 'Which exhibit caught your eye?', {});
}

it('omits exactly the time addition, retains settings/history, and enables only selected Claude models', () => {
  for (const partner of contracts.characters) {
    const id = start(partner.id), request = store.prepareChat(id, randomUUID());
    const config = JSON.parse(request.config), body = store.chatBody(request.id);
    expect(body.messages[0].content).toBe(config.system_prompt + memoryContext(config.memory_context, config.memory_version));
    expect(body.messages[0].content).not.toContain('application_time_context');
    const history = JSON.parse(contracts.transcriptJson(store.messages(id)));
    expect(body.messages.slice(-history.length)).toEqual(history);
    expect(body.cache_control).toEqual(['model_01', 'model_03'].includes(partner.id) ? { type: 'ephemeral' } : undefined);
    expect(body.reasoning).toEqual(partner.reasoning);
    expect(body.provider).toEqual(config.provider); expect(body.max_tokens).toBe(config.max_tokens);
    expect(body.session_id).toBeUndefined(); expect(body.cache_version).toBeUndefined();
    expect(config.time_context.sources).toHaveLength(1);
    expect(config.system_sha256).toBe(contracts.hash(body.messages[0].content));
    expect(JSON.parse(store.session(id).chat_config).cache_version).toBeUndefined();
    expect(withSearch(body, true).cache_control).toEqual(body.cache_control);
    const invalid = { ...config, cache_version: 'unknown' };
    expect(() => contracts.conversationBody(invalid, partner.id, null, store.messages(id))).toThrow('unsupported_conversation_settings');
    store.end(id); store.deleteSession(id);
  }
});

it('retains an identical input prefix across midnight while time and memory-update sources still advance', () => {
  const id = start(), first = store.prepareChat(id, randomUUID()), body = store.chatBody(first.id);
  finish(id, first.id);
  clock = recordedTime('2026-09-07T08:00:00.000Z', 'America/New_York', -240);
  store.submit(id, 'I enjoyed the visit.');
  const next = store.prepareChat(id, randomUUID()), nextBody = store.chatBody(next.id);
  expect(nextBody.messages.slice(0, body.messages.length)).toEqual(body.messages);
  expect(JSON.parse(next.config).time_context.sources.map((s: any) => s.sent_time)).toEqual([publicTime, clock]);
  finish(id, next.id); store.end(id);
  const packet = JSON.parse(store.memoryAddReady()!.source_manifest!);
  expect(packet.messages.filter((m: any) => m.role === 'user').map((m: any) => m.sent_at)).toEqual([publicTime.utc, clock.utc]);
});

for (const historical of [false, true]) it(`preserves exact ${historical ? 'historical' : 'cached'} retries across restart, then adopts caching on a new Send`, () => {
  const id = start();
  if (historical) {
    const original = contracts.conversationRequestSnapshot;
    vi.spyOn(contracts, 'conversationRequestSnapshot').mockImplementationOnce(saved => {
      const snapshot = original(saved); delete snapshot.cache_version; return snapshot;
    });
  }
  const first = store.prepareChat(id, randomUUID()), body = store.chatBody(first.id);
  expect(body.messages[0].content.includes('<application_time_context>')).toBe(historical);
  expect(body.cache_control).toEqual(historical ? undefined : { type: 'ephemeral' });
  store.dispatch(first.id); store.failRequest(first.id, 'request_timeout');
  clock = recordedTime('2026-09-09T03:00:00.000Z', 'Asia/Seoul', 540);
  store.close(); open();
  const retry = store.prepareChat(id, randomUUID(), 'retry');
  expect(retry.config).toBe(first.config); expect(store.chatBody(retry.id)).toEqual(body);
  finish(id, retry.id); store.submit(id, 'Let us talk about paintings.');
  const next = store.prepareChat(id, randomUUID());
  expect(store.chatBody(next.id).messages[0].content).not.toContain('<application_time_context>');
  expect(store.chatBody(next.id).cache_control).toEqual({ type: 'ephemeral' });
});
