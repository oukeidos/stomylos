import { expect, it } from 'vitest';
import { emptyMemory, memoryBody, memoryConfig, capacityUpdaterVersion, candidateLimits } from '../src/main/memory-updater';
import { cleanupBody, cleanupConfig, parseCleanup } from '../src/main/memory-cleanup';
import { memoryCharacters, renderMemoryBody } from '../src/main/memory-render';

it('counts the exact normalized injected body in code points, including markers and empty sections', () => {
  const doc = emptyMemory('shared'); doc.traits.push({ id: 'a', text: '  😀\r\nsecond  ' });
  expect(renderMemoryBody(doc)).toContain('- 😀\nsecond');
  expect(memoryCharacters(doc)).toBe(Array.from(renderMemoryBody(doc)).length);
});
it('accepts long and multi-sentence lines without imposing a minimum reduction', () => {
  const before = emptyMemory('shared'); before.revision = 2;
  const text = 'Long. Still the same item. ' + 'x'.repeat(1000);
  const doc = parseCleanup(`\r\nTraits\r\n ${text} \r\nRelationships\r\nExperiences\r\nIntentions\r\n`, before, () => 'fresh');
  expect(doc.traits).toEqual([{ id: 'mem_fresh', text }]); expect(doc.revision).toBe(2);
});
it('enforces exact committed boundary after conversion', () => {
  const before = emptyMemory('shared');
  const body = (n: number) => `Traits\n${'x'.repeat(n)}\nRelationships\nExperiences\nIntentions`;
  const base = memoryCharacters(parseCleanup(body(1), before));
  expect(memoryCharacters(parseCleanup(body(30000 - base), before))).toBe(29999);
  expect(memoryCharacters(parseCleanup(body(30001 - base), before))).toBe(30000);
  expect(() => parseCleanup(body(30002 - base), before)).toThrow('memory_cleanup_over_cap');
});
it('rejects absent, duplicate, reordered, wholly empty, fenced and prefaced output', () => {
  for (const text of ['Traits\nRelationships\nExperiences\nIntentions', 'intro\nTraits\nx\nRelationships\nExperiences\nIntentions', 'Traits\nx\nTraits\nRelationships\nExperiences\nIntentions', 'Relationships\nx\nTraits\nExperiences\nIntentions', 'Traits\nx', '```\nTraits\nx\nRelationships\nExperiences\nIntentions\n```']) {
    expect(() => parseCleanup(text, emptyMemory('shared'))).toThrow('memory_cleanup_format');
  }
});
it('keeps the selected automatic-routing cleanup request and new factual-only updater contract', () => {
  const doc = emptyMemory('shared'); doc.traits.push({ id: 'a', text: 'Likes detail.' });
  const body = cleanupBody(cleanupConfig(), doc);
  expect(body.provider).toEqual({ allow_fallbacks: true, require_parameters: true });
  expect(body.messages[1].content).toContain('* Likes detail.');
  expect(body.messages[0].content).not.toContain('30,000');
  const config = memoryConfig(capacityUpdaterVersion);
  expect(config.prompt).not.toContain('The resulting memory must fit');
  expect(config.limits).toEqual(candidateLimits);
  expect(memoryBody(config, { current_memory: doc, limits: candidateLimits, session: { id: 's', character_id: 'partner', ended_at: '', timezone: 'UTC', messages: [] } }).model).toBe('google/gemini-3.8-flash');
});

it('adds low effort only for v5 while replaying the frozen v4 medium request unchanged', async () => {
  const { default: historical } = await import('./fixtures/memory-updater-v4.json');
  const { lowUpdaterVersion } = await import('../src/main/memory-updater');
  expect(memoryConfig(capacityUpdaterVersion)).toEqual(historical);
  const current = memoryConfig(lowUpdaterVersion);
  const comparison = structuredClone(current);
  comparison.version = historical.version; comparison.parameters.reasoning.effort = 'medium';
  expect(comparison).toEqual(historical);
  const packet = { current_memory: emptyMemory('shared'), limits: candidateLimits,
    session: { id: 's', character_id: 'partner', ended_at: '', timezone: 'UTC', messages: [] } };
  expect(memoryBody(current, packet).reasoning.effort).toBe('low');
  expect(memoryBody(historical, packet).reasoning.effort).toBe('medium');
  const altered = structuredClone(historical); altered.parameters.reasoning.effort = 'low';
  expect(() => memoryBody(altered, packet)).toThrow('memory_unsupported_settings');
});
