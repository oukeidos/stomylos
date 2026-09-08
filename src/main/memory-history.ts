import { memoryCategories, type MemoryAttempt, type MemoryChange, type MemoryChanges, type MemoryChangeValue, type MemoryDocument, type MemoryJob, type MemoryPacket } from '../shared/memory';
import { memoryHash, memoryJson, sharedMemoryId, candidateLimits, validateMemory } from './memory-updater';

// Compare committed documents, never the chat's opening snapshot or today's memory.
function difference(before: MemoryDocument, after: MemoryDocument): MemoryChange[] {
  const index = (doc: MemoryDocument) => new Map<string, MemoryChangeValue>(memoryCategories.flatMap(category =>
    doc[category].map(({ id, text }) => [id, { category, text }] as const)));
  const oldItems = index(before), newItems = index(after), changes: MemoryChange[] = [];
  for (const [id, value] of newItems) {
    const old = oldItems.get(id);
    if (!old) changes.push({ id, kind: 'added', before: null, after: value });
    else if (old.category !== value.category || old.text !== value.text) changes.push({ id, kind: 'updated', before: old, after: value });
  }
  for (const [id, value] of oldItems) if (!newItems.has(id)) changes.push({ id, kind: 'deleted', before: value, after: null });
  return changes;
}

export function memoryChanges(job: MemoryJob, attempt: MemoryAttempt | undefined): MemoryChanges | null {
  if (job.state !== 'completed') return null;
  // An unreadable historical result must not prevent opening the conversation.
  try {
    if (!attempt || attempt.id !== job.selected_attempt_id || attempt.job_id !== job.ordinal || attempt.status !== 'succeeded' ||
      !attempt.result || !attempt.finished_at || !Number.isFinite(Date.parse(attempt.finished_at)) ||
      memoryHash(attempt.input_json) !== attempt.input_hash || memoryHash(job.source) !== job.source_hash) throw new Error('history_unavailable');
    const packet: MemoryPacket = JSON.parse(attempt.input_json), after: MemoryDocument = JSON.parse(attempt.result);
    const before = packet.current_memory;
    validateMemory(before, candidateLimits); validateMemory(after, candidateLimits);
    if (packet.session.id !== job.session_id || packet.session.character_id !== job.character_id || memoryJson(packet.session) !== job.source ||
      ![sharedMemoryId, job.character_id].includes(before.character_id) || after.character_id !== before.character_id ||
      after.revision < before.revision || after.revision > before.revision + 1) throw new Error('history_unavailable');
    return { status: 'ready', scope: before.character_id === sharedMemoryId ? 'shared' : 'character',
      appliedAt: attempt.finished_at, beforeRevision: before.revision, afterRevision: after.revision, items: difference(before, after) };
  } catch { return { status: 'unavailable' }; }
}
