import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { grammarSnapshot } from '../src/main/contracts';
import { patternBody, patternContract, patternEstimate, patternHash, patternLimits, selectPatternScope, validatePatternHtml, verifyPatternRuntime } from '../src/main/pattern-report';
import { historicalPatternContract, makePatternHistorical } from './pattern-report-history';
import type { PatternSource } from '../src/shared/pattern-report';
import { validateCommand } from '../src/main/ipc';

let directory: string, store: Store;
const native = resolve('native/advisory-lock.node');
const html = '<!DOCTYPE html><html><head><title>Practice</title></head><body><p>No recurring pattern established.</p></body></html>';
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'stomylos-pattern-')); store = new Store(directory, native); });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function seed(n = 5, changed = false, mixed = false) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = store.createSession(); ids.push(s.id);
    if(mixed){if(i%2)store.setOpening(s.id,randomUUID(),0,'user');store.selectManual(s.id,`model_0${i%4+1}`);}
    const text = 'Yesterday I ' + (changed ? 'go' : 'went') + ' to the park.';
    store.submit(s.id, text); store.end(s.id);
    const a = store.createRequest(s.id, 'grammar', grammarSnapshot()); store.dispatch(a.id);
    store.saveAnalysis(a.id, JSON.stringify({ units: [{ index: 0, corrected_text: 'Yesterday I went to the park.', explanation: changed ? 'The event is finished.' : '' }] }), {});
  }
  return ids;
}
const source = (id: string, ended = '2026-09-05T00:00:00.000Z', size = 1): PatternSource => ({ session_id: id,
  analysis_id: id + '-analysis', ended_at: ended, source_hash: id,
  units: [{ source_id: id + '-U01', message_id: id + '-message', ordinal: 0, original: 'x'.repeat(size), corrected: 'x'.repeat(size), explanation: '' }] });

it('assembles the exact selected v2 system and retains v1 prompt/settings parity', () => {
  verifyPatternRuntime();
  expect(patternHash(readFileSync('src/main/pattern-prompt.txt', 'utf8'))).toBe('a5506ccb2b087690efd0567ca9eed3d4edee0d9f2bc82b19c6c94edf5ad9d435');
  expect(patternContract.parameters).toMatchObject({ model: 'openai/gpt-6-astra', reasoning: { effort: 'medium', exclude: true }, max_tokens: 32768, stream: false });
  const body = patternBody([source('s')]);
  expect(patternContract.version).toBe('stomylos_pattern_report_v2');
  expect(body.messages[0].content).toBe(readFileSync('tests/fixtures/pattern-reports/system-v2.txt', 'utf8'));
  expect(patternHash(body.messages[0].content)).toBe('99b6d13bb9100558047500dec6d3ad849bc862affd24809eb0ada18e3e982c74');
  expect(patternBody([source('s')], historicalPatternContract).messages[0].content).toBe(readFileSync('tests/fixtures/pattern-reports/system-v1.txt', 'utf8'));
  expect(patternContract.parameters).toEqual(historicalPatternContract.parameters);
  expect(patternContract.identity).toEqual(historicalPatternContract.identity);
  expect(body.messages[0].content).toContain('at least three distinct supplied sessions');
  expect(JSON.parse(body.messages[1].content).sessions[0]).toMatchObject({ ended_at: source('s').ended_at, units: [{ text: 'x', corrected_text: 'x', explanation: '', source_id: 's-U01' }] });
});

it('counts the complete style instruction and preserves the five-session admission boundary', () => {
  const five = Array.from({ length: 5 }, (_, i) => source(String(i), undefined, 1000));
  const result = selectPatternScope(five, '2026-09-05T00:00:00Z');
  expect(result.preview.blocked).toBeNull(); expect(result.sources).toHaveLength(5);
  expect(patternEstimate(patternBody(five)) - patternEstimate(patternBody(five, historicalPatternContract))).toBe(3500);
  const edge = five.map(s => ({ ...s, units: s.units.map(u => ({ ...u, original: 'x'.repeat(1300), corrected: 'x'.repeat(1300) })) }));
  expect(patternEstimate(patternBody(edge, historicalPatternContract))).toBeLessThanOrEqual(20000);
  expect(patternEstimate(patternBody(edge))).toBeGreaterThan(20000);
  const trimmed = selectPatternScope(edge, '2026-09-05T00:00:00Z');
  expect(trimmed.sources).toHaveLength(4); expect(trimmed.preview.blocked).toBe('input_limit');
  expect(trimmed.sources.map(s => s.session_id)).toEqual(['4', '3', '2', '1']);
  expect(trimmed.preview.scope.estimate).toBe(Buffer.byteLength(JSON.stringify(trimmed.body)) + 1024);
});

it.each(['failed', 'cancelled', 'dispatched', 'queued'] as const)('retains exact v1 retry bytes after reopening a %s attempt', status => {
  seed(); const r = store.patternCreate(store.patternPreview().fingerprint, randomUUID());
  const old = makePatternHistorical(directory, r.id);
  if (status !== 'queued') store.patternDispatch(r.attemptId!);
  if (status === 'failed' || status === 'cancelled') store.patternFinish(r.attemptId!, status, 'request_cancelled', null, {});
  store.close(); store = new Store(directory, native);
  expect(store.patternDetail(r.id).canRetry).toBe(true);
  expect(store.patternDetail(r.id).attempts).toHaveLength(1);
  const a = store.patternRetry(r.id, randomUUID());
  expect(a.request).toBe(old.request); expect(a.request_hash).toBe(patternHash(old.request));
  expect(store.patternDispatch(a.id).contract).toEqual(historicalPatternContract);
  store.patternSave(a.id, html, {});
  expect(store.patternHtml(r.id).html).toBe(html);
});

it('keeps completed v1 HTML and creates/reuses a separate v2 report for identical evidence', () => {
  seed(); const r = store.patternCreate(store.patternPreview().fingerprint, randomUUID());
  makePatternHistorical(directory, r.id);
  store.patternDispatch(r.attemptId!); store.patternSave(r.attemptId!, html, {});
  store.close(); store = new Store(directory, native);
  expect(store.patternHtml(r.id).html).toBe(html);
  const p = store.patternPreview(); expect(p.existingId).toBeNull();
  const revised = store.patternCreate(p.fingerprint, randomUUID());
  expect(revised.id).not.toBe(r.id);
  expect(JSON.parse(store.patternAttempt(revised.attemptId!).request).messages[0].content).toContain('calm editorial field-guide');
  store.patternDispatch(revised.attemptId!); store.patternSave(revised.attemptId!, html, {});
  expect(store.patternCreate(store.patternPreview().fingerprint, randomUUID())).toMatchObject({ id: revised.id, reused: true });
  expect(store.patternHtml(r.id).html).toBe(html);
  expect(store.patternList(0).reports).toHaveLength(2);
});

it.each(['contract', 'request', 'request_with_updated_hash'])('blocks a changed historical %s and hides retry', mutation => {
  seed(); const r = store.patternCreate(store.patternPreview().fingerprint, randomUUID());
  makePatternHistorical(directory, r.id);
  store.patternFinish(r.attemptId!, 'failed', 'request_timeout', null, {});
  const db = new Database(join(directory, 'stomylos.sqlite3'));
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('immutable_pattern_snapshot','immutable_pattern_request','immutable_pattern_result')").all() as { name: string; sql: string }[];
  for (const t of triggers) db.exec('DROP TRIGGER ' + t.name);
  if (mutation === 'contract') {
    const row = db.prepare('SELECT snapshot FROM pattern_reports WHERE id=?').get(r.id) as { snapshot: string };
    const snapshot = JSON.parse(row.snapshot); snapshot.contract.version = 'unrecognized';
    db.prepare('UPDATE pattern_reports SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), r.id);
  } else {
    const body = JSON.parse(store.patternAttempt(r.attemptId!).request); body.messages[0].content = 'Changed prompt';
    const request = JSON.stringify(body);
    db.prepare('UPDATE pattern_report_attempts SET request=? WHERE id=?').run(request, r.attemptId!);
    if (mutation === 'request_with_updated_hash') db.prepare('UPDATE pattern_report_attempts SET request_hash=? WHERE id=?').run(patternHash(request), r.attemptId!);
  }
  for (const t of triggers) db.exec(t.sql);
  db.close();
  expect(store.patternDetail(r.id).canRetry).toBe(false);
  expect(() => store.patternRetry(r.id, randomUUID())).toThrow(/pattern_(unsupported_contract|request_changed)/);
});

it('selects an inclusive 90-day newest prefix with deterministic ties and a five-session minimum', () => {
  const at = '2026-09-05T00:00:00.000Z';
  const cutoff = new Date(Date.parse(at) - 90 * 86400000).toISOString();
  for (const n of [0, 4, 5, 20, 21]) {
    const s = selectPatternScope(Array.from({ length: n }, (_, i) => source(String(i).padStart(2, '0'))), at);
    expect(s.sources).toHaveLength(Math.min(n, 20)); expect(s.preview.blocked).toBe(n < 5 ? 'insufficient' : null);
    if (n) expect(s.sources[0].session_id).toBe(String(n - 1).padStart(2, '0'));
  }
  const s = selectPatternScope([source('edge', cutoff), source('old', new Date(Date.parse(cutoff) - 1).toISOString()), source('future', '2026-09-06T00:00:00Z')], at);
  expect(s.sources.map(s => s.session_id)).toEqual(['edge']);
  expect(selectPatternScope([source('a')], at).preview.fingerprint).toBe(selectPatternScope([source('a')], '2026-09-05T01:00:00Z').preview.fingerprint);
});

it('removes complete oldest sessions, never bypassing an oversized newer session or cutting Unicode evidence', () => {
  const sources = Array.from({ length: 20 }, (_, i) => source(String(i).padStart(2, '0'), undefined, 650));
  const result = selectPatternScope(sources, '2026-09-05T00:00:00Z');
  expect(result.sources.length).toBeGreaterThanOrEqual(5); expect(result.sources.length).toBeLessThan(20);
  expect(result.preview.scope.estimate).toBeLessThanOrEqual(patternLimits.input);
  expect(result.sources[0].session_id).toBe('19'); expect(result.sources.at(-1)?.session_id).toBe(String(20 - result.sources.length).padStart(2, '0'));
  const large = source('z', undefined, 30000); large.units[0].explanation = '한글 👩🏽‍💻 é';
  const blocked = selectPatternScope([...sources, large], '2026-09-05T00:00:00Z');
  expect(blocked.sources).toEqual([]); expect(blocked.preview.blocked).toBe('input_limit');
  expect(large.units[0].original).toHaveLength(30000); expect(large.units[0].explanation).toBe('한글 👩🏽‍💻 é');
});

it('uses selected analyses including unchanged units, freezes exact sources and reuses identical input across restarts', () => {
  const ids = seed(); const preview = store.patternPreview(); expect(preview.scope.count).toBe(5);
  const op = randomUUID(), result = store.patternCreate(preview.fingerprint, op);
  const detail = store.patternDetail(result.id); expect(detail.sources.map(s => s.session_id).sort()).toEqual(ids.sort());
  expect(detail.sources.every(s => s.units[0].original === s.units[0].corrected)).toBe(true);
  const a = store.patternAttempt(result.attemptId!); const body = JSON.parse(a.request);
  expect(body.messages[1].content).not.toContain('starter');
  store.patternDispatch(a.id); store.patternSave(a.id, html, { usage: { cost: 0.3 } });
  store.patternSave(a.id, html, { usage: { cost: 0.3 } });
  expect(() => store.patternSave(a.id, html.replace('Practice', 'Changed'), {})).toThrow('pattern_already_resolved');
  store.close(); store = new Store(directory, native);
  expect(store.patternHtml(result.id).html).toBe(html);
  expect(store.patternCreate(store.patternPreview().fingerprint, randomUUID())).toMatchObject({ id: result.id, reused: true, attemptId: null });
  expect(store.patternDetail(result.id).attempts).toHaveLength(1);
});

it('rejects stale preview and duplicate operation payloads, and enforces one active attempt in SQLite', () => {
  seed(); const p = store.patternPreview(); seed(1);
  expect(() => store.patternCreate(p.fingerprint, randomUUID())).toThrow('pattern_scope_changed');
  const fresh = store.patternPreview(), op = randomUUID(), r = store.patternCreate(fresh.fingerprint, op);
  expect(store.patternCreate(fresh.fingerprint, op).attemptId).toBe(r.attemptId);
  expect(() => store.patternCreate(p.fingerprint, op)).toThrow('pattern_operation_conflict');
  seed(1); expect(() => store.patternCreate(store.patternPreview().fingerprint, randomUUID())).toThrow('pattern_busy');
});

it('retains exact retry input and unknown outcomes without restart dispatch; rejects re-upload after source deletion', () => {
  const ids = seed(); const r = store.patternCreate(store.patternPreview().fingerprint, randomUUID());
  const original = store.patternAttempt(r.attemptId!); store.patternDispatch(original.id);
  store.close(); store = new Store(directory, native);
  expect(store.patternDetail(r.id).status).toBe('interrupted');
  expect(store.patternDetail(r.id).failure).toBe('interrupted_unknown_outcome');
  const retry = store.patternRetry(r.id, randomUUID()); expect(retry.request).toBe(original.request);
  store.patternFinish(retry.id, 'cancelled', 'request_cancelled', null, {});
  store.deleteSession(ids[0]);
  expect(store.patternDetail(r.id).sources.filter(s => s.deleted)).toHaveLength(1);
  expect(store.patternDetail(r.id).canRetry).toBe(false);
  expect(() => store.patternRetry(r.id, randomUUID())).toThrow('pattern_source_deleted');
});

it('retains completed reports after chat deletion; whole-report deletion preserves remaining chats and removes owned rows', () => {
  const ids = seed(5, true); const r = store.patternCreate(store.patternPreview().fingerprint, randomUUID());
  store.patternDispatch(r.attemptId!); store.patternSave(r.attemptId!, html, {});
  store.deleteSession(ids[0]); expect(store.patternHtml(r.id).html).toBe(html);
  store.patternDelete(r.id); store.patternDelete(r.id);
  expect(store.patternList(0).reports).toEqual([]); expect(store.sessions()).toHaveLength(4);
  expect(store.integrity().foreignKeys).toEqual([]);
  const db = new Database(join(directory, 'stomylos.sqlite3'), { readonly: true });
  expect(db.prepare('SELECT count(*) n FROM pattern_report_attempts').get()).toEqual({ n: 0 }); db.close();
});

it('rejects malformed/oversized HTML and IPC extras while keeping unsupported execution inside the viewer boundary', () => {
  expect(validatePatternHtml(html)).toBe(html);
  for (const content of ['```html\n' + html + '\n```', html.slice(0, -7), '<p>partial</p>', html.replace('Practice', 'x'.repeat(512 * 1024))]) expect(() => validatePatternHtml(content)).toThrow();
  expect(() => validateCommand('patternCreate', { fingerprint: '0'.repeat(64), operationId: 'test' })).not.toThrow();
  for (const [name, args] of [['patternOpen', { id: '../key' }], ['patternCreate', { fingerprint: '0'.repeat(64), operationId: 'test', html }], ['patternList', { offset: -1 }], ['patternState', {}]]) expect(() => validateCommand(name, args)).toThrow('invalid_command');
});

it('rejects changed selected evidence before dispatch or retry without rewriting the frozen packet', () => {
  const ids=seed();const r=store.patternCreate(store.patternPreview().fingerprint,randomUUID());
  const original=store.patternAttempt(r.attemptId!);
  const db=new Database(join(directory,'stomylos.sqlite3'));
  db.prepare('UPDATE grammar_units SET explanation=? WHERE session_id=?').run('A later changed explanation.',ids[0]);db.close();
  expect(()=>store.patternDispatch(original.id)).toThrow('pattern_source_changed');
  store.patternFinish(original.id,'failed','pattern_source_changed',null,{});
  expect(store.patternDetail(r.id).canRetry).toBe(false);
  expect(()=>store.patternRetry(r.id,randomUUID())).toThrow('pattern_source_changed');
  expect(store.patternAttempt(original.id).request).toBe(original.request);
  expect(store.patternDetail(r.id).sources.find(s=>s.session_id===ids[0])!.units[0].explanation).toBe('');
});

it('lists unavailable analyses separately and links reports to retained source identities', () => {
  const ids=seed();
  const pending=store.createSession();store.submit(pending.id,'A pending analysis.');store.end(pending.id);
  const failed=store.createSession();store.submit(failed.id,'A failed analysis.');store.end(failed.id);
  const attempt=store.createRequest(failed.id,'grammar',grammarSnapshot());store.dispatch(attempt.id);store.failRequest(attempt.id,'request_timeout',null,{},false);
  const preview=store.patternPreview();expect(preview.scope.count).toBe(5);expect(preview.scope.excluded.unavailable).toBe(2);
  expect(preview.unavailableSessions.map(s=>s.id).sort()).toEqual([pending.id,failed.id].sort());
  expect(preview.unavailableSessions.find(s=>s.id===failed.id)?.state).toBe('failed');
  const report=store.patternCreate(preview.fingerprint,randomUUID());store.patternDispatch(report.attemptId!);store.patternSave(report.attemptId!,html,{});
  expect(store.patternRelated(ids[0])).toMatchObject({total:1,reports:[{id:report.id,status:'succeeded'}]});
  expect(store.patternRelated(pending.id).total).toBe(0);
  store.deleteSession(ids[0]);expect(store.patternRelated(ids[0]).reports[0].id).toBe(report.id);
  store.patternDelete(report.id);expect(store.patternRelated(ids[0]).total).toBe(0);
});

it('selects ended evidence independently of history pages, partner, entry mode and analysis timing', () => {
  const ids=seed(45,false,true), db=new Database(join(directory,'stomylos.sqlite3'));
  const now=Date.now();
  ids.forEach((id,i)=>db.prepare('UPDATE sessions SET ended_at=?,created_at=? WHERE id=?').run(
    new Date(now-(45-i)*3600000).toISOString(),new Date(now-i*86400000).toISOString(),id));
  db.close();
  expect(store.sessionPage(0).sessions).toHaveLength(40);
  const p=store.patternPreview();expect(p.scope.eligible).toBe(45);expect(p.scope.excluded.overCount).toBe(25);
  const report=store.patternCreate(p.fingerprint,randomUUID());
  expect(store.patternDetail(report.id).sources.map(s=>s.session_id)).toEqual(ids.slice(-20).reverse());
  expect(store.patternDetail(report.id).sources).toHaveLength(20);
});

it('paginates saved reports without loss or duplication and keeps selected analysis attempts unique', () => {
  for(let i=0;i<5;i++){
    const s=store.createSession();store.submit(s.id,'One complete learner message.');store.end(s.id);
    const first=store.createRequest(s.id,'grammar',grammarSnapshot());store.dispatch(first.id);store.failRequest(first.id,'request_timeout',null,{},false);
    const next=store.createRequest(s.id,'grammar',grammarSnapshot());store.dispatch(next.id);
    store.saveAnalysis(next.id,JSON.stringify({units:[{index: 0,corrected_text:'One complete learner message.',explanation:''}]}),{});
  }
  const expected=[];
  for(let i=0;i<21;i++){
    if(i)seed(1);
    const r=store.patternCreate(store.patternPreview().fingerprint,randomUUID());
    store.patternDispatch(r.attemptId!);store.patternSave(r.attemptId!,html,{});expected.push(r.id);
    if(i===0){const d=store.patternDetail(r.id);expect(d.scope.records).toBe(5);expect(new Set(d.sources.map(s=>s.analysis_id)).size).toBe(5);}
  }
  const one=store.patternList(0),two=store.patternList(20);
  expect(one.reports).toHaveLength(20);expect(one.hasMore).toBe(true);expect(two.reports).toHaveLength(1);expect(two.hasMore).toBe(false);
  expect([...one.reports,...two.reports].map(r=>r.id).sort()).toEqual(expected.sort());
});
