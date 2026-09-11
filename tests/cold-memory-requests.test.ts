import { conversationComponents } from '../src/main/contracts';
import { afterEach, expect, it } from 'vitest';
import { coldFixture } from './cold-memory-fixtures';
import { ColdMemoryStore, coldHash } from '../src/main/cold-memory-store';
import { MemoryClusters } from '../src/main/memory-clusters';
import { MemoryRecallStore } from '../src/main/memory-recall-store';
import { prepareProviderRequest } from '../src/main/provider-policy';
import { coldContextVersion } from '../src/main/memory-recall';
const fixtures:ReturnType<typeof coldFixture>[]=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
function fixture(){
  const f=coldFixture();fixtures.push(f);const raw=new ColdMemoryStore(f.db),groups=new MemoryClusters(f.db),recall=new MemoryRecallStore(f.db);
  const space=groups.register('{"request fixture":1}',3),gen=groups.begin(space);
  f.db.transaction(()=>{f.db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin) VALUES('old',1,0,'legacy')").run();raw.archive([{id:'old',text:'COLD_SENTINEL: Enjoyed mountain hiking.'}]);f.db.prepare("DELETE FROM memory_item_metadata WHERE id='old'").run();})();
  const job=groups.claim(space)!;groups.complete(job,{vector:[1,0,0],inputHash:coldHash(job.text),chunkCount:1});groups.reconcile();groups.activate(gen);recall.cacheMetadata();
  const session=f.store.createSession();f.store.searchMode(session.id,'off');f.store.selectManual(session.id,'model_04');f.store.submit(session.id,'I enjoy my weekend.');f.store.commitRoute(session.id,null,'fixture',null);
  return {...f,session,raw,groups};
}
it('freezes COLD in the actual provider request, preserves exact retries and blocks revoked evidence without rewriting history',()=>{
  const f=fixture(),store=f.store,request=store.prepareChat(f.session.id,'first');
  const first=store.startChat(request.id),snapshot=JSON.parse(first.request.config);
  expect(snapshot.memory_version).toBe(coldContextVersion);expect(snapshot.cold_recollections.items[0].id).toBe('old');
  const wire=prepareProviderRequest(first.body);expect(JSON.stringify(wire.body)).toContain('COLD_SENTINEL');expect(wire.body.provider.data_collection).toBe('deny');
  store.failRequest(first.request.id,'request_timeout');const retry=store.prepareChat(f.session.id,'retry','retry');expect(retry.config).toBe(first.request.config);
  f.groups.deleteOriginal('old',coldHash('COLD_SENTINEL: Enjoyed mountain hiking.'),f.raw.revision());
  expect(()=>store.startChat(retry.id)).toThrow('memory_retry_revoked');expect(store.request(request.id).config).toBe(request.config);
});
it('replaces a revoked queued request before first handoff, keeps original evidence and sends no revoked note',()=>{
  const f=fixture(),request=f.store.prepareChat(f.session.id,'queued');
  f.groups.deleteOriginal('old',coldHash('COLD_SENTINEL: Enjoyed mountain hiking.'),f.raw.revision());
  const sent=f.store.startChat(request.id);expect(sent.request.id).not.toBe(request.id);expect(JSON.stringify(sent.body)).not.toContain('COLD_SENTINEL');expect(f.store.request(request.id).config).toBe(request.config);
});
it('applies Memory Off at handoff to both HOT and COLD and keeps a transmitted no-memory session excluded after On',()=>{
  const f=fixture(),store=f.store,request=store.prepareChat(f.session.id,'queued');store.setMemoryPreference(false,0);
  const first=store.startChat(request.id);expect(JSON.stringify(first.body)).not.toContain('COLD_SENTINEL');expect(JSON.parse(first.request.config)).not.toHaveProperty('cold_recollections');
  store.finishReply(first.request.id,first.bubble.id,'Tell me more.',{});store.setMemoryPreference(true,1);store.submit(f.session.id,'Another weekend.');
  const next=store.startChat(store.prepareChat(f.session.id,'next').id);expect(JSON.stringify(next.body)).not.toContain('COLD_SENTINEL');
});

it('keeps already-bound legacy flat-memory sessions HOT-only even when valid COLD is available',()=>{
  const f=fixture(),config=JSON.parse(f.store.session(f.session.id).chat_config);config.memory_version='stomylos_memory_context_v5';config.component_hashes=conversationComponents(config.version,config.memory_version);
  f.db.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(config),f.session.id);
  f.db.prepare('INSERT INTO session_memory_policy VALUES(?,1,0)').run(f.session.id);
  const request=f.store.prepareChat(f.session.id,'legacy'),sent=f.store.startChat(request.id);
  expect(JSON.parse(request.config).memory_version).toBe('stomylos_memory_context_v5');expect(JSON.parse(request.config)).not.toHaveProperty('cold_recollections');expect(JSON.stringify(sent.body)).not.toContain('COLD_SENTINEL');
});
