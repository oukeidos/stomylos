import type { SessionView } from '../shared/types';

export function maintenanceNotices(view: SessionView): { section: 'memory' | 'starter'; text: string }[] {
  const result: ReturnType<typeof maintenanceNotices> = [];
  const memory = view.memory;
  if (memory?.job && ['pending', 'failed', 'interrupted'].includes(memory.job.state)) {
    result.push({ section: 'memory', text: memory.blockedBy ? 'Memory waiting for an earlier chat' : memory.job.state === 'pending' ? 'Memory update pending' : 'Memory update needs attention' });
  }
  if (view.renewal && ['pending', 'failed', 'interrupted'].includes(view.renewal.state)) {
    result.push({ section: 'starter', text: view.renewal.state === 'pending' ? 'Starter renewal pending' : 'Starter renewal needs attention' });
  } else if (view.intentions?.jobs.some(job => ['failed', 'interrupted'].includes(job.state))) {
    result.push({ section: 'starter', text: 'Questions from memory need attention' });
  }
  return result;
}
