import type { Message, RequestRecord } from '../shared/types';
import { usedMemory } from './used-memory';
import { MemoryRecords } from './memory-records';

export function UsedMemory({ requests, messages }: { requests: RequestRecord[]; messages: Message[] }) {
  const memory = usedMemory(requests);
  const learnerTurns = messages.filter(message => message.origin === 'learner').sort((a, b) => a.sequence - b.sequence);
  const groups = [
    { title: 'Recent memory (HOT)', items: memory.hot },
    { title: 'Older recollections (COLD)', items: memory.cold }
  ];
  return <>
    <p className="note">Saved context from dispatched reply requests. Recent memory and Older recollections show repeated items once. Associative recall is grouped by learner turn, with repeated retry items shown once within that turn.</p>
    {!memory.dispatched && <p className="note">No reply request has been dispatched yet.</p>}
    {groups.map(group => <section key={group.title}>
      <h3>{group.title} · {group.items.length}</h3>
      {group.items.length ? <MemoryRecords document={{ character_id: 'shared', revision: 0, database_records: group.items }} />
        : <p className="note">None used.</p>}
    </section>)}
    <section>
      <h3>Associative recall</h3>
      {!memory.associative.length && <p className="note">None used.</p>}
      {memory.associative.map(turn => {
        const index = learnerTurns.findIndex(message => message.sequence === turn.sourceSequence);
        const label = index >= 0 ? `Turn ${index + 1}` : `Reply at message ${turn.sourceSequence + 1}`;
        return <section key={turn.sourceSequence} aria-label={`Associative recall · ${label}`}>
          <h4>{label} · {turn.items.length}</h4>
          {turn.items.length ? <MemoryRecords document={{ character_id: 'shared', revision: 0, database_records: turn.items }} />
            : <p className="note">None used.</p>}
        </section>;
      })}
    </section>
  </>;
}
