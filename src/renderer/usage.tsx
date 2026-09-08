import { useEffect, useId, useRef, useState } from 'react';
import { displayMoney, validBudget, type UsageSnapshot } from '../shared/usage';

export function UsageSettings({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const saving = useRef(false), generation = useRef(0), mounted = useRef(false);
  const inputId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);
  useEffect(() => {
    if (!active) return;
    let alive = true, initial = true;
    const refresh = () => {
      if (saving.current) return;
      const request = ++generation.current;
      void window.stomylos.command('usageSnapshot', undefined).then(value => {
        if (!alive || request !== generation.current) return;
        setSnapshot(value); setError('');
        if (initial) { initial = false; setAmount(value.budget ?? ''); setNotice(''); }
      }, () => {
        if (alive && request === generation.current) {
          setSnapshot(null); setError('Usage could not be loaded. Requests can still run.');
        }
      });
    };
    const off = window.stomylos.subscribe(event => { if (event.type === 'usage-changed') refresh(); });
    const timer = setInterval(refresh, 30_000); // Refresh the month even when no request is running.
    window.addEventListener('focus', refresh); refresh();
    return () => { alive = false; generation.current++; off(); clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [active, retry]);
  async function save(value: string | null) {
    if (saving.current) return;
    if (!validBudget(value)) { setError('Enter a positive USD amount with up to two decimal places (less than $1 billion), or turn the budget off.'); return; }
    saving.current = true; setBusy(true); setError(''); setNotice(''); ++generation.current;
    try {
      const result = await window.stomylos.command('usageBudget', { amount: value });
      if (mounted.current) { setSnapshot(result); setAmount(result.budget ?? ''); setNotice(value === null ? 'Monthly budget turned off.' : 'Monthly budget saved.'); }
    } catch { if (mounted.current) setError('The budget could not be saved. Please try again.'); }
    finally { saving.current = false; if (mounted.current) { setBusy(false); } }
  }
  return <div className="usage-settings">
    {!snapshot && !error && <p className="note" role="status">Loading usage…</p>}
    {snapshot && <>
      <section className="setting">
        <p className="note">{snapshot.month} · USD · {snapshot.timeZone}</p>
        <strong>This month’s cost</strong>
        <div className="usage-total">{displayMoney(snapshot.total)}</div>
        <p className="note">{displayMoney(snapshot.reported)} reported{snapshot.estimatedRequests > 0 ? ` + ${displayMoney(snapshot.estimated)} estimated` : ''}</p>
        <details className="settings-details"><summary>Cost details</summary>
          <p className="usage-exact">Reported: ${snapshot.reported} USD · Estimated: ${snapshot.estimated} USD</p>
          <p>TTS estimates use $15 per million characters of the full text sent, including speech tags. The rate was checked on September 8, 2026. Interrupted requests may be charged differently. Prices can change; no live billing reconciliation is performed.</p>
        </details>
        {snapshot.unreported > 0 && <p className="note">Cost is not yet reported for {snapshot.unreported} of {snapshot.requests} requests. This total is incomplete.</p>}
        {snapshot.requests === 0 && <p className="note">No requests recorded this month.</p>}
        {snapshot.warning && <p role="alert">Some usage could not be saved. This total may be missing requests.</p>}
        <p className="note">This computer’s app only, starting {new Intl.DateTimeFormat('en-CA', { timeZone: snapshot.timeZone, year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(snapshot.startedAt))}. Earlier usage and other devices are not included.</p>
        <p className="note">Includes billed retries and failed requests. Voice generation uses a rate-based estimate. Other missing costs are not estimated.</p>
      </section>
      <section className="setting">
        <strong>Monthly budget</strong>
        <p className="note">{snapshot.budget === null ? 'Not set.' : `${displayMoney(snapshot.budget)} per month · ${snapshot.percent}% used, based on reported and estimated cost.`}</p>
        {snapshot.level === 'near' && <p className="usage-warning" role="status">Near your monthly budget (80% or more).</p>}
        {snapshot.level === 'reached' && <p className="usage-warning" role="status">Monthly budget reached or exceeded.</p>}
        <p className="note">A reference only. Requests stay available above budget. Missing costs may put actual usage higher.</p>
        <form onSubmit={event => { event.preventDefault(); void save(amount.trim()); }}>
          <label htmlFor={inputId}>Budget in USD</label>
          <div className="usage-budget-row">
            <input id={inputId} inputMode="decimal" autoComplete="off" placeholder="e.g. 10.00" maxLength={12} value={amount} disabled={busy}
              onChange={event => { setAmount(event.target.value); setError(''); setNotice(''); }} />
            <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save budget'}</button>
            {snapshot.budget !== null && <button type="button" disabled={busy} onClick={() => void save(null)}>Turn off</button>}
          </div>
        </form>
        <p className="note">Changes apply now and carry forward each month. Unused budget does not roll over.</p>
      </section>
      <p className="note">Cost records contain no conversation text. Deleting chats or restoring a history backup keeps this computer’s cost records and budget. They are not included in exported history backups.</p>
    </>}
    {error && <div role="alert"><p>{error}</p>{!snapshot && <button onClick={() => setRetry(n => n + 1)}>Retry loading usage</button>}</div>}
    {notice && <p className="note" role="status">{notice}</p>}
  </div>;
}
