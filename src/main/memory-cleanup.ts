import flatPrompt from './memory-cleanup-prompt-flat.txt?raw';
import { validateFlatMemory } from './memory-flat';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import prompt from './memory-cleanup-prompt.txt?raw';
import { AppFailure } from './errors';
import { memoryCategories, isFlatMemory, type StoredMemoryDocument, type FlatMemoryDocument, type MemoryDocument } from '../shared/memory';
import { cleanupInput, memoryCharacterCap, memoryCharacters, normalizeMemoryText } from './memory-render';
import { memoryHash, candidateLimits } from './memory-updater';
import type { Json } from '../shared/types';
export const legacyCleanupVersion = 'stomylos_memory_cleanup_v1';
export const flatCleanupVersion = 'stomylos_memory_cleanup_v2';
export function cleanupConfig(version = legacyCleanupVersion): Json {
  if (![legacyCleanupVersion, flatCleanupVersion].includes(version)) throw new AppFailure('memory_cleanup_settings');
  const selected = version === flatCleanupVersion ? flatPrompt : prompt;
  return { version, prompt: selected.trim(), prompt_sha256: memoryHash(selected.trim()), timeout_seconds: 180,
    response_identity: { allowed_models: ['qwen/qwen3.8-2.4t-a95b', 'qwen/qwen3.8-2.4t-a95b-20260812'], provider: null },
    parameters: { model: 'qwen/qwen3.8-2.4t-a95b', provider: { allow_fallbacks: true, require_parameters: true },
      reasoning: { effort: 'low' }, max_tokens: 16384, stream: false } };
}
export function cleanupBody(config: Json, doc: StoredMemoryDocument): Json {
  if (!isDeepStrictEqual(config, cleanupConfig(config.version))) throw new AppFailure('memory_cleanup_settings');
  if (isFlatMemory(doc) !== (config.version === flatCleanupVersion)) throw new AppFailure('memory_cleanup_settings');
  if (isFlatMemory(doc)) validateFlatMemory(doc, candidateLimits);
  const messages = [{ role: 'system', content: config.prompt }, { role: 'user', content: cleanupInput(doc) }];
  // Conservative UTF-8 upper bound, well below the selected model's 1M context.
  if (Buffer.byteLength(JSON.stringify(messages)) + 16384 + 512 > 1_000_000) throw new AppFailure('memory_cleanup_input_too_large');
  return { ...config.parameters, messages };
}
export function parseCleanup(content: string, before: MemoryDocument, newId: () => string = randomUUID): MemoryDocument {
  const result: MemoryDocument = { character_id: before.character_id, revision: before.revision, traits: [], relationships: [], experiences: [], intentions: [] };
  const headings = memoryCategories.map(c => c[0].toUpperCase() + c.slice(1));
  let section = -1, count = 0;
  for (const line of normalizeMemoryText(content).split('\n').map(l => l.trim()).filter(Boolean)) {
    const heading = headings.indexOf(line);
    if (heading >= 0) {
      if (heading !== section + 1) throw new AppFailure('memory_cleanup_format');
      section = heading; continue;
    }
    if (section < 0 || /^(?:```|#|[-*•]\s|\d+[.)]\s)/u.test(line)) throw new AppFailure('memory_cleanup_format');
    result[memoryCategories[section]].push({ id: 'mem_' + newId(), text: line }); count++;
  }
  if (section !== 3 || count === 0) throw new AppFailure('memory_cleanup_format');
  if (memoryCharacters(result) > memoryCharacterCap) throw new AppFailure('memory_cleanup_over_cap');
  return result;
}

/** A frozen cleanup config, not the current default, selects response interpretation. */
export function parseCleanupResponse(config: Json, content: string, before: StoredMemoryDocument, newId: () => string = randomUUID): StoredMemoryDocument {
  cleanupBody(config, before);
  if (!isFlatMemory(before)) return parseCleanup(content, before, newId);
  const lines = normalizeMemoryText(content).split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.some(line => /^(?:```|#|[-*•]\s|\d+[.)]\s)/u.test(line) || /^(?:Traits|Relationships|Experiences|Intentions):?$/u.test(line))) throw new AppFailure('memory_cleanup_format');
  const result: FlatMemoryDocument = { character_id: before.character_id, revision: before.revision,
    database_records: lines.map(text => ({ id: 'mem_' + newId(), text })) };
  validateFlatMemory(result, candidateLimits);
  if (memoryCharacters(result) > memoryCharacterCap) throw new AppFailure('memory_cleanup_over_cap');
  return result;
}
