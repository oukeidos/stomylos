import type { Json } from '../shared/types';
import { memoryOutcomeUncertain, memoryRetryNotice } from '../shared/memory-recovery';

/** Shared by Settings, End and Conversation details to recover the exact selected source. */
export function MemoryInputRecovery({ jobs, disabled, onAction }: {
  jobs: Json[]; disabled: boolean;
  onAction(command: 'retryMemoryAdd' | 'skipMemoryAdd', job: Json): void;
}) {
  return <>{jobs.filter(job => ['failed', 'interrupted'].includes(job.state)).map(job =>
    <section key={job.ordinal} aria-label={job.source_kind==='session'?'Session memory':`Memory input ${job.input_number}`}>
      <p>{job.source_kind==='session'?'Session memory':`Input ${job.input_number}`}: {job.state}. {job.failure === 'memory_add_item_capacity'
        ? 'A note exceeds 3,000 characters.' : job.failure?.replaceAll('_', ' ')}</p>
      {memoryOutcomeUncertain(job.state, job.failure) && <p className="note">{memoryRetryNotice}</p>}
      <div className="dialog-actions">
        <button disabled={disabled} onClick={() => onAction('retryMemoryAdd', job)}>Retry {job.source_kind==='session'?'session memories':'input'}</button>
        <button disabled={disabled} onClick={() => onAction('skipMemoryAdd', job)}>Skip {job.source_kind==='session'?'session memories':'input'}</button>
      </div>
    </section>
  )}</>;
}

/** Summarize unfinished inputs; completed history needs no processing badge. */
export function memoryInputProgress(jobs: Json[], sessionId: string, blockedBy: string | null) {
  const pending = jobs.filter(job => ['pending', 'running', 'received'].includes(job.state)).length;
  const attention = jobs.filter(job => ['failed', 'interrupted'].includes(job.state)).length;
  return {
    summary: [pending ? `${pending} pending` : '', attention ? `${attention} needs attention` : ''].filter(Boolean).join(' · ') || undefined,
    earlierChat: pending && blockedBy && blockedBy !== sessionId ? blockedBy : null,
  };
}
