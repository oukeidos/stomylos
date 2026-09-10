import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyMemoryResponse, memoryBody, memoryConfig, flatUpdaterVersion, candidateLimits, emptyMemory } from '../src/main/memory-updater';
import { flattenMemory, type FlatMemoryPacket } from '../src/main/memory-flat';
import { recordedTime } from '../src/main/time-context';
const config = memoryConfig(flatUpdaterVersion);
function packet(): FlatMemoryPacket {
  const old = emptyMemory('shared');
  old.traits = [{ id: 'first', text: 'Same text.' }];
  old.intentions = [{ id: 'second', text: 'Same text.' }];
  return { current_memory: flattenMemory(old), limits: { ...candidateLimits }, session: {
    id: 'session', character_id: 'partner', ended_at: '2026-09-10', timezone: 'Asia/Seoul', messages: [
      { id: 'stored-user', role: 'user', origin: 'learner', delivery: 'complete', content: 'I changed the second one.', sent_time: recordedTime('2026-09-08T15:10:00.000Z','Asia/Seoul',540) },
      { id: 'stored-assistant', role: 'assistant', origin: 'model', delivery: 'complete', content: 'Context only.', sent_time: null }
    ] } };
}
const update = { id: 'm2', text: 'Changed second.', source_message_ids: ['u1'] };
it('freezes the selected prompt and emits flat records with complete evidence/time context', () => {
  expect(config.prompt).toBe(readFileSync('src/main/memory-prompt-flat.txt','utf8'));
  const input = JSON.parse(memoryBody(config, packet()).messages[1].content);
  expect(input).toEqual({ database_records: [{id:'m1',text:'Same text.'},{id:'m2',text:'Same text.'}], timezone:'Asia/Seoul', messages:[
    {id:'u1',role:'user',content:'I changed the second one.',sent_at:'2026-09-09T00:10:00.000+09:00'},
    {id:'a1',role:'assistant',content:'Context only.'}
  ] });
  expect(config.parameters.reasoning.effort).toBe('low');
  expect(config.parameters.provider.only).toEqual(['google-ai-studio']);
});
it('applies split operations atomically, retaining IDs/order and deterministic additions', () => {
  const p=packet(), before=structuredClone(p);
  const raw=JSON.stringify({add:[{text:'New record.',source_message_ids:['u1']}],update:[update],delete:[]});
  const after=applyMemoryResponse(config,p,raw);
  expect(after.database_records.slice(0,2)).toEqual([{id:'first',text:'Same text.'},{id:'second',text:'Changed second.'}]);
  expect(after.database_records[2].id).toMatch(/^mem_/);
  expect(after.revision).toBe(1);
  expect(applyMemoryResponse(config,p,raw)).toEqual(after);
  expect(applyMemoryResponse(config,p,'{"add":[],"update":[],"delete":[]}')).toEqual(p.current_memory);
  expect(applyMemoryResponse(config,p,JSON.stringify({add:[],update:[],delete:[{id:'m1',source_message_ids:['u1']}]})).database_records).toEqual([{id:'second',text:'Same text.'}]);
  expect(p).toEqual(before);
});
it('rejects invalid fields/evidence/duplicate targets and duplicate JSON keys without partial changes', () => {
  const p=packet(), before=structuredClone(p), run=(patch:unknown)=>applyMemoryResponse(config,p,JSON.stringify(patch));
  for(const entry of [{...update,text:''},{...update,category:'traits'},{...update,id:'second'},{...update,source_message_ids:['a1']},{...update,source_message_ids:['u1','u1']},{...update,source_message_ids:[]}]) expect(()=>run({add:[],update:[entry],delete:[]})).toThrow();
  expect(()=>run({add:[],update:[update],delete:[{id:'m2',source_message_ids:['u1']}]})).toThrow('memory_target');
  expect(()=>run({add:[{id:null,text:'Bad.',source_message_ids:['u1']}],update:[],delete:[]})).toThrow();
  expect(()=>run({add:[],update:[],delete:[{id:'m1',text:null,source_message_ids:['u1']}]})).toThrow();
  expect(()=>applyMemoryResponse(config,p,'{"add":[],"update":[],"delete":[],"delete":[]}')).toThrow();
  expect(p).toEqual(before);
});

import { cleanupConfig, cleanupBody, parseCleanupResponse, flatCleanupVersion } from '../src/main/memory-cleanup';
import { memoryCharacters } from '../src/main/memory-render';
import { memoryContext, flatMemoryVersion } from '../src/main/memory-updater';
it('uses a category-free cleanup contract and counts exactly the injected Unicode body', () => {
  const doc=packet().current_memory, c=cleanupConfig(flatCleanupVersion);
  expect(cleanupBody(c,doc).messages[1].content).toBe('Same text.\nSame text.');
  const result=parseCleanupResponse(c,'A retained fact.\nAnother retained fact.',doc,(()=>{let i=0;return()=>String(++i);})());
  expect(result).toEqual({character_id:'shared',revision:0,database_records:[{id:'mem_1',text:'A retained fact.'},{id:'mem_2',text:'Another retained fact.'}]});
  const boundary={...doc,database_records:[{id:'x',text:'😀'.repeat(29998)}]};
  expect(memoryCharacters(boundary)).toBe(30000);
  expect(memoryContext(boundary,flatMemoryVersion)).toContain('- 😀');
  expect(()=>memoryContext({...boundary,database_records:[{id:'x',text:'😀'.repeat(29999)}]},flatMemoryVersion)).toThrow('memory_budget');
  for(const text of ['', 'Traits\nA fact.', '- A fact.', '# Heading', '1. A fact.']) expect(()=>parseCleanupResponse(c,text,doc)).toThrow('memory_cleanup_format');
  expect(()=>parseCleanupResponse(c,'x'.repeat(29999),doc)).toThrow('memory_cleanup_over_cap');
  expect(()=>cleanupBody(cleanupConfig(),doc)).toThrow('memory_cleanup_settings');
  const legacy=emptyMemory('shared');legacy.traits=[{id:'old',text:'Old fact.'}];
  expect(parseCleanupResponse(cleanupConfig(),'Traits\nOld fact.\nRelationships\nExperiences\nIntentions',legacy,()=> 'legacy')).toEqual({...legacy,traits:[{id:'mem_legacy',text:'Old fact.'}]});
});
