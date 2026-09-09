import selectedIntention from './fixtures/intention-selected.json';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { hash } from '../src/main/contracts';
import { emptyMemory, memoryHash, memoryJson } from '../src/main/memory-updater';
import { intentionBody, intentionConfig, intentionDiff, intentionFallback, parseIntentionQuestion } from '../src/main/intention-questions';
import { validateCommand } from '../src/main/ipc';
let directory: string, store: Store, raw: Database.Database;
const native = resolve('native/advisory-lock.node');
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'stomylos-intentions-')); store = new Store(directory, native); raw = (store as unknown as { db: Database.Database }).db; });
afterEach(() => { vi.useRealTimers(); store.close(); rmSync(directory, { recursive: true, force: true }); });
function ended() {
  const s = store.createSession(); store.searchMode(s.id, 'off'); store.selectManual(s.id, 'model_04');
  const message = store.submit(s.id, 'I am considering a trip.'); store.commitRoute(s.id, null, 'fixture', null); store.end(s.id);
  const attempt = store.prepareMemory(s.id, randomUUID()); store.dispatchMemory(attempt.id);
  return { id: s.id, message, attempt };
}
function memory(operations: any[]) {
  const s = ended(), content = JSON.stringify({ operations: operations.map(op => ({ ...op, source_message_ids: ['u1'] })) });
  const doc = store.saveMemory(s.attempt.id, content, {}); return { ...s, doc, content, jobs: store.intentionJobs(s.id) };
}
const add = (text = 'Wants to plan a trip.') => ({ op: 'add', id: null, category: 'intentions', text });
const update = (id: string, text: string) => ({ op: 'update', id, category: 'intentions', text });
const remove = (id: string) => ({ op: 'delete', id, category: null, text: null });
it('pins all tested inputs, prompt bytes, routes and reasoning without adding context', () => {
  const config = intentionConfig(), saved = selectedIntention.routes;
  expect(hash(config.prompt)).toBe(selectedIntention.prompt_sha256);
  expect(config.routes.map((route: any) => route.parameters.model)).toEqual(saved.map(route => route.model));
  for (const [i, route] of config.routes.entries()) {
    const row = saved.find((r: any) => r.model === route.parameters.model);
    if (!row) throw new Error('Missing frozen Intention route');
    expect(route.parameters.reasoning).toEqual(row.reasoning);
    expect(route.parameters.max_tokens).toBe(row.max_tokens);
    expect(route.parameters.provider.only).toEqual([row.provider_tag]);
    const input = JSON.stringify({ operation: 'add', intention: 'Try drawing.' });
    expect(intentionBody(config, input, i).messages).toEqual([{ role: 'system', content: config.prompt }, { role: 'user', content: input }]);
  }
  const corrupt = structuredClone(config); corrupt.routes[0].parameters.temperature = 1;
  expect(() => intentionBody(corrupt, '{}', 0)).toThrow('intention_config_changed');
  expect(() => validateCommand('retryIntentionQuestions', { sessionId: 'id' })).toThrow('invalid_command');
});
it('validates one question while tolerating quoted titles and plain unremarkable questions', () => {
  for (const q of ['What would you like to try?', 'What did “Why?” mean to you?', "How would reading 'Why?' fit your plans?"]) expect(parseIntentionQuestion('  ' + q + '  ')).toBe(q);
  for (const q of ['One? Two?', '1. What next?', 'Question: What next?', 'What next?\nSomething else?', 'No.', '```What next?']) expect(() => parseIntentionQuestion(q)).toThrow('intention_output_format');
  for (const code of ['http_429','http_503','request_timeout','response_identity','intention_output_format']) expect(intentionFallback(code)).toBe(true);
  for (const code of ['http_401','http_402','operation_failed','request_cancelled','intention_config_changed']) expect(intentionFallback(code)).toBe(false);
});
it('diffs category membership and exact text, not global document revisions', () => {
  expect(intentionDiff([{ id: 'a', text: 'A' }], [{ id: 'a', text: 'A' }])).toEqual([]);
  expect(intentionDiff([{ id: 'a', text: 'A' }], [{ id: 'b', text: 'B' }])).toEqual([{ id: 'a', previous: 'A', text: null }, { id: 'b', previous: null, text: 'B' }]);
});

it('keeps Intention memory without any question generation and no dedicated jobs are created', () => {
  const s = ended();
  expect(store.starterJob(s.id)).toBeNull();
  store.saveMemory(s.attempt.id, JSON.stringify({operations:[{...add(),source_message_ids:['u1']}]}), {});
  expect(store.currentMemory().intentions).toHaveLength(1);
  expect(store.intentionJobs(s.id)).toEqual([]);
  expect(store.starterJob(s.id)).toBeNull();
  expect(store.view(s.id).intentions).toBeUndefined();
});
