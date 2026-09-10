import { expect, it } from 'vitest';
import { applyMemoryResponse, memoryBody, memoryConfig, compactUpdaterVersion, candidateLimits, emptyMemory } from '../src/main/memory-updater';
import { recordedTime } from '../src/main/time-context';
import type { MemoryPacket } from '../src/shared/memory';
const config = memoryConfig(compactUpdaterVersion);
function packet(): MemoryPacket {
  const current_memory = emptyMemory('shared');
  current_memory.traits = [{ id: 'stored-trait', text: 'Likes hiking.' }];
  current_memory.intentions = [{ id: 'stored-plan', text: 'Plans to hike.' }];
  return { current_memory, limits: { ...candidateLimits }, session: { id: 'session-secret', character_id: 'partner', timezone: 'ignored', ended_at: 'ignored', messages: [
    { id: 'starter', role: 'assistant', origin: 'starter', delivery: 'complete', content: 'A starter', sent_time: null },
    { id: 'stored-user', role: 'user', origin: 'learner', delivery: 'complete', content: 'I canceled the hike.', sent_time: recordedTime('2026-09-09T23:30:00.123Z', 'Asia/Seoul', 540) },
    { id: 'assistant', role: 'assistant', origin: 'model', delivery: 'interrupted', content: 'Partial', sent_time: null },
    { id: 'draft', role: 'user', origin: 'learner', delivery: 'interrupted', content: 'Draft', sent_time: null },
    { id: 'unknown', role: 'user', origin: 'learner', delivery: 'complete', content: 'Unknown time', sent_time: null },
    { id: 'offset', role: 'user', origin: 'learner', delivery: 'complete', content: 'Unknown zone', sent_time: recordedTime('2026-09-09T00:00:00.456Z', null, -210) }
  ] } };
}
const wire = (p: MemoryPacket) => JSON.parse(memoryBody(config, p).messages[1].content);
const update = { op: 'update', id: 'm2', category: 'experiences', text: 'Canceled hiking.', source_message_ids: ['u1'] };
const apply = (operations: unknown[], p = packet()) => applyMemoryResponse(config, p, JSON.stringify({ operations }));
it('retains every text in readable compact JSON with exact recorded times and exception flags', () => {
  const p = packet(), before = structuredClone(p), value = wire(p);
  expect(value).toEqual({ memory: { traits: [{ id: 'm1', text: 'Likes hiking.' }], relationships: [], experiences: [], intentions: [{ id: 'm2', text: 'Plans to hike.' }] }, timezone: 'Asia/Seoul', messages: [
    {id:'a1',role:'assistant',content:'A starter',evidence:false},
    {id:'u1',role:'user',content:'I canceled the hike.',sent_at:'2026-09-10T08:30:00.123+09:00'},
    {id:'a2',role:'assistant',content:'Partial',interrupted:true},
    {id:'x1',role:'user',content:'Draft',evidence:false,interrupted:true},
    {id:'u2',role:'user',content:'Unknown time',sent_at:null},
    {id:'u3',role:'user',content:'Unknown zone',sent_at:'2026-09-08T20:30:00.456-03:30',timezone:null}
  ] });
  expect(wire(structuredClone(p))).toEqual(value); expect(p).toEqual(before);
  p.session.messages[1].sent_time = null;
  expect(wire(p).timezone).toBeNull();
  p.session.messages[5].sent_time = recordedTime('2026-09-09T00:00:00.456Z','UTC',0);
  expect(wire(p).messages[5].sent_at).toBe('2026-09-09T00:00:00.456+00:00');
});
it('resolves additions, full replacements and deletions into persistent IDs', () => {
  const result = apply([update,{op:'delete',id:'m1',category:null,text:null,source_message_ids:['u2']},{op:'add',id:null,category:'traits',text:'Likes swimming.',source_message_ids:['u3']}]);
  expect(result.experiences).toEqual([{id:'stored-plan',text:'Canceled hiking.'}]);
  expect(result.intentions).toEqual([]); expect(result.traits[0].id).toMatch(/^mem_/);
  expect(result.revision).toBe(1); expect(apply([])).toEqual(packet().current_memory);
});
it('rejects invalid aliases, duplicate JSON keys and operations without mutating canonical input', () => {
  const p = packet(), before = structuredClone(p);
  for (const source of ['a1','a2','x1','u99','stored-user']) expect(()=>apply([{...update,source_message_ids:[source]}],p)).toThrow('memory_source');
  for (const id of ['m3','stored-plan',null]) expect(()=>apply([{...update,id}],p)).toThrow('memory_target');
  for (const operations of [[update,update],[{...update,source_message_ids:['u1','u1']}],[{...update,extra:1}],[{...update,op:'add'}],[{...update,op:'delete'}],Array(4097).fill(update)]) expect(()=>apply(operations,p)).toThrow();
  expect(()=>applyMemoryResponse(config,p,'{"operations":[],"operations":[]}')).toThrow();
  expect(()=>applyMemoryResponse(config,p,'{"operations":[{"op":"update","id":"m1","id":"m2","category":"traits","text":"x","source_message_ids":["u1"]}]}')).toThrow();
  expect(p).toEqual(before);
  p.session.messages[1].id = p.session.messages[0].id; expect(()=>wire(p)).toThrow('memory_source');
});
it('preserves historical request presentation and rejects altered settings and oversized canonical input', () => {
  for (let i=1;i<=5;i++) {
    const p=packet(), c=memoryConfig(`stomylos_memory_updater_v${i}`);
    p.limits=c.limits;
    if(i<3)p.current_memory.character_id=p.session.character_id;
    if(i===1)for(const m of p.session.messages)delete m.sent_time;
    expect(memoryBody(c,p).messages[1].content).toBe(JSON.stringify(p));
    expect(c.parameters.reasoning.effort).toBe(i===5?'low':'medium');
    const old={...update,id:'stored-plan',source_message_ids:['stored-user']};
    expect(applyMemoryResponse(c,p,JSON.stringify({operations:[old]})).experiences[0].id).toBe('stored-plan');
  }
  expect(()=>memoryBody({...config,timeout_seconds:1},packet())).toThrow('memory_unsupported_settings');
  const p=packet();p.session.messages[0].content='x'.repeat(1_048_576);expect(()=>wire(p)).toThrow('memory_input_too_large');
});

it('preserves changing recorded zones and rejects corrupt recorded time and duplicate memory IDs', () => {
  const p=packet();p.session.messages[5].sent_time=recordedTime('2026-11-01T06:30:00.789Z','America/New_York',-300);
  expect(wire(p).messages[5]).toMatchObject({sent_at:'2026-11-01T01:30:00.789-05:00',timezone:'America/New_York'});
  p.session.messages[5].sent_time.local_date='2026-11-02';expect(()=>wire(p)).toThrow('invalid_time_context');
  const duplicate=packet();duplicate.current_memory.intentions[0].id='stored-trait';expect(()=>wire(duplicate)).toThrow('memory_item');
});
