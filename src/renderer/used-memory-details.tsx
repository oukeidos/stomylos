import type { RequestRecord } from '../shared/types';
import { usedMemory } from './used-memory';
import { MemoryRecords } from './memory-records';

export function UsedMemory({ requests }: { requests: RequestRecord[] }) {
  const memory = usedMemory(requests);
  const groups = [
    { title: 'Recent memory (HOT)', items: memory.hot },
    { title: 'Older recollections (COLD)', items: memory.cold },
    { title: 'Associative recall', items: memory.associative }
  ];
  return <>
    <p className="note">Saved context from dispatched reply requests, grouped by memory type. Repeated items appear once within each group.</p>
    {!memory.dispatched && <p className="note">No reply request has been dispatched yet.</p>}
    {groups.map(group => <section key={group.title}>
      <h3>{group.title} · {group.items.length}</h3>
      {group.items.length ? <MemoryRecords document={{ character_id: 'shared', revision: 0, database_records: group.items }} />
        : <p className="note">None used.</p>}
    </section>)}
  </>;
}
