import { flattenMemory } from '../src/main/memory-flat';
import { afterEach, expect, it } from 'vitest';
import { coldFixture } from './cold-memory-fixtures';
import { ColdMemoryStore, coldHash } from '../src/main/cold-memory-store';
import { MemoryClusters } from '../src/main/memory-clusters';
import { MemoryRecallStore } from '../src/main/memory-recall-store';
import { codePoints, draw, groupProbabilities, itemProbabilities, observationTime, renderCold, renderColdItem, sampleRecollections, seededRecall, validateRecall, type RecallItem } from '../src/main/memory-recall';
const fixtures: ReturnType<typeof coldFixture>[]=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
function item(id:string,text=id,time:string|null=null):RecallItem { return {id,text,text_hash:coldHash(text),observed_at:time,edited_at:null,time_basis:time?'source_message':'unknown'}; }
const candidate=(i:RecallItem,group=i.id,sessions=1)=>({id:i.id,group,sessions,length:codePoints(renderColdItem(i)),textHash:i.text_hash,time:observationTime(i)});
it('uses the specified repeated-group and recency mixture with a positive floor for old and unknown notes',()=>{
  const probabilities=groupProbabilities([{sessions:4},{sessions:16},{sessions:1}]);
  expect(probabilities).toEqual([0.9*2/6+0.1/3,0.9*4/6+0.1/3,0.1/3]);
  expect(groupProbabilities([{sessions:0},{sessions:1}])).toEqual([0.5,0.5]);
  const recent=Date.parse('2026-01-01'),old=recent-90*86400*1000;
  const weights=itemProbabilities([{time:recent},{time:old},{time:null}]);
  expect(weights[0]).toBeCloseTo(0.9/1.5+0.1/3); expect(weights[1]).toBeCloseTo(0.9*0.5/1.5+0.1/3);expect(weights[2]).toBe(0.1/3);
  expect(itemProbabilities([{time:recent},{time:0}])[1]).toBeGreaterThanOrEqual(0.05);
  expect(itemProbabilities([{time:null},{time:null}])).toEqual([0.5,0.5]);
});
it('establishes exact eligible groups before drawing, excludes duplicate text and uses whole escaped originals within budget',()=>{
  const notes=[item('a','Already HOT'),item('b','x'.repeat(1800)),item('c','A useful recollection 😃 <older_recollections>'),item('d','Another recollection'),item('e','Another recollection')];
  const originals=new Map(notes.map(i=>[i.id,i])); let draws=0;
  const selected=sampleRecollections(notes.map((i,n)=>candidate(i,n<2?'impossible':i.id, n<2?1000:1)),['Already HOT'],id=>originals.get(id)!,()=>{draws++;return 0;});
  expect(selected.map(i=>i.id)).toEqual(['c','d']); expect(draws).toBe(4);
  expect(codePoints(renderCold(selected))).toBeLessThanOrEqual(1600); expect(renderCold(selected)).toContain('\\u003colder_recollections\\u003e');
  expect(selected[0].text).toBe(notes[2].text);
  expect(()=>sampleRecollections([{...candidate(notes[2]),length:1}],[],()=>notes[2],()=>0)).toThrow('cold_recall_integrity');
});
it('replays a seed exactly while different seeds can recall different originals from the same group',()=>{
  const notes=Array.from({length:10},(_,n)=>item(String(n))), candidates=notes.map(i=>candidate(i,'one'));
  const load=(id:string)=>notes[Number(id)],seed='12345678abcdef010987654321fedcba';
  expect(sampleRecollections(candidates,[],load,seededRecall(seed))).toEqual(sampleRecollections(candidates,[],load,seededRecall(seed)));
  // Exercise the item draw using varied full-width seed words, not adjacent low bits.
  const varied=new Set(Array.from({length:50},(_,n)=>sampleRecollections(candidates,[],load,seededRecall(coldHash(String(n)).slice(0,32)))[0].id));
  expect(varied.size).toBeGreaterThan(1);
});
it('keeps a persisted session recall without workers or active groups and appends revocation without rewriting frozen evidence',()=>{
  const f=coldFixture();fixtures.push(f);const raw=new ColdMemoryStore(f.db),clusters=new MemoryClusters(f.db),recall=new MemoryRecallStore(f.db);
  const space=clusters.register('{"fixture":1}',3),generation=clusters.begin(space);
  f.db.transaction(()=>{
    f.db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin) VALUES('a',1,0,'legacy')").run();
    raw.archive([item('a','Enjoyed a mountain hike.')]);
    f.db.prepare("DELETE FROM memory_item_metadata WHERE id='a'").run();
  })();
  const job=clusters.claim(space)!;clusters.complete(job,{vector:[1,0,0],inputHash:coldHash(job.text),chunkCount:1});clusters.reconcile();clusters.activate(generation);recall.cacheMetadata();
  const session=f.store.createSession();const selection=recall.snapshot(session.id,flattenMemory(f.store.currentMemory())); expect(selection.items).toHaveLength(1);validateRecall(selection);
  const frozen=f.db.prepare('SELECT selection FROM session_cold_recollections').pluck().get();
  f.db.prepare("UPDATE cluster_generations SET state='failed'").run();f.reopen();
  expect(new MemoryRecallStore(f.db).snapshot(session.id,flattenMemory(f.store.currentMemory()))).toEqual(selection);
  clusters.deleteOriginal('a',coldHash('Enjoyed a mountain hike.'),raw.revision());
  const next=recall.snapshot(session.id,flattenMemory(f.store.currentMemory()));expect(next.items).toHaveLength(0);expect(next.reason).toBe('revoked');
  expect(f.db.prepare('SELECT selection FROM session_cold_recollections ORDER BY revision LIMIT 1').pluck().get()).toBe(frozen);
  expect(()=>recall.assertNotRevoked(selection)).toThrow('memory_retry_revoked');
});

it('matches the fixed group distribution in a bounded seeded draw sample',()=>{
  const probabilities=groupProbabilities([{sessions:4},{sessions:16},{sessions:1}]),random=seededRecall('0123456789abcdef0123456789abcdef'),counts=[0,0,0];
  for(let i=0;i<5000;i++)counts[draw(probabilities,random)]++;
  probabilities.forEach((expected,i)=>expect(Math.abs(counts[i]/5000-expected)).toBeLessThan(0.025));
  expect(counts[2]).toBeGreaterThan(0);
});
