import { useEffect, useState } from 'react';
import type { RequestHistory } from '../shared/request-history';
import type { AppEvent } from '../shared/types';
export function requestHistoryChanged(event: AppEvent, sessionId: string) {
  return (event.type === 'session-changed' && event.sessionId === sessionId) ||
    (event.type === 'explain' && event.record.session_id === sessionId) ||
    event.type === 'genie' || event.type === 'speech' || event.type === 'dictation';
}
export function useRequestHistory(sessionId: string) {
  const [value, setValue] = useState<{ id: string; history?: RequestHistory; failed?: boolean }>({ id: sessionId });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true, pending = false, dirty = false;
    const refresh = async () => {
      dirty = true;
      if (pending) return;
      pending = true;
      while (active && dirty) {
        dirty = false;
        try {
          const history = await window.stomylos.command('requestHistory', {sessionId});
          if (active) setValue({ id: sessionId, history });
        } catch { if (active) setValue({ id: sessionId, failed: true }); }
      }
      pending = false;
    };
    const unsubscribe = window.stomylos.subscribe(event => { if (requestHistoryChanged(event, sessionId)) void refresh(); });
    void refresh();
    return () => { active = false; unsubscribe(); };
  }, [sessionId, revision]);
  return { ...(value.id === sessionId ? value : {}), retry: () => setRevision(v => v + 1) };
}
