import type { SessionSummary } from '../shared/types';

export function historySubtitle(session: Pick<SessionSummary, 'state' | 'analysis_state' | 'lastUserInput'>): string {
  if (session.state === 'draft') return 'New chat';
  if (session.state === 'active') return 'In progress';
  switch (session.analysis_state) {
    case 'pending': return 'Analysis pending';
    case 'running': return 'Analyzing';
    case 'failed': return 'Analysis failed';
    default: return session.lastUserInput?.replace(/\s+/gu, ' ').trim() || 'No messages';
  }
}
