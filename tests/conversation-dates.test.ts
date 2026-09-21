import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/database';
import { recordedTime } from '../src/main/time-context';
import { memoryReportedOn } from '../src/main/conversation-date-store';
import { datedBlock, dateCaps, dateInstructions } from '../src/main/conversation-dates';
import { sourceLinkIdentity } from '../src/main/memory-source-link';
import { associativeRecallVersion, renderAssociative, type AssociativeSelection } from '../src/main/associative-recall';
import { memoryHash } from '../src/main/memory-updater';
import { conversationSystem } from '../src/main/contracts';
import { usedMemory } from '../src/renderer/used-memory';
import { coldRecallPolicy, recallPrng, recallSeed, renderCold, type RecallSelection } from '../src/main/memory-recall';

const fixtures: { dir: string; store: Store; db: Database.Database }[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); f.db.close(); rmSync(f.dir, { recursive: true, force: true }); } });
function fixture() {
  let time = recordedTime('2026-08-03T23:30:00.000Z', 'Asia/Seoul', 540);
  const dir = mkdtempSync('/tmp/stomylos-dates-');
  const f = { dir, store: new Store(dir, 'isolated', () => 0, () => time), db: new Database(join(dir, 'stomylos.sqlite3')) };
  fixtures.push(f);
  return Object.assign(f, { clock: (utc: string) => { time = recordedTime(utc, 'Asia/Seoul', 540); }, reopen: () => { f.store.close(); f.store = new Store(dir, 'isolated', () => 0, () => time); } });
}
function start(store: Store) {
  const s = store.createSession(); store.searchMode(s.id, 'off'); store.selectManual(s.id, 'model_01'); return s.id;
}
function send(store: Store, id: string, content: string) {
  store.submit(id, content); store.commitRoute(id, null, 'fixture', null);
  const r = store.startChat(store.prepareChat(id, randomUUID()).id);
  store.finishReply(r.request.id, r.bubble.id, 'Tell me more.', {}); return r.request;
}
function extraction(store: Store, output: string) {
  const job = store.memoryAddReady()!, a = store.prepareMemoryAdd(job.ordinal, randomUUID());
  store.prepareProvider('memory_add', a.id, JSON.parse(a.body), a.phase === 'link' ? sourceLinkIdentity : JSON.parse(job.config).identity);
  store.dispatchMemoryAdd(a.id); store.receiveMemoryAdd(a.id, output, {}); store.acceptMemoryAdd(a.id);
  return a;
}
function seed(f: ReturnType<typeof fixture>) {
  const id = start(f.store); send(f.store, id, 'I will visit Busan tomorrow.');
  f.clock('2026-08-06T00:00:00.000Z'); send(f.store, id, 'I still enjoy swimming.'); f.store.end(id);
  const attempt = extraction(f.store, JSON.stringify({ add: ['The user will visit Busan tomorrow.', 'The user enjoys swimming.'] }));
  expect(JSON.parse(attempt.body).messages[1].content).toBe(JSON.stringify({ conversation: [
    { role: 'user', content: 'I will visit Busan tomorrow.' }, { role: 'assistant', content: 'Tell me more.' },
    { role: 'user', content: 'I still enjoy swimming.' }, { role: 'assistant', content: 'Tell me more.' }
  ] }));
  extraction(f.store, '{"sources":[{"id":1,"ids":[1]},{"id":2,"ids":[1,3]}]}');
  return f.store.memoryManagement().document.database_records;
}

it('uses linked local report dates and ranges without changing extraction, note text or storage', () => {
  const f = fixture(), records = seed(f);
  expect(records.map(r => memoryReportedOn(f.db, r.id))).toEqual(['2026-08-04', '2026-08-04/2026-08-06']);
  const before = f.db.prepare('SELECT * FROM shared_memory').all();
  f.clock('2026-09-20T23:00:00.000Z'); const id = start(f.store);
  const request = send(f.store, id, 'Hello again.'), c = JSON.parse(request.config);
  expect(c.conversation_dates.hot.items.map((i: any) => i.text)).toEqual(records.map(r => r.text));
  expect(c.conversation_dates.started_on).toBe('2026-09-21');
  const system = f.store.chatBody(request.id).messages[0].content;
  expect(system).toContain(dateInstructions); expect(system).toContain('"reported_on":"2026-08-04"');
  expect(system).toMatch(/Conversation start date: 2026-09-21$/);
  expect(system).not.toContain('T23:00'); expect(system).not.toContain('reported_at_utc');
  expect(f.db.prepare('SELECT * FROM shared_memory').all()).toEqual(before);
  expect(usedMemory([request]).hot.map(r => r.text)).toEqual(records.map(r => r.text));
});

it('keeps a stable prefix across midnight, source metadata edits, restart and exact retry', () => {
  const f = fixture(), records = seed(f), id = start(f.store);
  const first = send(f.store, id, 'Hello.'), body = f.store.chatBody(first.id);
  f.db.prepare("UPDATE memory_item_metadata SET origin='manual',edited_at='2026-09-21' WHERE id=?").run(records[0].id);
  f.clock('2026-08-07T00:00:00.000Z'); f.reopen(); f.store.submit(id, 'Another day.');
  const next = f.store.prepareChat(id, randomUUID()), nextBody = f.store.chatBody(next.id);
  expect(nextBody.messages.slice(0, body.messages.length)).toEqual(body.messages);
  f.store.dispatch(next.id); f.store.failRequest(next.id, 'request_timeout');
  f.clock('2026-09-21T00:00:00.000Z'); f.reopen();
  const retry = f.store.prepareChat(id, randomUUID(), 'retry');
  expect(retry.config).toBe(next.config); expect(f.store.chatBody(retry.id)).toEqual(nextBody);
});

it('uses unknown for manual, missing and legacy session provenance rather than storage dates', () => {
  const f = fixture(), records = seed(f);
  f.db.prepare("UPDATE memory_item_metadata SET origin='manual',edited_at='2026-09-21' WHERE id=?").run(records[0].id);
  expect(memoryReportedOn(f.db, records[0].id)).toBe('unknown');
  expect(memoryReportedOn(f.db, 'missing')).toBe('unknown');
  f.db.prepare('DELETE FROM memory_source_checkpoints').run();
  expect(memoryReportedOn(f.db, records[1].id)).toBe('unknown');
});

it('reads archived provenance and adds dates to associative wire data without changing its selection', () => {
  const f = fixture(), records = seed(f);
  // Archive a real linked record without changing its text or source linkage.
  const r = records[0], meta = f.db.prepare('SELECT * FROM memory_item_metadata WHERE id=?').get(r.id) as any;
  f.db.prepare("INSERT INTO cold_mutations(memory_id,kind) VALUES(?,'archive')").run(r.id);
  f.db.prepare(`INSERT INTO cold_memories(id,text,text_hash,source_order,item_index,source_message_id,source_session_id,observed_at,edited_at,archived_at,origin,time_basis,archive_revision)
    VALUES(?,?,?,?,?,?,?,?,NULL,'2026-09-21','add','source_message',1)`).run(r.id,r.text,memoryHash(r.text),meta.source_order,meta.item_index,meta.source_message_id,meta.source_session_id,meta.observed_at);
  const document = { ...f.store.memoryManagement().document, database_records: [records[1]] };
  f.db.prepare('DELETE FROM memory_item_metadata WHERE id=?').run(r.id);
  const json = JSON.stringify(document); f.db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(json,memoryHash(json));
  expect(memoryReportedOn(f.db, r.id)).toBe('2026-08-04');
  const id = start(f.store), config = JSON.parse(f.store.session(id).chat_config);
  config.associative_context_version = associativeRecallVersion; delete config.associative_policy;
  f.db.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(config),id);
  f.store.submit(id,'How about travel?');f.store.commitRoute(id,null,'fixture',null);
  const coldItems = [{id:r.id,text:r.text,text_hash:memoryHash(r.text),observed_at:meta.observed_at,edited_at:null,time_basis:'source_message' as const}];
  const cold: RecallSelection = {policy:coldRecallPolicy,prng:recallPrng,seed:recallSeed(),generation:null,space:null,revision:1,items:coldItems,block:renderCold(coldItems),reason:'selected'};
  const encodedCold = JSON.stringify(cold);
  f.db.prepare('INSERT INTO session_cold_recollections VALUES(?,?,?,?,?)').run(id,1,encodedCold,memoryHash(encodedCold),'2026-09-21');
  const items = [{id:r.id,text:r.text,text_hash:memoryHash(r.text),source_order:meta.source_order}];
  const selection: AssociativeSelection = {version:associativeRecallVersion,query_ids:[],source_revision:0,threshold:0.78,items,block:renderAssociative(items),reason:'selected' as const};
  const request = f.store.prepareChat(id,randomUUID(),'send',selection), saved = JSON.parse(request.config);
  expect(saved.associative_recall).toEqual(selection);
  expect(saved.cold_recollections).toEqual(cold);
  expect(saved.conversation_dates.cold.items[0].reported_on).toBe('2026-08-04');
  expect(f.store.chatBody(request.id).messages[0].content).not.toContain('reported_at_utc');
  expect(f.store.chatBody(request.id).messages.at(-1).content).toContain('"reported_on":"2026-08-04"');
  const withoutRecall = structuredClone(saved); delete withoutRecall.associative_recall;
  withoutRecall.conversation_dates.associative = {items:[],block:''};
  expect(conversationSystem(withoutRecall,f.store.messages(id))).toBe(conversationSystem(saved,f.store.messages(id)));
});

it.each([false,true])('honors a changed Memory preference before first dispatch (initially %s)', initial => {
  const f = fixture(), records = seed(f);
  f.store.setMemoryPreference(initial, f.store.memoryPreference().revision);
  const id = start(f.store); f.store.submit(id,'Hello.'); f.store.commitRoute(id,null,'fixture',null);
  const pending = f.store.prepareChat(id,randomUUID());
  f.store.setMemoryPreference(!initial,f.store.memoryPreference().revision);
  const dispatched = f.store.startChat(pending.id), c = JSON.parse(dispatched.request.config);
  expect(c.conversation_dates.hot.items.map((item:any)=>item.text)).toEqual(initial ? [] : records.map(r=>r.text));
  if (!initial) expect(c.conversation_dates.hot.items[0].reported_on).toBe('2026-08-04');
  expect(c.conversation_dates.started_on).toBe('2026-08-06');
});

it('preserves old session formatting and supplies only a start date when Memory is off', () => {
  const f = fixture(); f.store.setMemoryPreference(false, f.store.memoryPreference().revision);
  const id = start(f.store), request = send(f.store,id,'Hi.');
  expect(JSON.parse(request.config).conversation_dates.hot.items).toEqual([]);
  expect(f.store.chatBody(request.id).messages[0].content).toContain('Conversation start date: 2026-08-04');
  f.store.end(id); const old = start(f.store), config = JSON.parse(f.store.session(old).chat_config);
  delete config.conversation_date_version; f.db.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(config),old);
  const historical = send(f.store,old,'Old conversation.');
  expect(JSON.parse(historical.config).conversation_dates).toBeUndefined();
  expect(f.store.chatBody(historical.id).messages[0].content).not.toContain('Conversation start date:');
});

it.each(['hot','cold','associative'] as const)('counts date metadata and escaped text within the %s wire budget', kind => {
  const items = Array.from({length:8}, (_,i) => ({id:String(i),text:'<"🌲'.repeat(90)}));
  const dates = Object.fromEntries(items.map(item => [item.id,'2026-08-04/2026-08-06']));
  const rendered = datedBlock(items,dates,kind);
  expect(Array.from(rendered.block).length).toBeLessThanOrEqual(dateCaps[kind]);
  expect(rendered.items.length).toBeLessThan(items.length);
  for(const item of rendered.items) expect(item.text).toBe(items[Number(item.id)].text);
});
