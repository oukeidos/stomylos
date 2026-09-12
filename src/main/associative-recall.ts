import { createHash } from 'node:crypto';
import { AppFailure } from './errors';

export const associativeRecallVersion = 'stomylos_associative_recall_v1';
export const associativeSimilarityFloor = 0.78;
export const associativeItemLimit = 3;
export const associativeCharacterCap = 900;
const intro = '\n\n<associative_recall>\n';
const outro = '\n</associative_recall>';
export interface AssociativeItem { id: string; text: string; text_hash: string; source_order: number; }
export interface AssociativeSelection {
  version: typeof associativeRecallVersion; query_ids: string[]; source_revision: number; threshold: number;
  items: AssociativeItem[]; block: string; reason: 'selected' | 'empty' | 'unavailable' | 'revoked' | 'integrity';
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const codePoints = (value: string) => Array.from(value).length;
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function renderAssociativeItem(item: AssociativeItem): string {
  return JSON.stringify({ source_order: item.source_order, text: item.text }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}
export function renderAssociative(items: AssociativeItem[]): string { return items.length ? intro + items.map(renderAssociativeItem).join('\n') + outro : ''; }
export function dot(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) throw new AppFailure('associative_vector');
  let value = 0;
  for (let i = 0; i < left.length; i++) {
    if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) throw new AppFailure('associative_vector');
    value += left[i] * right[i];
  }
  if (!Number.isFinite(value)) throw new AppFailure('associative_vector');
  return value;
}
export function selectAssociative(query: { id: string; vector: number[] }[], candidates: (AssociativeItem & { vector: number[] })[], sourceRevision: number): AssociativeSelection {
  const queryIds = query.map(item => item.id).sort(lexical);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0 || new Set(queryIds).size !== queryIds.length) throw new AppFailure('associative_snapshot');
  const excluded = new Set(queryIds);
  const ranked = candidates.filter(item => !excluded.has(item.id) && hash(item.text) === item.text_hash)
    .map(item => ({ item, score: Math.max(...query.map(current => dot(current.vector, item.vector))) }))
    .filter(entry => entry.score >= associativeSimilarityFloor)
    .sort((left, right) => right.score - left.score || left.item.source_order - right.item.source_order || lexical(left.item.id, right.item.id));
  const seen = new Set<string>(), items: AssociativeItem[] = [];
  for (const { item } of ranked) {
    if (seen.has(item.id)) continue;
    const next = [...items, { id: item.id, text: item.text, text_hash: item.text_hash, source_order: item.source_order }];
    if (next.length > associativeItemLimit || codePoints(renderAssociative(next)) > associativeCharacterCap) continue;
    items.push(next.at(-1)!); seen.add(item.id);
  }
  return { version: associativeRecallVersion, query_ids: queryIds, source_revision: sourceRevision, threshold: associativeSimilarityFloor,
    items, block: renderAssociative(items), reason: items.length ? 'selected' : 'empty' };
}
export function validateAssociative(selection: AssociativeSelection) {
  if (!selection || selection.version !== associativeRecallVersion || !Array.isArray(selection.query_ids) || new Set(selection.query_ids).size !== selection.query_ids.length ||
    selection.query_ids.some(id => typeof id !== 'string' || !id) || !Number.isSafeInteger(selection.source_revision) || selection.source_revision < 0 ||
    selection.threshold !== associativeSimilarityFloor || !Array.isArray(selection.items) || selection.items.length > associativeItemLimit ||
    selection.items.some(item => typeof item.id !== 'string' || typeof item.text !== 'string' || typeof item.text_hash !== 'string' || hash(item.text) !== item.text_hash || !Number.isSafeInteger(item.source_order) || item.source_order < 0) ||
    new Set(selection.items.map(item => item.id)).size !== selection.items.length || selection.block !== renderAssociative(selection.items) || codePoints(selection.block) > associativeCharacterCap ||
    !['selected','empty','unavailable','revoked','integrity'].includes(selection.reason)) throw new AppFailure('associative_snapshot');
}
