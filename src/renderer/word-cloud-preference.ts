import { useEffect, useRef, useState } from 'react';
export function useWordCloudPreference(saved: boolean | undefined) {
  const [override, setOverride] = useState<boolean>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const pending = useRef(false);
  useEffect(() => { if (saved === override) setOverride(undefined); }, [saved, override]);
  return { enabled: override ?? saved, busy, error, async change(enabled: boolean) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(false); setOverride(enabled);
    try { await window.stomylos.command('setWordCloudPreference', { enabled }); }
    catch { setOverride(undefined); setError(true); }
    finally { pending.current = false; setBusy(false); }
  } };
}
export type WordCloudPreference = ReturnType<typeof useWordCloudPreference>;
