import type { SessionView } from '../shared/types';

export function endProcessingState(view: SessionView | null, automaticMemory: boolean) {
  const processing = view?.endProcessing;
  const raw = processing?.stages ?? {};
  const modern = view?.memory.addJobs !== undefined;
  const rows = !view ? [] : Object.entries(modern ? { update: 'Memory' } : { update: 'Memory', cleanup: 'Cleanup' }).map(([id, label]) => {
    let state = String(raw[id] ?? 'pending');
    if (id === 'cleanup' && state === 'skipped' && !processing?.complete && !['completed', 'skipped'].includes(String(raw.update))) state = 'pending';
    // Only a live scheduler can turn a durable pending job into continuous
    // progress. Restored/paused and legacy jobs retain their recovery controls.
    if (modern && automaticMemory && state === 'pending' && !processing?.complete) state = 'running';
    return { id, label, state };
  });
  const values = Object.values(raw);
  const failed = values.some(value => value === 'failed' || value === 'interrupted');
  const retryable = !!view && !processing?.complete && !rows.some(row => row.state === 'running') &&
    !values.includes('running') && values.some(value => ['pending', 'failed', 'interrupted'].includes(String(value)));
  return { rows, failed, retryable };
}
