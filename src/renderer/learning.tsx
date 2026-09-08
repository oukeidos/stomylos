import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { IconButton } from './icon-button';
import * as Menu from '@radix-ui/react-dropdown-menu';
import * as Dialog from '@radix-ui/react-dialog';
import type { PatternDetail, PatternPreview, PatternState, PatternCard } from '../shared/pattern-report';

const idle: PatternState = { revision: 0, reportId: null, phase: 'idle', startedAt: null, error: null };
export function usePatternState() {
  const [state, setState] = useState(idle);
  useEffect(() => {
    const apply = (s: PatternState) => setState(old => s.revision >= old.revision ? s : old);
    const off = window.stomylos.subscribe(e => { if (e.type === 'pattern') apply(e.snapshot); });
    void window.stomylos.command('patternState', undefined).then(apply).catch(() => undefined);
    return off;
  }, []);
  return state;
}
const date = (text: string | null) => text ? new Date(text).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
function message(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    pattern_scope_changed: 'Your available evidence changed. Review the updated scope before creating the report.',
    pattern_insufficient: 'At least five analyzed conversations are needed.', pattern_input_limit: 'Fewer than five complete conversations fit this report’s input allowance.',
    pattern_busy: 'A report is already being created.', pattern_source_deleted: 'A source conversation was deleted. Create a new report from the available evidence.',
    pattern_source_changed: 'The saved source evidence changed. Create a new report from the current evidence.',
    pattern_output: 'The model did not return a complete HTML report.', pattern_output_limit: 'The returned report exceeded the size limit.',
    request_timeout: 'Report generation timed out.', request_cancelled: 'Generation was cancelled.', api_key_missing: 'Add your API key in Settings to create a report.',
    save_required: 'Finish saving before continuing.', pattern_not_ready: 'This report is not ready to open.', pattern_closed: 'The application is closing.',
    interrupted_unknown_outcome: 'Generation was interrupted. Its remote outcome and cost may be unknown.', queued_not_dispatched: 'This request was saved but not sent.'
  };
  return messages[code] ?? `The report action could not finish (${code}).`;
}
export function Learning({ active, revision, state, disabled, keyPresent, back, source, requestedReport, handledReport }: {
  active: boolean; revision: number; state: PatternState; disabled: boolean; keyPresent: boolean;
  requestedReport: string | null; handledReport(): void;
  back(): void; source(id: string): Promise<void>;
}) {
  const [preview, setPreview] = useState<PatternPreview | null>(null), [cards, setCards] = useState<PatternCard[]>([]);
  const [offset, setOffset] = useState(0), [more, setMore] = useState(false), [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<PatternDetail | null>(null), [remove, setRemove] = useState<PatternCard | null>(null);
  const [busy, setBusy] = useState(false), [tick, setTick] = useState(Date.now());
  const generation = useRef(0), title = useRef<HTMLHeadingElement>(null), detailId = useRef<string | null>(null);
  detailId.current = detail?.id ?? null;
  const refresh = useCallback(async () => {
    const epoch = ++generation.current;
    const [p, rows] = await Promise.all([window.stomylos.command('patternPreview', undefined), window.stomylos.command('patternList', { offset })]);
    if (epoch !== generation.current) return;
    setPreview(p); setCards(rows.reports); setMore(rows.hasMore);
    const id = detailId.current;
    if (id) { const d = await window.stomylos.command('patternDetail', { id }); if (epoch === generation.current && detailId.current === id) setDetail(d); }
  }, [offset]);
  useEffect(() => { if (active) void refresh().catch(e => setError(message(e))); }, [active, revision, state.revision, refresh]);
  useEffect(() => { if (active) title.current?.focus(); }, [active]);
  useEffect(() => { if (state.phase === 'idle') return; const timer = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(timer); }, [state.phase]);
  const act = async (fn: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(null); try { await fn(); await refresh(); } catch (e) { setError(message(e)); void refresh().catch(() => undefined); } finally { setBusy(false); } };
  const inspect = async (id: string) => { const d = await window.stomylos.command('patternDetail', { id }); setDetail(d); };
  const openExisting = async (id: string) => {
    const saved = await window.stomylos.command('patternDetail', { id });
    if (saved.selected_attempt_id) await window.stomylos.command('patternOpen', { id });
    else setDetail(saved);
  };
  useEffect(() => {
    if (!active || !requestedReport) return; let current = true;
    void window.stomylos.command('patternDetail', { id: requestedReport }).then(d => { if (current) { setDetail(d); handledReport(); } }).catch(e => { if (current) { setError(message(e)); handledReport(); } });
    return () => { current = false; };
  }, [active, requestedReport, handledReport]);
  const elapsed = state.startedAt ? Math.max(0, Math.floor((tick - Date.parse(state.startedAt)) / 1000)) : 0;
  return <section className="learning" hidden={!active} aria-label="Reports">
    <div className="learning-page">
      <div className="learning-heading"><h1 ref={title} tabIndex={-1}>Reports</h1><Menu.Root><Menu.Trigger asChild><IconButton label="Reports options" icon="more" /></Menu.Trigger><Menu.Portal><Menu.Content className="partner-menu more-menu" sideOffset={6}><Menu.Item className="partner-option" onSelect={() => void act(() => window.stomylos.command('patternClose', undefined))}>Close report window</Menu.Item></Menu.Content></Menu.Portal></Menu.Root></div>
      {error && <p className="notice danger" role="alert">{error}</p>}
      <section className="learning-scope" aria-label="Report scope">
        <h2>Recent conversations</h2>
        {preview ? <>
          <p className="scope-number">{preview.scope.count} <span>analyzed conversations</span></p>
          {preview.scope.count > 0 && <p>{date(preview.scope.from)} – {date(preview.scope.to)}</p>}

          {preview.blocked && <p role="status">{preview.blocked === 'input_limit' ? 'Too few complete conversations fit the input allowance. The source records have not been shortened.' : `${preview.scope.count} of 5 analyzed conversations ready.`}</p>}
          <details><summary>How this scope was chosen</summary><p className="note">Up to 20 conversations from the last 90 days, across all partners. Patterns need examples in at least three separate conversations.</p><p className="note">Only completed, selected analyses contribute. Unchanged records are included too. These records do not measure an overall error rate.</p>
            <dl><dt>Recorded messages</dt><dd>{preview.scope.records}</dd><dt>Analysis unavailable in this period</dt><dd>{preview.scope.excluded.unavailable}</dd>
              <dt>Outside 90 days</dt><dd>{preview.scope.excluded.older}</dd><dt>Outside latest 20</dt><dd>{preview.scope.excluded.overCount}</dd>
              <dt>Oldest sessions excluded by input allowance</dt><dd>{preview.scope.excluded.overBudget}</dd></dl>
            {!!preview.unavailableSessions.length && <div><p className="note">Open a conversation to inspect its analysis or use the existing retry action.</p>
              {preview.unavailableSessions.map(s => <p key={s.id}><button className="quiet" onClick={() => void act(() => source(s.id))}>{date(s.ended_at)} · {s.state === 'failed' ? 'Analysis failed' : s.state === 'pending' ? 'Analysis pending' : s.state === 'running' ? 'Analyzing' : 'No analysis evidence'}</button></p>)}
              {preview.scope.excluded.unavailable > preview.unavailableSessions.length && <p className="note">Showing the 20 most recent unavailable analyses. Earlier conversations remain in History.</p>}</div>}
            <p className="note">Input uses a conservative size estimate. Whole conversations are excluded when necessary; originals and context notes are never cut.</p>
          </details>
          <div className="learning-actions"><button className="primary icon-button" aria-label={preview.existingId ? 'View existing report' : 'Create report'} title={preview.existingId ? 'View existing report' : 'Create report'} disabled={busy || disabled || !!preview.blocked || state.phase !== 'idle' || (!keyPresent && !preview.existingId)} onClick={() => void act(async () => {
            if (preview.existingId) { await openExisting(preview.existingId); return; }
            const r = await window.stomylos.command('patternCreate', { fingerprint: preview.fingerprint, operationId: crypto.randomUUID() });
            if (r.reused) await openExisting(r.id); setOffset(0);
          })}><Icon name={preview.existingId ? 'book' : 'plus'} /></button>
            {!keyPresent && !preview.existingId && <span className="note">An API key is needed to create a report. Saved reports work offline.</span>}</div>
        </> : <p role="status">Checking available evidence…</p>}
      </section>
      {state.phase !== 'idle' && <section className="learning-progress" role="status"><strong>{state.phase === 'saving' ? 'Saving your report…' : 'Creating your report…'}</strong>
        <p>{elapsed}s elapsed</p>
        {state.phase === 'generating' && <button disabled={busy} onClick={() => void act(() => window.stomylos.command('patternCancel', { id: state.reportId! }))}>Cancel generation</button>}
        {state.phase === 'saving' && disabled && <button onClick={() => void act(() => window.stomylos.command('patternRetrySave', undefined))}>Retry saving</button>}
      </section>}
      <div className="learning-history-heading"><h2>Saved reports</h2></div>
      {!cards.length && <p className="note">No saved reports yet.</p>}
      <div className="learning-reports">{cards.map(card => <article className="learning-card" key={card.id}>
        <div><h3>{date(card.created_at)}</h3><p>{card.scope.count} conversations · {date(card.scope.from)} – {date(card.scope.to)}</p>
          <span className="note">{card.status === 'succeeded' ? 'Ready to explore' : card.status === 'dispatched' ? 'Generating' : card.status === 'queued' ? 'Waiting' : message(card.failure ?? card.status)}</span></div>
        <div className="learning-actions"><button className="icon-button" aria-label="Open report" title="Open report" disabled={!card.selected_attempt_id || busy} onClick={() => void act(() => window.stomylos.command('patternOpen', { id: card.id }))}><Icon name="book" /></button>
          <Menu.Root><Menu.Trigger className="icon-button" aria-label="Report options" title="Report options"><Icon name="more" /></Menu.Trigger><Menu.Portal><Menu.Content className="partner-menu more-menu" align="end" sideOffset={6}>
            <Menu.Item className="partner-option" onSelect={() => void act(() => inspect(card.id))}>Report details</Menu.Item>
            <Menu.Separator className="menu-separator" />
            <Menu.Item className="partner-option destructive" disabled={busy || disabled} onSelect={() => setRemove(card)}>Delete report</Menu.Item>
          </Menu.Content></Menu.Portal></Menu.Root></div>
      </article>)}</div>
      {(more || offset > 0) && <div className="learning-actions"><button disabled={offset === 0} onClick={() => setOffset(n => Math.max(0, n - 20))}>Newer reports</button><button disabled={!more} onClick={() => setOffset(n => n + 20)}>Older reports</button></div>}
    </div>
    <Dialog.Root open={!!detail} onOpenChange={open => { if (!open) setDetail(null); }}><Dialog.Portal><Dialog.Overlay className="modal-overlay" /><Dialog.Content className="dialog pattern-details" aria-describedby={undefined}>
      <div className="dialog-heading"><Dialog.Title>Report details</Dialog.Title><Dialog.Close className="icon-button" aria-label="Close report details" title="Close"><Icon name="close" /></Dialog.Close></div>
      {error && <p className="notice danger" role="alert">{error}</p>}
      {detail && <><p>{detail.scope.count} conversations · {date(detail.scope.from)} – {date(detail.scope.to)}</p><p className="note">{detail.model} · medium · Created {new Date(detail.created_at).toLocaleString()}</p>
        {detail.selected_attempt_id && <button className="primary" onClick={() => void act(() => window.stomylos.command('patternOpen', { id: detail.id }))}>Open report</button>}
        {detail.canRetry && <><p className="note">Retry uses the same saved evidence. An interrupted request may already have incurred a charge.</p><button disabled={busy || disabled || !keyPresent || state.phase !== 'idle'} onClick={() => void act(() => window.stomylos.command('patternRetry', { id: detail.id, operationId: crypto.randomUUID() }))}>Retry generation</button></>}
        {!detail.canRetry && !detail.selected_attempt_id && detail.sources.some(s => s.deleted) && <p className="note">A source was deleted. Create a new report from available evidence instead.</p>}
        <details><summary>Generation attempts</summary>{detail.attempts.map(a => { const m = JSON.parse(a.metadata); return <div key={a.id} className="pattern-source"><strong>{a.status}</strong>
          <p className="note">Cost: {typeof m.usage?.cost === 'number' ? '$' + m.usage.cost.toFixed(4) : 'Unavailable'} · Time: {typeof m.elapsed_seconds === 'number' ? m.elapsed_seconds.toFixed(1) + 's' : 'Unavailable'}</p>{a.failure && <p className="note">{message(a.failure)}</p>}</div>; })}</details>
        <h3>Source evidence</h3>{detail.sources.map(s => <details key={s.session_id}><summary>{date(s.ended_at)} · {s.units.length} messages{s.deleted ? ' · Original conversation deleted' : ''}</summary>
          {!s.deleted && <button className="quiet" onClick={() => void act(async () => { await source(s.session_id); setDetail(null); })}>Open source conversation</button>}
          {s.units.map(u => <div className="pattern-source" key={u.source_id}><code>{u.source_id}</code><p><strong>Original</strong><br />{u.original}</p><p><strong>Correction</strong><br />{u.corrected}</p><p className="note">{u.explanation || 'No correction was proposed.'}</p></div>)}
        </details>)}</>}
    </Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={!!remove} onOpenChange={open => { if (!open && !busy) setRemove(null); }}><Dialog.Portal><Dialog.Overlay className="modal-overlay" /><Dialog.Content className="dialog" aria-describedby={undefined}>
      <div className="dialog-heading"><Dialog.Title>Delete this report?</Dialog.Title></div><p>The saved report, its evidence copy and generation attempts will be removed. Your conversations and grammar analyses remain.</p>
      <div className="dialog-actions"><button disabled={busy} onClick={() => setRemove(null)}>Cancel</button><button className="delete-confirm" disabled={busy || disabled} onClick={() => void act(async () => { if (!remove) return; await window.stomylos.command('patternDelete', { id: remove.id }); if (detail?.id === remove.id) setDetail(null); setRemove(null); setOffset(0); })}>Delete report</button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
