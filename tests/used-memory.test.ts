import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message, RequestRecord } from '../src/shared/types';
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
it('shows only records actually admitted by the dated wire budget', () => {
  const dates = { hot: { items: [] }, cold: { items: config.cold_recollections.items }, associative: { items: [] } };
  const memory = usedMemory([request({ ...config, conversation_dates: dates })]);
  expect(memory.hot).toEqual([]);
  expect(memory.cold.map(item => item.text)).toEqual(['Older note']);
  expect(memory.associative[0].items).toEqual([]);
});
it('groups dispatched memory by type, deduplicates retries, and excludes prepared requests', () => {
  const requests = [request(config), request(config, { id: 'retry', status: 'failed' }),
    request({ memory_context: { ...config.memory_context, database_records: [record('never', 'NEVER_SENT')] } }, { dispatched_at: null }),
    request(config, { role: 'router' })];
  const memory = usedMemory(requests);
  expect(memory.hot.map(item => item.text)).toEqual(['Recent note']);
  expect(memory.cold.map(item => item.text)).toEqual(['Older note']);
  expect(memory.associative.flatMap(turn => turn.items.map(item => item.text))).toEqual(['Relevant earlier note']);
  const html = renderToStaticMarkup(createElement(UsedMemory, { requests, messages: [] }));
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
  expect(renderToStaticMarkup(createElement(UsedMemory, { requests: [], messages: [] }))).toContain('No reply request has been dispatched yet.');
});

it.each([0, 1])('groups recall by actual learner turns with first sequence %s, merges retries only within a turn and keeps empty turns', first => {
  const message = (sequence: number): Message => ({ id: `m${sequence}`, session_id: 's', sequence, role: 'user', origin: 'learner', content: 'Hello', delivery: 'complete', request_id: null });
  const messages = [message(first), message(first + 2), message(first + 4)];
  const requests = [
    request(config, { id: 'later', source_sequence: first + 4 }),
    request(config, { id: 'initial', source_sequence: first }),
    request(config, { id: 'retry', source_sequence: first, parent_id: 'initial', status: 'failed' }),
    request({ associative_recall: { items: [record('recall', 'Changed saved note')] } }, { id: 'changed', source_sequence: first, status: 'interrupted' }),
    request({}, { id: 'empty', source_sequence: first + 2 }),
    request({ associative_recall: { items: [record('unsent', 'NEVER_SENT')] } }, { id: 'unsent', source_sequence: first + 2, dispatched_at: null })
  ];
  const before = JSON.stringify(requests);
  const turns = usedMemory(requests).associative;
  expect(turns.map(turn => turn.sourceSequence)).toEqual([first, first + 2, first + 4]);
  expect(turns.map(turn => turn.items.map(item => item.text))).toEqual([['Relevant earlier note', 'Changed saved note'], [], ['Relevant earlier note']]);
  const html = renderToStaticMarkup(createElement(UsedMemory, {requests, messages}));
  expect(html).toContain('Associative recall · Turn 1'); expect(html).toContain('Associative recall · Turn 2'); expect(html).toContain('Associative recall · Turn 3');
  expect(html.match(/Relevant earlier note/g)).toHaveLength(2);
  expect(html).not.toContain('NEVER_SENT'); expect(JSON.stringify(requests)).toBe(before);
});
