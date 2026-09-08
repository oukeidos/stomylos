import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MemoryChangeHistory } from '../src/renderer/memory-changes';
import type { MemoryChanges, MemoryJob, MemoryView } from '../src/shared/memory';

function render(state: MemoryJob['state'] | null, changes: MemoryChanges | null = null, ended = true, blockedBy: string | null = null) {
  const memory: MemoryView = { changes, current: null, snapshot: null, attempts: [], blockedBy,
    job: state ? { state, character_id: 'model_04', created_at: '2026-09-08T00:00:00Z' } : null };
  return renderToStaticMarkup(createElement(MemoryChangeHistory, { memory, ended }));
}
const ready = { status: 'ready', scope: 'shared', appliedAt: '2026-09-08T00:00:00Z', beforeRevision: 1, afterRevision: 2, items: [] } satisfies MemoryChanges;

it('renders before/after values, category moves and literal memory text with independent change counts', () => {
  const html = render('completed', { ...ready, items: [
    { id: 'a', kind: 'added', before: null, after: { category: 'traits', text: '<img src="https://example.com/private">' } },
    { id: 'b', kind: 'updated', before: { category: 'intentions', text: 'Visit a museum.' }, after: { category: 'experiences', text: 'Visited a museum.' } },
    { id: 'c', kind: 'deleted', before: { category: 'relationships', text: 'Has a colleague.' }, after: null }
  ] });
  expect(html).toContain('Added 1 · Updated 1 · Deleted 1');
  expect(html).toContain('Intentions → Experiences');
  expect(html).toContain('<dt>Before</dt><dd>Visit a museum.</dd>');
  expect(html).toContain('<dt>After</dt><dd>Visited a museum.</dd>');
  expect(html).toContain('Has a colleague.'); expect(html).toContain('&lt;img'); expect(html).not.toContain('<img');
  expect(html).toContain('dateTime="2026-09-08T00:00:00Z"');
});

it('distinguishes empty successful history, unavailable records and each unresolved state', () => {
  expect(render('completed', ready)).toContain('No memory changes from this chat.');
  expect(render('completed', { ...ready, scope: 'character' })).toContain('Historical partner-specific memory');
  expect(render('completed', { status: 'unavailable' })).toContain('missing or unreadable');
  expect(render('completed')).toContain('missing or unreadable');
  expect(render(null)).toContain('This chat had no memory update.');
  expect(render(null, null, false)).toContain('after this chat ends');
  expect(render('pending')).toContain('update is pending');
  expect(render('pending', null, true, 'earlier')).toContain('Waiting for an earlier');
  expect(render('running')).toContain('Updating memory.');
  for (const state of ['failed', 'interrupted'] as const) expect(render(state)).toContain('No changes were applied.');
  expect(render('skipped')).toContain('was skipped.');
});
