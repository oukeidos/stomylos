// Explicit external-converter gate. Fixtures contain only invented conversation text.
import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { conversationRequestSnapshot, conversationSnapshot, grammarSnapshot } from '../src/main/contracts';
const external = process.env.STOMYLOS_OPENING_CONVERTER!;
const root = mkdtempSync('/tmp/stomylos-opening-continuity-');
const native = resolve('native/advisory-lock.node');
const fixtures: string[] = [];
for (const version of [3, 4]) for (const state of ['draft', 'active']) it(`preserves and resumes the exact v${version} ${state} fixture through external v5 conversion`, () => {
  const base = join(root, `v${version}-${state}`); mkdirSync(base);
  const seed = join(base, 'seed'); mkdirSync(seed);
  let store = new Store(seed, native);
  const raw = new Database(join(seed, 'stomylos.sqlite3'));
  function legacy() {
    const s = store.createSession(); raw.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(conversationSnapshot(), null, 2), s.id); return s;
  }
  function started() {
    const s = legacy(); store.selectManual(s.id, 'model_04'); const user = store.submit(s.id, '  I enjoys quiet museums.\n한글  ');
    store.commitRoute(s.id, null, 'public-fixture', null); store.freezeMemory(s.id); return { s, user };
  }
  const first = started(); store.end(first.s.id);
  const memory = store.prepareMemory(first.s.id, 'memory-public'); store.dispatchMemory(memory.id);
  store.saveMemory(memory.id, JSON.stringify({ operations: [{ op: 'add', id: null, category: 'traits', text: 'Enjoys quiet museums.', source_message_ids: [first.user.id] }] }), {});
  const renewal = store.starterAttempts(store.starterJob(first.s.id)!.id)[0]; store.dispatchStarter(renewal.id);
  store.saveStarter(renewal.id, 'What would a paper moon remind you of?\nWhat makes a quiet place welcoming?', {});
  if (version === 4) store.deleteSession(first.s.id);
  const failed = started(); store.end(failed.s.id);
  const failedMemory = store.prepareMemory(failed.s.id, 'failed-memory'); store.dispatchMemory(failedMemory.id); store.failMemory(failedMemory.id, 'public-timeout');
  const failedJob = store.starterJob(failed.s.id)!;
  const failedRenewal = store.starterAttempts(failedJob.id)[0]; store.dispatchStarter(failedRenewal.id); store.failStarter(failedRenewal.id, 'public-timeout');
  const grammar = store.createRequest(failed.s.id, 'grammar', grammarSnapshot()); store.dispatch(grammar.id); store.failRequest(grammar.id, 'public-timeout');
  const blocked = started(); store.end(blocked.s.id); expect(store.view(blocked.s.id).memory.blockedBy).toBe(failed.s.id);
  const current = state === 'draft' ? { s: legacy() } : started();
  store.saveDraft(current.s.id, '  Exact draft\n한글  ');
  if (state === 'active') {
    const request = store.createRequest(current.s.id, 'chat', conversationRequestSnapshot(JSON.parse(store.session(current.s.id).chat_config)));
    const reply = store.prepareReply(current.s.id, request.id); store.dispatch(request.id); store.checkpoint(reply.id, 'An interrupted public response.');
    store.failRequest(request.id, 'public-interruption', 'An interrupted public response.', {}, true);
  }
  raw.close(); store.close();
  const original = join(base, 'original'), converted = join(base, 'converted');
  execFileSync('python3', [join(external, 'freeze_source.py'), seed, original, String(version)]);
  mkdirSync(converted); copyFileSync(join(original, 'stomylos.sqlite3'), join(converted, 'stomylos.sqlite3'));
  const report = JSON.parse(execFileSync('python3', [join(external, 'convert.py'), '--directory', converted, '--apply'], { encoding: 'utf8' }));
  expect(report.source_version).toBe(version); expect(report.target_version).toBe(5);
  const before = readFileSync(join(original, 'stomylos.sqlite3'));
  expect(() => new Store(original, native)).toThrow('external_migration_required'); expect(readFileSync(join(original, 'stomylos.sqlite3'))).toEqual(before);
  const old = new Database(join(original, 'stomylos.sqlite3'), { readonly: true });
  const candidate = new Database(join(converted, 'stomylos.sqlite3'), { readonly: true });
  store = new Store(converted, native);
  for (const { name } of old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
    const cols = (old.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(c => `"${c.name}"`).join(',');
    expect(candidate.prepare(`SELECT rowid,${cols} FROM ${name} ORDER BY rowid`).all()).toEqual(old.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all());
  }
  candidate.close(); old.close();
  expect(store.session(current.s.id).draft).toBe('  Exact draft\n한글  ');
  expect(store.session(current.s.id).opening_kind).toBe('starter');
  expect(() => store.setOpening(current.s.id, 'new-mode', 0, 'user')).toThrow('unsupported_opening');
  expect(store.view(blocked.s.id).memory.blockedBy).toBe(failed.s.id);
  expect(store.pendingDeletions()).toEqual(version === 4 ? [first.s.id] : []);
  store.close();
  // Keep an untouched acceptance copy for two packaged starts before explicit retry tests.
  const packaged = join(base, 'packaged'); mkdirSync(packaged); copyFileSync(join(converted, 'stomylos.sqlite3'), join(packaged, 'stomylos.sqlite3')); fixtures.push(packaged);
  store = new Store(converted, native);
  const retry = store.retryStarter(failed.s.id, 'public-retry');
  expect(store.starterJob(failed.s.id)!.config).toBe(failedJob.config);
  expect(store.starterJob(failed.s.id)!.input_json).toBe(failedJob.input_json);
  store.dispatchStarter(retry.id); store.saveStarter(retry.id, 'Which tree would you visit again?\nWhat makes a good afternoon?', {});
  store.retryMemory(failed.s.id); const a = store.prepareMemory(failed.s.id, 'memory-retry'); expect(a.input_json).toBe(failedMemory.input_json);
  store.dispatchMemory(a.id); store.saveMemory(a.id, '{"operations":[]}', {});
  const g = store.createRequest(failed.s.id, 'grammar', JSON.parse(grammar.config), grammar.id); store.dispatch(g.id);
  store.saveAnalysis(g.id, JSON.stringify({ units: [{ text: failed.user.content, corrected_text: '  I enjoy quiet museums.\n한글  ', explanation: 'Use enjoy with I.' }] }), {});
  expect(store.view(blocked.s.id).memory.blockedBy).toBeNull(); expect(store.integrity().foreignKeys).toEqual([]);
  if (version === 4) { expect(store.deletionAssets(first.s.id)).toEqual({ speechKeys: [], dictationIds: [] }); store.finishDeletion(first.s.id); }
  store.close();
  writeFileSync(join(base, 'continuity.json'), JSON.stringify({ status: 'passed', version, state, conversion: report, originalRowsPreserved: true, retriesPassed: true, paidRequests: 0 }, null, 2));
  writeFileSync('test-results/opening-continuity.json', JSON.stringify({ status: 'passed', root, fixtures, paidRequests: 0 }, null, 2));
});
