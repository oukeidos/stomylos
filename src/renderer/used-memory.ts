import { isFlatMemory, memoryCategories, type MemoryItem, type StoredMemoryDocument } from '../shared/memory';
import type { RequestRecord } from '../shared/types';

export function usedMemory(requests: RequestRecord[]) {
  const hot = new Map<string, MemoryItem>(), cold = new Map<string, MemoryItem>(), associative = new Map<string, MemoryItem>();
  let dispatched = false, used = false;
  const collect = (target: Map<string, MemoryItem>, items: MemoryItem[]) => {
    for (const item of items) {
      const key = JSON.stringify([item.id, item.text]);
      target.set(key, { id: key, text: item.text });
    }
  };
  for (const request of requests) {
    if (request.role !== 'chat' || !request.dispatched_at) continue;
    dispatched = true;
    const config = JSON.parse(request.config);
    const memory = config.memory_context as StoredMemoryDocument | undefined;
    if (memory) {
      used = true;
      collect(hot, isFlatMemory(memory) ? memory.database_records : memoryCategories.flatMap(category => memory[category]));
    }
    collect(cold, config.cold_recollections?.items ?? []);
    collect(associative, config.associative_recall?.items ?? []);
  }
  return { dispatched, used, hot: [...hot.values()], cold: [...cold.values()], associative: [...associative.values()] };
}
