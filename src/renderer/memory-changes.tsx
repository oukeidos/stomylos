import { MemoryRecords } from './memory-records';
import type { MemoryCategory, MemoryView } from '../shared/memory';

const categories: Record<MemoryCategory, string> = { traits: 'Traits', relationships: 'Relationships', experiences: 'Experiences', intentions: 'Intentions' };
const kinds = { added: 'Added', updated: 'Updated', deleted: 'Deleted' };

export function MemoryChangeHistory({ memory, ended }: { memory: MemoryView; ended: boolean }) {
  if(memory.addJobs) return <div className="memory-changes">
    <p className="note">Notes are added per input. Earlier additions remain if later processing is skipped or fails.</p>
    {!memory.addJobs.length && <p className="note">No eligible memory inputs from this chat.</p>}
    {memory.addJobs.map(job=><section key={job.ordinal} aria-label={`Memory input ${job.input_number}`}><h4>Input {job.input_number} · {job.state}</h4>
      {job.changes ? (() => {
        const changes = JSON.parse(job.changes) as {added:{id:string;text:string}[];evicted:{id:string;text:string}[]};
        const archived = new Set<string>(job.archived_ids ?? []);
        const groups = [
          {label:'Added', items:changes.added},
          {label:'Moved to Older by capacity limit', items:changes.evicted.filter(item => archived.has(item.id))},
          {label:'Removed by capacity limit', items:changes.evicted.filter(item => !archived.has(item.id))},
        ];
        return groups.filter(group => group.label === 'Added' || group.items.length).map(group =>
          <div key={group.label}><strong>{group.label}</strong><ul>{group.items.map(item => <li key={item.id}>{item.text}</li>)}</ul></div>);
      })() : <p className="note">{job.state === 'skipped' ? 'This input was skipped.' : job.failure || 'Waiting for memory processing.'}</p>}
    </section>)}
  </div>;
  const changes = memory.changes, state = memory.job?.state;
  if (state !== 'completed') {
    const message = !state ? ended ? 'This chat had no memory update.' : 'Memory changes are available after this chat ends and its update completes.'
      : state === 'skipped' ? 'The memory update for this chat was skipped.'
      : state === 'running' ? 'Updating memory. Changes will appear when the update completes.'
      : state === 'failed' || state === 'interrupted' ? 'The memory update did not complete. No changes were applied.'
      : memory.blockedBy ? 'Waiting for an earlier memory update. No changes have been applied yet.'
      : 'The memory update is pending. No changes have been applied yet.';
    return <p className="note" role="status">{message}</p>;
  }
  if (!changes || changes.status === 'unavailable') return <p className="note" role="status">Memory change history is unavailable because the saved update record is missing or unreadable.</p>;
  return <div className="memory-changes">
    <p className="note">{changes.scope === 'character' ? 'Historical partner-specific memory' : 'Shared memory'} · Applied <time dateTime={changes.appliedAt}>{new Date(changes.appliedAt).toLocaleString()}</time></p>
    {memory.cleanup?.after && <section aria-label="Memory cleanup history">
      <h4>Memory cleanup</h4><p>{memory.cleanup.beforeChars.toLocaleString()} → {memory.cleanup.afterChars?.toLocaleString()} characters</p>
      {(['before','after'] as const).map(which => <details key={which}><summary>{which === 'before' ? 'Before cleanup' : 'After cleanup'}</summary>
        <MemoryRecords document={memory.cleanup![which]!} />
      </details>)}<h4>Factual update before cleanup</h4>
    </section>}
    <p className="note">{memory.cleanup?.after ? 'These factual changes produced the candidate before cleanup; cleanup may discard some of them. The after-cleanup snapshot shows what was committed.' : 'These changes reflect this chat’s completed update, even if memory changed again later.'}</p>
    <p role="status">{changes.items.length ? (['added', 'updated', 'deleted'] as const).map(kind => `${kinds[kind]} ${changes.items.filter(item => item.kind === kind).length}`).join(' · ') : 'No memory changes from this chat.'}</p>
    {changes.items.length > 0 && <ul className="memory-change-list">{changes.items.map(item => <li key={item.id}>
      <strong>{kinds[item.kind]}{item.before?.category && item.after?.category && item.before.category !== item.after.category
        ? ` · ${categories[item.before.category]} → ${categories[item.after.category]}`
        : (item.after ?? item.before)?.category ? ` · ${categories[(item.after ?? item.before)!.category!]}` : ''}</strong>
      <dl>
        {item.before && <><dt>Before</dt><dd>{item.before.text}</dd></>}
        {item.after && <><dt>After</dt><dd>{item.after.text}</dd></>}
      </dl>
    </li>)}</ul>}
  </div>;
}
