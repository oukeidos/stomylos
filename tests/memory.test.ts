import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { memoryFixture, memorySession, memoryAttempt, acceptNotes } from './current-memory-fixtures';
import cases from './fixtures/memory-cases.json';
import selected from './fixtures/memory-contract.json';
import { applyMemory, memoryBody, memoryConfig, memoryHash, memoryJson } from '../src/main/memory-updater';
import type { MemoryPacket } from '../src/shared/memory';

const addition=(source:string)=>JSON.stringify({operations:[{op:'add',id:null,category:'traits',text:'Prefers quiet museums.',source_message_ids:[source]}]});
it('preserves the selected prompt/schema/settings and all eight exported reducer examples', () => {
  const prompt = readFileSync('src/main/memory-prompt.txt', 'utf8'), schema = readFileSync('src/main/memory-schema.json', 'utf8');
  expect(memoryHash(prompt)).toBe(selected.sha256_files['prompt-v2.txt']);
  expect(memoryHash(schema)).toBe(selected.sha256_files['schema-compatible.json']);
  const config = memoryConfig();
  expect(config.prompt).toBe(prompt);
  expect(config.response_identity).toEqual({ allowed_models: selected.accepted_response_models, provider: selected.expected_response_provider });
  expect(config.parameters).toEqual({ model: selected.model, provider: selected.provider, reasoning: selected.reasoning,
    stream: selected.stream, max_tokens: selected.max_tokens, response_format: { type: 'json_schema', json_schema: { name: 'stomylos_memory_delta_v1', strict: true, schema: JSON.parse(schema) } } });
  for (const example of cases) expect(applyMemory(example.packet as MemoryPacket, example.content), example.name).toEqual(example.expected);
  const packet = cases[3].packet as MemoryPacket;
  expect(memoryBody(config, packet).messages).toEqual([{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(packet) }]);
  expect(() => memoryBody({ ...config, timeout_seconds: 10 }, packet)).toThrow('memory_unsupported_settings');
  const huge = structuredClone(packet); huge.session.messages[0].content = 'x'.repeat(60000);
  expect(() => memoryBody(config, huge)).toThrow('memory_input_too_large');
});

it('rejects malformed patches, invented sources, duplicate targets and over-budget documents without mutating the input', () => {
  const packet = structuredClone(cases[3].packet) as MemoryPacket, before = memoryJson(packet);
  const good = JSON.parse(addition(packet.session.messages[0].id));
  for (const change of [
    (p: any) => p.operations[0].source_message_ids = ['unknown'],
    (p: any) => p.operations[0].source_message_ids = [packet.session.messages[1].id],
    (p: any) => p.operations[0].id = 'invented',
    (p: any) => p.operations[0].text = 'x'.repeat(241),
    (p: any) => p.operations[0].extra = true,
    (p: any) => p.operations = Array(121).fill(p.operations[0])
  ]) { const patch = structuredClone(good); change(patch); expect(() => applyMemory(packet, JSON.stringify(patch))).toThrow(); }
  expect(() => applyMemory(packet, '{"operations":[],"operations":[]}')).toThrow();
  expect(memoryJson(packet)).toBe(before);
  const bounded = { ...packet, limits: { ...packet.limits, max_items: 0 } };
  expect(() => applyMemory(bounded, JSON.stringify(good))).toThrow('memory_budget');
  const existing = cases[0].packet as MemoryPacket;
  const op = { op: 'delete', id: 'm1', category: null, text: null, source_message_ids: [existing.session.messages[0].id] };
  expect(() => applyMemory(existing, JSON.stringify({ operations: [op, op] }))).toThrow('memory_target');
  expect(() => applyMemory(existing, JSON.stringify({ operations: [{ ...op, category: 'relationships' }] }))).toThrow('memory_delete_fields');
  expect(() => applyMemory({ ...packet, session: { ...packet.session, character_id: 'model_03' } }, '{"operations":[]}')).toThrow('memory_character_mismatch');
});

it('shares committed notes across partners while preserving each conversation snapshot and source history',()=>{
 const f=memoryFixture();try{
  const first=memorySession(f.store),before=f.store.view(first.id).memory.snapshot;f.store.end(first.id);const saved=acceptNotes(f.store,['Prefers quiet museums.']);
  const second=memorySession(f.store,'Tell me about astronomy.','model_01');expect(f.store.view(second.id).memory.snapshot).toEqual(saved);
  f.store.end(second.id);acceptNotes(f.store,['Enjoys astronomy.']);f.reopen();
  expect(f.store.view(first.id).memory.snapshot).toEqual(before);expect(f.store.view(second.id).memory.snapshot).toEqual(saved);
  expect(f.store.currentMemory()).toMatchObject({database_records:[{text:'Prefers quiet museums.'},{text:'Enjoys astronomy.'}]});
  const jobs=f.store.view(first.id).memory.addJobs!;expect(JSON.parse(jobs[0].changes!).added[0].text).toBe('Prefers quiet museums.');
  expect(f.store.integrity().foreignKeys).toEqual([]);
 }finally{f.close();}
});
it('retains failed inference evidence and creates a new explicit retry without duplicating the learner source',()=>{
 const f=memoryFixture();try{
  const s=memorySession(f.store);f.store.end(s.id);const first=memoryAttempt(f.store);f.store.failMemoryAdd(first.id,'request_timeout');
  const job=f.store.view(s.id).memory.addJobs![0];expect(job.state).toBe('failed');expect(f.store.memoryAddReady()).toBeNull();
  f.store.retryMemoryAdd(s.id,job.ordinal);const retry=memoryAttempt(f.store);expect(retry.body).toBe(first.body);expect(retry.id).not.toBe(first.id);
  f.store.receiveMemoryAdd(retry.id,'{"add":[]}',{});f.store.acceptMemoryAdd(retry.id);expect(f.store.endBlocker()).toBeNull();
  expect(f.store.messages(s.id).filter(m=>m.origin==='learner')).toHaveLength(1);expect(f.store.view(s.id).memory.addAttempts).toHaveLength(2);
 }finally{f.close();}
});
it('rejects malformed extraction without applying notes or losing the saved response',()=>{
 const f=memoryFixture();try{
  const s=memorySession(f.store);f.store.end(s.id);const a=memoryAttempt(f.store);f.store.receiveMemoryAdd(a.id,'{"add":[42]}',{});
  expect(()=>f.store.acceptMemoryAdd(a.id)).toThrow();expect(f.store.currentMemory().revision).toBe(0);expect(f.store.messages(s.id)).toHaveLength(2);
  expect(f.db.prepare('SELECT response_content FROM memory_add_attempts WHERE id=?').pluck().get(a.id)).toBe('{"add":[42]}');
 }finally{f.close();}
});
