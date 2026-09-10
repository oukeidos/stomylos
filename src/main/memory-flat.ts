import { createHash } from 'node:crypto';
import { memoryCategories, type MemoryDocument, type MemoryPacket, type MemoryItem } from '../shared/memory';
import { AppFailure } from './errors';
import { strictJson } from './strict-json';
import { memoryWire } from './memory-wire';

import { isFlatMemory, type FlatMemoryDocument, type StoredMemoryDocument, type FlatMemoryPacket } from '../shared/memory';
export { isFlatMemory, type FlatMemoryDocument, type StoredMemoryDocument, type FlatMemoryPacket } from '../shared/memory';
export function flattenMemory(doc: StoredMemoryDocument): FlatMemoryDocument {
  return { character_id: doc.character_id, revision: doc.revision,
    database_records: structuredClone(isFlatMemory(doc) ? doc.database_records : memoryCategories.flatMap(c => doc[c])) };
}
function fail(code: string): never { throw new AppFailure('memory_' + code); }
const exact = (v: any, keys: string[]) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function validateFlatMemory(doc: any, limits: MemoryPacket['limits']): asserts doc is FlatMemoryDocument {
  if (!exact(doc, ['character_id', 'revision', 'database_records']) || typeof doc.character_id !== 'string' || !doc.character_id || !Number.isSafeInteger(doc.revision) || doc.revision < 0 || !Array.isArray(doc.database_records)) fail('document');
  const ids = new Set<string>();
  for (const item of doc.database_records) {
    if (!exact(item, ['id', 'text']) || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.text !== 'string' || !item.text.trim() || Array.from(item.text).length > limits.max_item_chars) fail('item');
    ids.add(item.id);
  }
  if (ids.size > limits.max_items || Buffer.byteLength(JSON.stringify(doc)) > limits.max_bytes) fail('budget');
}
export function flatMemoryWire(packet: FlatMemoryPacket) {
  // Share only transcript projection with v6; no classified records are produced.
  const transcript = memoryWire({ ...packet, current_memory: { character_id: packet.current_memory.character_id,
    revision: packet.current_memory.revision, traits: [], relationships: [], experiences: [], intentions: [] } });
  const targets = new Map<string, string>(), identities = new Set<string>();
  const database_records = packet.current_memory.database_records.map(item => {
    const id = `m${targets.size + 1}`;
    if (identities.has(item.id)) fail('item');
    identities.add(item.id);
    targets.set(id, item.id); return { id, text: item.text };
  });
  return { input: { database_records, timezone: transcript.input.timezone, messages: transcript.input.messages }, targets, sources: transcript.sources };
}
export function applyFlatMemory(packet: FlatMemoryPacket, content: string): FlatMemoryDocument {
  validateFlatMemory(packet.current_memory, packet.limits);
  if (packet.current_memory.character_id !== 'shared') fail('character_mismatch');
  const patch = strictJson(content);
  if (!exact(patch, ['add', 'update', 'delete']) || !['add', 'update', 'delete'].every(k => Array.isArray(patch[k])) || patch.add.length + patch.update.length + patch.delete.length > 4096) fail('patch');
  const maps = flatMemoryWire(packet), touched = new Set<string>(), replacements = new Map<string, string>(), removed = new Set<string>();
  const additions: MemoryItem[] = [], existing = new Set(packet.current_memory.database_records.map(i => i.id));
  for (const kind of ['add', 'update', 'delete'] as const) {
    for (const [index, entry] of patch[kind].entries()) {
      const keys = kind === 'add' ? ['text', 'source_message_ids'] : kind === 'delete' ? ['id', 'source_message_ids'] : ['id', 'text', 'source_message_ids'];
      if (!exact(entry, keys)) fail('operation');
      if (!Array.isArray(entry.source_message_ids) || !entry.source_message_ids.length || new Set(entry.source_message_ids).size !== entry.source_message_ids.length || entry.source_message_ids.some((id: unknown) => typeof id !== 'string' || !maps.sources.has(id))) fail('source');
      if (kind !== 'delete' && (typeof entry.text !== 'string' || !entry.text.trim())) fail('replacement');
      if (kind === 'add') {
        const id = 'mem_' + createHash('sha256').update(JSON.stringify(['v7', packet.session.id, index])).digest('hex').slice(0, 20);
        if (existing.has(id)) fail('id_collision');
        existing.add(id); additions.push({ id, text: entry.text });
      } else {
        const id = maps.targets.get(entry.id);
        if (!id || touched.has(id)) fail('target');
        touched.add(id);
        if (kind === 'delete') removed.add(id); else replacements.set(id, entry.text);
      }
    }
  }
  const doc = { ...packet.current_memory, revision: packet.current_memory.revision + (touched.size + additions.length ? 1 : 0),
    database_records: [...packet.current_memory.database_records.filter(i => !removed.has(i.id)).map(i => ({ id: i.id, text: replacements.get(i.id) ?? i.text })), ...additions] };
  validateFlatMemory(doc, packet.limits); return doc;
}
