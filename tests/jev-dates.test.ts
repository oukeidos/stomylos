import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { coldFixture } from './cold-memory-fixtures';
import { ColdMemoryStore, coldHash } from '../src/main/cold-memory-store';
import { memoryJson, memoryHash } from '../src/main/memory-updater';
import { memoryCharacters } from '../src/main/memory-render';
import { coldRecallPolicy, recallPrng, recallSeed, renderCold, type RecallSelection } from '../src/main/memory-recall';
import { jevModel } from '../src/main/associative-jev';

it.each([true, false])('excludes only transmitted HOT/COLD records with date context %s and preserves retries', dated => {
  const f = coldFixture();
  try {
    const records = Array.from({ length: 14 }, (_, i) => ({ id: `hot${i}`, text: `Memory ${String(i).padStart(2, '0')} `.padEnd(200, 'x') }));
    const document = { character_id: 'shared', revision: 1, database_records: records };
    const encoded = memoryJson(document);
    f.db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(encoded, memoryHash(encoded));
    expect(memoryCharacters(document)).toBe(2841);
    const archived = [{ id: 'cold0', text: 'An older memory.'.padEnd(300, 'a') },
      { id: 'cold1', text: 'Another older memory.'.padEnd(300, 'b') },
      { id: 'duplicate', text: records[13].text }];
    for (const [i, record] of [...records, ...archived].entries()) {
      f.db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin) VALUES(?,?,0,'legacy')").run(record.id, i);
    }
    const originals = new ColdMemoryStore(f.db);
    f.db.transaction(() => originals.archive(archived))();
    for (const record of archived) f.db.prepare('DELETE FROM memory_item_metadata WHERE id=?').run(record.id);
    f.store.coldInitialize();
    const vector = Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0);
    let job;
    while ((job = f.store.associativeClaim())) f.store.associativeComplete(job, { vector, inputHash: coldHash(job.text), chunkCount: 1 });
    const session = f.store.createSession();
    if (!dated) {
      const config = JSON.parse(f.store.session(session.id).chat_config);
      delete config.conversation_date_version;
      f.db.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(config), session.id);
    }
    f.store.searchMode(session.id, 'off'); f.store.selectManual(session.id, 'model_01');
    const user = f.store.submit(session.id, 'Tell me about my memories.');
    f.store.commitRoute(session.id, null, 'fixture', null);
    const items = archived.slice(0, 2).map(record => {
      const item = originals.original(record.id)!;
      return { id: item.id, text: item.text, text_hash: item.text_hash, observed_at: item.observed_at, edited_at: item.edited_at, time_basis: item.time_basis };
    });
    const cold: RecallSelection = { policy: coldRecallPolicy, prng: recallPrng, seed: recallSeed(), generation: null, space: null,
      revision: originals.revision(), items, block: renderCold(items), reason: 'selected' };
    const encodedCold = JSON.stringify(cold);
    f.db.prepare('INSERT INTO session_cold_recollections VALUES(?,?,?,?,?)').run(session.id, cold.revision, encodedCold, memoryHash(encodedCold), '2026-09-21');
    const attempt = f.store.jevBegin(session.id, user.id, Date.now() + 10000);
    const prepared = f.store.jevPrepare(attempt.id, vector);
    const sentHot = dated ? records.slice(2) : records;
    expect(prepared.body.state.already_available_records).toEqual([...sentHot, ...items].map(r => r.text));
    expect(Object.values(prepared.body.state.candidate_records)).toEqual(dated ? records.slice(0, 2).map(r => r.text) : []);
    let response = null;
    if (dated) {
      f.store.prepareProvider('associative', attempt.id, prepared.body, null);
      f.store.jevDispatch(attempt.id);
      response = { model: jevModel, provider: 'TypeSafe', answers: Object.fromEntries(Object.keys(prepared.body.questions).map(key => [key, { type: 'noul', noul: .6 }])) };
    }
    const selection = f.store.jevFinish(attempt.id, response, null)!;
    const request = f.store.prepareChat(session.id, randomUUID(), 'send', selection);
    const config = JSON.parse(request.config), body = f.store.chatBody(request.id);
    if (dated) {
      expect(config.conversation_dates.hot.items.map((r: { id: string }) => r.id)).toEqual(sentHot.map(r => r.id));
      expect(config.conversation_dates.cold.items.map((r: { id: string }) => r.id)).toEqual(items.map(r => r.id));
      for (const r of records.slice(0, 2)) {
        expect(body.messages[0].content).not.toContain(r.text);
        expect(body.messages.at(-1).content).toContain(r.text);
      }
    } else {
      expect(config.conversation_dates).toBeUndefined();
      expect(f.db.prepare('SELECT COUNT(*) FROM session_date_contexts').pluck().get()).toBe(0);
    }
    for (const r of [...sentHot, ...items]) expect(body.messages[0].content).toContain(r.text);
    f.store.dispatch(request.id); f.store.failRequest(request.id, 'synthetic'); f.reopen();
    const retry = f.store.prepareChat(session.id, randomUUID(), 'retry');
    expect(retry.config).toBe(request.config);
    expect(f.store.chatBody(retry.id)).toEqual(body);
    expect(f.store.jevBegin(session.id, user.id, Date.now() + 10000)).toMatchObject({ id: attempt.id, reused: true, selection });
    expect(f.store.memoryManagement().document.database_records).toEqual(records);
  } finally { f.close(); }
});
