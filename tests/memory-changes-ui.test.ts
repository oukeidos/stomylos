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

import { MemoryRecords } from '../src/renderer/memory-records';
it('renders flat current records and cleanup history without category headings or badges', () => {
  const doc={character_id:'shared',revision:1,database_records:[{id:'one',text:'<script>literal</script>'}]};
  const current=renderToStaticMarkup(createElement(MemoryRecords,{document:doc}));
  expect(current).toContain('&lt;script&gt;literal&lt;/script&gt;');expect(current).not.toContain('Traits');expect(current).not.toContain('<h3>');
  const changes={...ready,items:[{id:'one',kind:'added' as const,before:null,after:{text:'Useful detail.'}}]};
  const history=render('completed',changes);expect(history).toContain('<strong>Added</strong>');expect(history).not.toContain('Traits');
  const memory:MemoryView={current:doc,snapshot:doc,changes,attempts:[],blockedBy:null,job:{state:'completed',character_id:'model_04',created_at:'2026-09-10'},cleanup:{state:'completed',before:doc,after:doc,beforeChars:30,afterChars:20,attempts:[]}};
  const cleanup=renderToStaticMarkup(createElement(MemoryChangeHistory,{memory,ended:true}));
  expect(cleanup).toContain('Before cleanup');expect(cleanup).toContain('After cleanup');expect(cleanup).not.toContain('Traits');
});

it('shows per-input additions and FIFO removals even if later work failed',()=>{
 const html=renderToStaticMarkup(createElement(MemoryChangeHistory,{ended:false,memory:{current:null,snapshot:null,changes:null,job:null,blockedBy:null,attempts:[],addJobs:[
   {ordinal:7,input_number:1,archived_ids:['b'],state:'completed',changes:JSON.stringify({added:[{id:'a',text:'New <note>'}],evicted:[{id:'b',text:'Older note'},{id:'c',text:'Historical removal'}]})},
   {ordinal:8,input_number:2,state:'interrupted',changes:null,failure:'interrupted_unknown_outcome'}]}}));
 expect(html).toContain('Input 1');expect(html).toContain('Input 2');expect(html).not.toContain('Input 7');expect(html).toContain('Moved to Older by capacity limit');expect(html).toContain('Historical removal');expect(html).toContain('New &lt;note&gt;');expect(html).toContain('Older note');expect(html).toContain('Removed by capacity limit');expect(html).toContain('Earlier additions remain');expect(html).toContain('interrupted_unknown_outcome');
});

it('does not describe a skipped ADD input as waiting', () => {
 const html=renderToStaticMarkup(createElement(MemoryChangeHistory,{ended:true,memory:{current:null,snapshot:null,changes:null,job:null,blockedBy:null,attempts:[],addJobs:[{ordinal:1,state:'skipped',changes:null,failure:null}]}}));
 expect(html).toContain('This input was skipped.');
 expect(html).not.toContain('Waiting for memory processing.');
});
