import { memoryOutcomeUncertain, memoryRetryNotice } from '../shared/memory-recovery';
import type { MemoryAddAttemptView } from '../shared/memory';

export function MemoryAddRequests({ attempts }: { attempts: MemoryAddAttemptView[] }) {
  return <>{attempts.map(attempt => {
    const metadata = JSON.parse(attempt.metadata);
    return <div className="request" key={attempt.id}>
      <strong>Memory update · Input {attempt.job_id}</strong><span className="tag neutral">{attempt.status}</span>
      <small>{new Date(attempt.created_at).toLocaleString()}</small>
      <small>Requested: {attempt.model}{attempt.reasoning ? ` · ${attempt.reasoning}` : ''}</small>
      {metadata.model && <small>Reported: {metadata.model}{metadata.provider ? ` · ${metadata.provider}` : ''}</small>}
      {metadata.elapsed_seconds != null && <small>{Number(metadata.elapsed_seconds).toFixed(1)} seconds</small>}
      {metadata.usage?.total_tokens != null && <small>{metadata.usage.total_tokens} tokens</small>}
      {metadata.usage?.completion_tokens != null && <small>{metadata.usage.completion_tokens} output tokens{metadata.usage.completion_tokens_details?.reasoning_tokens != null ? ` · ${metadata.usage.completion_tokens_details.reasoning_tokens} reasoning tokens` : ''}</small>}
      {metadata.usage?.cost != null && <small>${Number(metadata.usage.cost).toFixed(5)}</small>}
      {attempt.failure && <small>{attempt.failure.replaceAll('_', ' ')}</small>}
      {memoryOutcomeUncertain(attempt.status, attempt.failure) && <small>{memoryRetryNotice}</small>}
    </div>;
  })}</>;
}
