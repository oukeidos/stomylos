import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RequestRecord } from '../src/shared/types';
import { usedMemory } from '../src/renderer/used-memory';
import { UsedMemory } from '../src/renderer/used-memory-details';

const record = (id: string, text: string) => ({ id, text });
function request(config: object, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return { id: 'r', session_id: 's', role: 'chat', parent_id: null, status: 'succeeded', created_at: '2026-09-12',
    dispatched_at: '2026-09-12', finished_at: '2026-09-12', source_sequence: 1, source_hash: '',
    config: JSON.stringify(config), config_hash: '', response_content: 'Reply', metadata: '{}', failure: null, ...overrides };
}
const config = {
  memory_context: { character_id: 'shared', revision: 1, database_records: [record('hot', 'Recent note')] },
  cold_recollections: { items: [record('cold', 'Older note')] },
  associative_recall: { items: [record('recall', 'Relevant earlier note')] }
};
it('groups dispatched memory by type, deduplicates retries, and excludes prepared requests', () => {
  const requests = [request(config), request(config, { id: 'retry', status: 'failed' }),
    request({ memory_context: { ...config.memory_context, database_records: [record('never', 'NEVER_SENT')] } }, { dispatched_at: null }),
    request(config, { role: 'router' })];
  const memory = usedMemory(requests);
  expect(memory.hot.map(item => item.text)).toEqual(['Recent note']);
  expect(memory.cold.map(item => item.text)).toEqual(['Older note']);
  expect(memory.associative.map(item => item.text)).toEqual(['Relevant earlier note']);
  const html = renderToStaticMarkup(createElement(UsedMemory, { requests }));
  for (const title of ['Recent memory (HOT)', 'Older recollections (COLD)', 'Associative recall']) expect(html).toContain(title);
  for (const text of ['Recent note', 'Older note', 'Relevant earlier note']) expect(html).toContain(text);
  expect(html).not.toContain('NEVER_SENT');
});
it('preserves historical categorized notes and actual changed/deleted text across requests', () => {
  const legacy = { character_id: 'shared', revision: 0, traits: [record('same', 'Original text')], relationships: [], experiences: [], intentions: [] };
  const memory = usedMemory([request({ memory_context: legacy }), request({ memory_context: { ...config.memory_context, database_records: [record('same', 'Edited text')] } })]);
  expect(memory.hot.map(item => item.text)).toEqual(['Original text', 'Edited text']);
});
it('distinguishes unsent preparation from dispatched memory-free requests', () => {
  expect(usedMemory([request(config, { dispatched_at: null })])).toMatchObject({ dispatched: false, used: false, hot: [], cold: [], associative: [] });
  expect(usedMemory([request({ memory_control: 'stomylos_memory_control_v1' })])).toMatchObject({ dispatched: true, used: false, hot: [] });
  expect(renderToStaticMarkup(createElement(UsedMemory, { requests: [] }))).toContain('No reply request has been dispatched yet.');
});
