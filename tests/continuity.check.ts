import { expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { conversationBody, hash, isLearner, transcriptJson } from '../src/main/contracts';
import type { Json } from '../src/shared/types';

const root = process.env.STOMYLOS_CONTINUITY_DIR!;
const tables = ['sessions', 'messages', 'starter_events', 'model_requests', 'route_decisions', 'grammar_units'];
function dump(directory: string) {
  const raw = new Database(join(directory, 'stomylos.sqlite3'), { readonly: true });
  try { return { tables: Object.fromEntries(tables.map(name => [name, raw.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])),
    integrity: raw.pragma('integrity_check'), foreignKeys: raw.pragma('foreign_key_check') }; }
  finally { raw.close(); }
}
it('opens externally converted legacy data, matches recovery and saves v2 renewal without historical backfill', () => {
  const before = JSON.parse(readFileSync(join(root, 'before.json'), 'utf8'));
  const reference = JSON.parse(readFileSync(join(root, 'recovered.json'), 'utf8'));
  const recoveryIds = new Set(before.tables.model_requests.filter((r: Json) => ['queued', 'dispatched'].includes(r.status)).map((r: Json) => r.id));
  const normalizeRecoveryTime = (value: any) => {
    const result = structuredClone(value);
    for (const request of result.tables.model_requests) if (recoveryIds.has(request.id)) {
      expect(request.finished_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/); request.finished_at = '<recovery-time>';
    }
    return result;
  };
  const original = join(root, 'original'); const originalBytes = readFileSync(join(original, 'stomylos.sqlite3'));
  expect(() => new Store(original, resolve('native/advisory-lock.node'))).toThrow('external_migration_required');
  expect(readFileSync(join(original, 'stomylos.sqlite3'))).toEqual(originalBytes);
  const directory = join(root, 'electron-copy');
  expect(dump(directory)).toEqual(before);
  let store = new Store(directory, resolve('native/advisory-lock.node'));
  try {
    expect(normalizeRecoveryTime(dump(directory))).toEqual(normalizeRecoveryTime(reference));
    const counts = before.tables.sessions.reduce((result: Json, session: Json) => { result[session.analysis_state] = (result[session.analysis_state] ?? 0) + 1; return result; }, {});
    expect(counts).toEqual({ completed: 1, skipped: 1, pending: 1, running: 2, failed: 1, none: 1 });
    for (const session of store.sessions()) {
      expect(store.starterJob(session.id)).toBeNull();
      expect(session.created_at).toBe('2026-08-31T09:10:11.123456Z');
      expect(session.chat_config).toContain('\n  "version"');
      for (const request of store.requests(session.id)) expect(hash(request.config)).toBe(request.config_hash);
      if (session.state === 'ended') expect(hash(transcriptJson(store.messages(session.id)))).toBe(session.source_hash);
    }
    const complete = store.sessions().find(s => s.analysis_state === 'completed')!;
    expect(store.units(complete.id)).toHaveLength(2);
    expect(store.units(complete.id)[0].text).toBe(store.units(complete.id)[1].text);
    expect(store.units(complete.id)[0].source_message_id).not.toBe(store.units(complete.id)[1].source_message_id);
    const pending = store.sessions().find(s => s.analysis_state === 'pending')!;
    const request = store.createRequest(pending.id, 'grammar', JSON.parse(pending.grammar_config!)); store.dispatch(request.id);
    const content = JSON.stringify({ units: store.messages(pending.id).filter(isLearner).map(m => ({ text: m.content, corrected_text: m.content, explanation: '' })) });
    store.saveAnalysis(request.id, content, {});

    const active = store.sessions().find(s => s.state !== 'ended')!;
    const old = store.requests(active.id).find(r => r.role === 'chat')!;
    const source = store.messages(active.id, old.source_sequence); const snapshot = JSON.parse(active.chat_config);
    expect(conversationBody(snapshot, active.character!, active.starter_text, source).messages[0].content).toBe(snapshot.system_prompt);
    const retried = store.createRequest(active.id, 'chat', snapshot, old.id);
    expect(retried.source_hash).toBe(old.source_hash); store.dispatch(retried.id);
    const bubble = store.prepareReply(active.id, retried.id); store.finishReply(retried.id, bubble.id, 'Electron resumed this public legacy conversation.', {});
    expect(store.request(old.id).response_content).toBe('A public partial reply before a crash.');
    store.submit(active.id, '//end'); expect(store.messages(active.id).at(-1)?.content).toBe('/end');
    store.end(active.id);
    const renewal = store.starterJob(active.id)!; const attempt = store.starterAttempts(renewal.id)[0];
    expect(JSON.parse(renewal.input_json).skip_history_status.earlier_history).toBe('unavailable');
    store.dispatchStarter(attempt.id); store.saveStarter(attempt.id, 'Which season would you keep in a drawer?\nWhat does a familiar street teach you?', {});
    const inventory = store.starterInventory();
    const newSession = store.createSession(); store.saveDraft(newSession.id, 'New Electron draft.\n한글');
    expect(store.integrity()).toEqual({ integrity: [{ integrity_check: 'ok' }], foreignKeys: [] });
    store.close(); store = new Store(directory, resolve('native/advisory-lock.node'));
    expect(store.session(newSession.id).draft).toBe('New Electron draft.\n한글');
    expect(store.session(active.id).source_hash).toBe(hash(transcriptJson(store.messages(active.id))));
    expect(store.starterInventory().slots).toEqual(inventory.slots); expect(store.starterInventory().queued).toEqual(inventory.queued);
    expect(store.starterJob(active.id)?.state).toBe('completed');
  } finally { store.close(); }
  const after = dump(directory);
  // Every old immutable field remains exact, including noncanonical JSON bytes.
  for (const old of before.tables.model_requests) {
    const current = (after.tables.model_requests as Json[]).find(r => r.id === old.id)!;
    for (const field of ['id','session_id','role','parent_id','created_at','source_sequence','source_hash','config','config_hash']) expect(current[field]).toEqual(old[field]);
  }
  writeFileSync(join(root, 'electron-after.json'), JSON.stringify(after));
});
