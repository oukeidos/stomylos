import { memoryCategories, isFlatMemory, type StoredMemoryDocument } from '../shared/memory';
export const memoryCharacterCap = 30_000;
export const normalizeMemoryText = (text: string) => text.replace(/\r\n?/g, '\n').trim();
/** This exact body is used for conversation injection and committed capacity. */
export function renderMemoryBody(doc: StoredMemoryDocument): string {
  if (isFlatMemory(doc)) return doc.database_records.map(i => '- ' + normalizeMemoryText(i.text)).join('\n') || '- None recorded.';
  return memoryCategories.map(c => c[0].toUpperCase() + c.slice(1) + ':\n' +
    (doc[c].map(i => '- ' + normalizeMemoryText(i.text)).join('\n') || '- None recorded.')).join('\n');
}
export const memoryCharacters = (doc: StoredMemoryDocument) => Array.from(renderMemoryBody(doc)).length;
export function cleanupInput(doc: StoredMemoryDocument): string {
  if (isFlatMemory(doc)) return doc.database_records.map(i => normalizeMemoryText(i.text).replace(/\n+/g, ' ')).join('\n');
  return memoryCategories.map(c => c[0].toUpperCase() + c.slice(1) + '\n' +
    doc[c].map(i => '* ' + normalizeMemoryText(i.text).replace(/\n+/g, ' ')).join('\n')).join('\n\n');
}
