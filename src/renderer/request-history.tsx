import type { RequestAttempt, RequestHistory } from '../shared/request-history';
import { SearchCost } from './search';
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const stamp = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : 'Not recorded';
const statusLabel = (status: string) => ({ ready: 'succeeded', pending: 'pending' }[status] ?? status);
function Attempt({ attempt: a, errorText }: { attempt: RequestAttempt; errorText: (code: string) => string }) {
  const m = a.metadata, u = m.usage ?? {}, settings = a.settings;
  const uncertain = a.failure !== 'queued_not_dispatched' &&
    ((a.status === 'interrupted' && a.dispatchedAt !== null) || /timeout|transport|cancelled|unknown_outcome/.test(a.failure ?? ''));
  const times: [string, unknown][] = [['Elapsed', m.elapsed_seconds], ['To first token', m.first_token_seconds],
    ['To first answer', m.first_answer_seconds], ['To first reasoning', m.first_reasoning_seconds],
    ['From Send to first answer', m.send_to_first_answer_seconds], ['From Send to completion', m.send_to_completion_seconds],
    ['To first valid JSON', m.first_valid_seconds]];
  return <article className="request" data-request-id={a.id}>
    <strong>{a.kind}</strong><span className="tag neutral">{statusLabel(a.status)}</span>
    <small>{stamp(a.createdAt)}</small>
    {a.model && <small>Requested: {a.model}{settings.reasoning ? ` · ${JSON.stringify(settings.reasoning)}` : ''}</small>}
    {(m.model || m.provider) && <small>Reported: {m.model ?? 'Model not reported'}{m.provider ? ` · ${m.provider}` : ''}</small>}
    {a.failure && <small>{a.kind === 'Conversation' ? errorText(a.failure) : a.failure.replaceAll('_', ' ')}</small>}
    {m.finish_reason && <small>Finish reason: {m.finish_reason}</small>}
    {times.filter(([, value]) => numeric(value)).map(([label, value]) => <small key={label}>{label}: {Number(value).toFixed(2)} seconds</small>)}
    {numeric(m.routing_network_ms) && <small>{Math.round(m.routing_network_ms)} ms through completed gate</small>}
    {numeric(u.prompt_tokens) && <small>{u.prompt_tokens} input tokens{numeric(u.prompt_tokens_details?.cached_tokens) ? ` · ${u.prompt_tokens_details.cached_tokens} cached input tokens` : ''}</small>}
    {!numeric(u.prompt_tokens) && numeric(u.prompt_tokens_details?.cached_tokens) && <small>{u.prompt_tokens_details.cached_tokens} cached input tokens</small>}
    {numeric(u.completion_tokens) && <small>{u.completion_tokens} output tokens{numeric(u.completion_tokens_details?.reasoning_tokens) ? ` · ${u.completion_tokens_details.reasoning_tokens} reasoning tokens` : ''}</small>}
    {!numeric(u.completion_tokens) && numeric(u.completion_tokens_details?.reasoning_tokens) && <small>{u.completion_tokens_details.reasoning_tokens} reasoning tokens</small>}
    {numeric(u.total_tokens) && <small>{u.total_tokens} total tokens</small>}
    <small>Reported cost: {numeric(u.cost) ? `$${u.cost.toFixed(6)}` : 'Not reported'}</small>
    <SearchCost metadata={m} />
    {uncertain && <small>The provider outcome or final charge may be unknown. This request may already have been billed; retrying may incur another charge.</small>}
    {a.notes?.map(note => <small key={note}>{note}</small>)}
    {a.retainedText && <p className="retained-text">{a.retainedText}</p>}
    <details><summary>Technical details</summary>
      <small>Request ID: {a.id}</small>{m.id && <small>Provider request ID: {m.id}</small>}
      {a.parentId && <small>Previous attempt: {a.parentId}</small>}{a.messageId && <small>Message ID: {a.messageId}</small>}
      <small>Dispatched: {stamp(a.dispatchedAt)}</small><small>Finished: {stamp(a.finishedAt)}</small>
      {a.provenance && <pre className="request-settings">{JSON.stringify(a.provenance, null, 2)}</pre>}
      {Object.keys(settings).length > 0 && <><small>Saved request settings</small><pre className="request-settings">{JSON.stringify(settings, null, 2)}</pre></>}
    </details>
  </article>;
}
export function RequestHistoryRows({ history, errorText }: { history: RequestHistory; errorText: (code: string) => string }) {
  return <>
    {!history.attempts.length && <p className="note">No recorded request attempts for this chat.</p>}
    {history.attempts.map(a => <Attempt key={`${a.kind}:${a.id}`} attempt={a} errorText={errorText} />)}
    <details><summary>History coverage</summary><p className="note">Includes recorded attempts, including queued or unsent attempts. Cached audio playback and local memory recall do not send another provider request. Pattern report requests are shown with their reports.</p>
      {history.notices.map(note => <p className="note" key={note}>{note}</p>)}</details>
  </>;
}
