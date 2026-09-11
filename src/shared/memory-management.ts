import type { FlatMemoryDocument, MemoryItem } from './memory';
export interface MemoryManagement {
  document: FlatMemoryDocument;
  hash: string;
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
