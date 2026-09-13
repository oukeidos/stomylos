import type { FlatMemoryDocument, MemoryItem } from './memory';
export interface MemoryManagement {
  jobs?: import('./types').Json[];
  document: FlatMemoryDocument;
  hash: string;
  displayOrder: string[];
  blocker: { reason: 'chat' | 'processing'; sessionId: string } | null;
}
export interface MemoryEdit {
  id: string;
  revision: number;
  hash: string;
  text: string | null;
}
export function matchingMemories(records: MemoryItem[], query: string): MemoryItem[] {
  const normalize = (text: string) => text.normalize('NFC').toLowerCase();
  const terms = normalize(query).trim().split(/\s+/u).filter(Boolean);
  return records.filter(item => terms.every(term => normalize(item.text).includes(term)));
}

/** Settings-only order; never reorder the canonical document used for edits or prompts. */
export function memoryDisplayRecords(data: MemoryManagement): MemoryItem[] {
  const positions = new Map(data.displayOrder.map((id, index) => [id, index]));
  return [...data.document.database_records].sort((a, b) =>
    (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
}
