import { Explainable, ExplainHistory, ExplainDialog } from './explain';
import { SearchSources, SearchCost, SearchAttempts } from './search';
import type { PatternCard } from '../shared/pattern-report';
import { Learning, usePatternState } from './learning';
import { GenieDock, UndoGenie, useGenie, genieBusy, openGenie, captureGenieRange, closeGenieForApp, genieError } from './genie';
import { DictationPanel, RecordButton, DictationNavigationDialog, useDictation, dictationBusy, beforeDictationNavigation, selectDictationSession, prepareDictationSend, dictationSent } from './dictation';
import { SpeechControl, selectSpeechSession } from './speech';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import * as Dialog from '@radix-ui/react-dialog';
import type { AppSnapshot, Character, Message, SessionView, SessionSummary } from '../shared/types';
import { memoryCategories } from '../shared/memory';
import { MemoryChangeHistory } from './memory-changes';
import { loadView, onDeleted, isDeleted, onClose, onViewChanged, useApp, useStream, useStartupError, reloadSnapshot } from './client';
import { currentDraft, forgetDraft, editDraft, flushAllDrafts, flushDraft, initializeDraft, submittedDraft, useDraft } from './drafts';
import { Icon } from './icons';
import { IconButton } from './icon-button';
import { SettingsDialog, type SettingsTab } from './settings';
import { maintenanceNotices } from './maintenance';
import { AssistantMarkdown } from './markdown';
import { useConversationScroll } from './conversation-scroll';
import { BookmarkUndo, useBookmarks, useHistory } from './bookmarks';
import './style.css';

const labels: Record<string, string> = { none: 'In progress', pending: 'Analysis ready to run', running: 'Analyzing',
  completed: 'Analysis saved', failed: 'Analysis needs attention', skipped: 'No learner messages' };
function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code.startsWith('genie_')) return genieError(error);
  const messages: Record<string, string> = {
    bookmark_requires_message: 'Send a message before bookmarking.',
    delete_requires_ended: 'End this chat before deleting it.',
    session_deleting: 'This chat is being deleted.',
    session_not_found: 'This chat is no longer available.',
    asr_save_required: 'Dictation has unsaved changes. Keep this window open and use Retry saving dictation. Recognized text can also be copied.',
    asr_busy: 'Finish or cancel the current voice input before continuing.',
    api_key_missing: 'No API key is available. Your draft is saved; you can still browse previous chats.',
    session_limit: 'This chat has reached its size limit. End it and start a new chat to continue.',
    reply_in_progress: 'Please wait for the current reply, or end this chat.',
    reply_unresolved: 'Retry the interrupted reply or end this chat before sending another message.',
    partner_selection_failed: 'Auto could not choose another partner. Choose one yourself or retry selection.',
    partner_selection_changed: 'The partner choice changed. Please select again.',
    partner_selection_pending: 'Choose a partner or finish Auto selection before continuing.',
    partner_no_alternative: 'No other model is available in this chat’s saved choices.',
    partner_input_limit: 'The recent message is too large for Auto selection. Choose a partner yourself.',
    reply_not_retryable: 'This reply no longer needs a retry.',
    save_required: 'Save your latest changes before continuing.', save_still_unavailable: 'Saving is still unavailable. Your latest text remains in memory.',
    request_timeout: 'The request timed out. Your conversation is saved.',
    transport_failed: 'The connection failed. Your conversation is saved.',
    stream_incomplete: 'The reply ended unexpectedly. Its received text is preserved.',
    response_incomplete: 'The provider did not finish the reply normally. Any received text is saved; you can retry the reply.',
    response_length_limit: 'The reply reached its output token limit before finishing. The partial reply is saved. Retry reply to generate it again.',
    response_filtered: 'The provider stopped the reply because of its content filter. Any received text is saved.',
    provider_api_error: 'The model provider reported an error. Any received text is saved; you can retry the reply.',
    stream_idle_timeout: 'The reply stopped arriving for too long. Any received text is saved; you can retry the reply.',
    closing: 'Stomylos is saving and closing.',
    unsupported_conversation_prompt: 'This chat uses an unsupported saved prompt. Its history and settings have been preserved.',
    unsupported_conversation_settings: 'This chat uses unsupported saved model settings. Its history and settings have been preserved.',
    unsupported_grammar_settings: 'This analysis uses unsupported saved settings. The transcript and settings have been preserved.',
    invalid_key_file: 'The key file contains an invalid OPENROUTER_API_KEY entry. Check the file shown in Settings.',
    duplicate_api_key: 'The key file contains more than one OPENROUTER_API_KEY entry. Keep only one entry.',
    key_file_unreadable: 'The key file could not be read. Check its permissions in Settings.',
    invalid_api_key: 'Enter a non-empty API key without spaces or line breaks.',
    secure_storage_unavailable: 'System secure storage is unavailable or locked. Unlock it and reload, or explicitly choose the .env source.',
    credential_file_unreadable: 'The saved key file could not be read. Check its permissions, save a replacement key, or delete the saved key to reset it.',
    credential_decrypt_failed: 'The saved key could not be decrypted. Unlock your system keyring and reload, save a replacement, or explicitly choose .env.',
    credential_encrypt_failed: 'The new key could not be encrypted and verified. The previous key was kept.',
    credential_save_failed: 'The key settings could not be saved. Check folder permissions and disk space. The previous key and source were kept.',
    credential_management_disabled: 'Key management is disabled in this isolated development or preview session.',
    analysis_not_retryable: 'This analysis is already running or has been saved.',
    starter_not_retryable: 'Starter renewal is already running or has been saved.',
    memory_waiting_for_earlier_session: 'Resolve the earlier memory update first. Your conversation can continue.',
    memory_not_retryable: 'This memory update is already running or has been resolved.',
    memory_not_skippable: 'Wait for the current memory update to finish before skipping it.',
    opening_changed: 'The opening has changed. Your draft is preserved; try the action again.',
    opening_is_frozen: 'The conversation has already started. Start a new chat to change how it begins.',
    unsupported_opening: 'This saved chat uses its original opening. Start a new chat to use the new entry options.',
    opening_operation_conflict: 'This opening action no longer matches. Your draft is preserved.',
    opening_source_changed: 'The saved opening could not be verified. Its data has been preserved.',
    starter_changed: 'The starter has changed. Choose Another question again if needed.',
    starter_outdated: 'This question is outdated. Choose another question or start with your own topic. Your draft is preserved.',
    starter_skip_conflict: 'This question change has already been handled. The saved starter is available.'
  };
  return messages[code] ?? 'The operation could not finish. Your existing conversation remains available.';
}
function Chevron({ open }: { open: boolean }) { return <svg className={`chevron ${open ? 'rotated' : ''}`} viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>; }
function Modal({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (value: boolean) => void; title: string; children: ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="modal-overlay" /><Dialog.Content className="dialog" aria-describedby={undefined}>
    <div className="dialog-heading"><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="icon-button" aria-label="Close dialog" title="Close"><Icon name="close" /></Dialog.Close></div>{children}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
const Partner = memo(function Partner({ view, characters, act, blocked }: { view: SessionView; characters: Character[]; blocked: boolean; act: (fn: () => Promise<unknown>) => void }) {
  const [open, setOpen] = useState(false); const { session } = view;
  characters = JSON.parse(session.chat_config).characters as Character[];
  const selected = session.state === 'draft' ? session.manual_character : session.state !== 'ended' && view.partner.pending ? view.partner.pending.choice : view.partner.currentCharacter;
  const genie = useGenie(); useDictation();
  const locked = genie.locked || dictationBusy() || blocked;
  const label = characters.find(c => c.id === selected)?.label ?? 'Automatic';
  if (session.state === 'ended') return <span className="current-partner">{selected ? label : 'No partner selected'}</span>;
  return <Menu.Root open={open} onOpenChange={setOpen}><Menu.Trigger className="partner" aria-label={`Partner: ${label}`} title="Choose a conversation partner" disabled={locked || (session.state === 'active' && !session.character)}>
    <strong>{label}</strong><Chevron open={open} />{view.partner.pending && <span className="partner-pending" role="status">{view.partner.pending.state === 'failed' ? 'Selection incomplete' : 'Next reply'}</span>}</Menu.Trigger>
    <Menu.Portal><Menu.Content className="partner-menu" sideOffset={8} align="start" collisionPadding={12}>
      <Menu.RadioGroup value={selected ?? 'automatic'} onValueChange={value => act(() => session.state === 'draft'
        ? window.stomylos.command('selectPartner', { sessionId: session.id, character: value === 'automatic' ? null : value })
        : window.stomylos.command('changePartner', { sessionId: session.id, character: value === 'automatic' ? null : value, operationId: crypto.randomUUID(), expectedRevision: view.partner.revision }))}>
        {[{ id: 'automatic', label: 'Automatic', description: session.state === 'draft' ? 'Choose a partner from your first message.' : 'Choose another partner from recent conversation on your next message.' }, ...characters].map(option => <Menu.RadioItem className="partner-option" key={option.id} value={option.id}>
          <span><strong>{option.label}</strong><small>{option.description}</small></span><Menu.ItemIndicator><Icon name="check" /></Menu.ItemIndicator>
        </Menu.RadioItem>)}
      </Menu.RadioGroup>
    </Menu.Content></Menu.Portal>
  </Menu.Root>;
});
const Bubble = memo(function Bubble({ message, partner, starterAction, metadata }: { message: Message; partner: string; starterAction?: ReactNode; metadata?: import('../shared/types').Json }) {
  const content = useStream(message.id, message.content, message.delivery === 'streaming');
  return <article className={`bubble ${message.role === 'user' ? 'user' : ''}`} data-message-id={message.id} data-message-origin={message.origin} aria-label={message.role === 'user' ? 'Your message' : message.origin === 'starter' ? 'Starter question' : partner}>
    {content && message.role === 'assistant' && message.origin === 'model' ? <Explainable message={message}><AssistantMarkdown content={content} withSource /></Explainable>
      : <p>{content || (message.delivery === 'streaming' ? <span className="typing" aria-label="Waiting for reply">•••</span> : 'No reply text was received.')}</p>}
    {metadata && <SearchSources metadata={metadata} />}
    {message.role !== 'user' && <div className="bubble-heading">{starterAction}
      {message.delivery !== 'complete' && <span className="delivery" role="status">{message.delivery === 'streaming' ? 'Writing…' : 'Interrupted'}</span>}<ExplainHistory message={message} /><SpeechControl message={message} /></div>}
  </article>;
});
function Disclosure({ title, subtitle, children, onToggle, initialOpen = false }: { title: string; subtitle?: string; children: ReactNode; onToggle?: () => void; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen); const heading = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (initialOpen) { const frame = requestAnimationFrame(() => { heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'start' }); }); return () => cancelAnimationFrame(frame); } }, []);
  return <section className="disclosure"><button ref={heading} className="disclosure-heading" aria-expanded={open} onClick={() => { onToggle?.(); setOpen(value => !value); }}>
    <span><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span><Chevron open={open} /></button>
    <div className={`expansion ${open ? 'open' : ''}`} inert={!open} aria-hidden={!open}><div className="expansion-clip"><div className="disclosure-body">{children}</div></div></div>
  </section>;
}
const Analysis = memo(function Analysis({ view }: { view: SessionView }) {
  const [changedOnly, setChangedOnly] = useState(true); const state = view.session.analysis_state;
  const changed = view.units.filter(unit => unit.changed); const visible = changedOnly ? changed : view.units;
  const last = view.requests.findLast(request => request.role === 'grammar');
  const subtitle = state === 'completed' ? `${changed.length} suggested ${changed.length === 1 ? 'change' : 'changes'} · ${view.units.length} messages analyzed` :
    state === 'running' && last?.status === 'queued' ? 'Queued · you can start another chat' : labels[state];
  return <div className="review-body"><h2>Feedback</h2><p className="note">{subtitle}</p>
    {state === 'completed' ? <>
      <p className="note">AI suggestions may miss errors or suggest unnecessary changes.</p>
      <label className="check"><input type="checkbox" checked={changedOnly} onChange={event => setChangedOnly(event.target.checked)} />Only show suggested changes</label>
      {!visible.length && <p className="empty-note">No changes were suggested. Uncheck the filter to see all analyzed messages.</p>}
      {visible.map(unit => <article className="analysis-unit" key={unit.source_message_id}>
        <div className="unit-head"><span>YOUR MESSAGE {unit.ordinal + 1}</span><span className={`tag ${unit.changed ? '' : 'neutral'}`}>{unit.changed ? 'Suggested change' : 'Unchanged'}</span></div>
        <div className="field-label">Original</div><p>{unit.text}</p>
        {unit.changed === 1 && <><div className="field-label">Suggested correction</div><p className="correction">{unit.corrected_text}</p></>}
        {unit.explanation && <><div className="field-label">Context note</div><p className="context">{unit.explanation}</p></>}
        {unit.warnings !== '[]' && <p className="note warning">The analyzer attached a note without changing the text.</p>}
      </article>)}
    </> : <>
      <p className="note">{state === 'failed' ? 'Analysis did not finish successfully. Your full conversation is saved. A retry uses the same conversation and analysis settings.' :
        state === 'skipped' ? 'This chat ended before you sent a message, so there is nothing to analyze.' :
        state === 'running' ? 'Analysis is working in the background. You can browse history or start another chat.' :
        'Your conversation is saved. Analysis has not been sent; it will run only when you choose to try it.'}</p>
    </>}
  </div>;
});
function Feedback({ view, controls, onReveal }: { view: SessionView; controls: HTMLDivElement | null; onReveal: () => void }) {
  const [open, setOpen] = useState(false);
  const section = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (open) section.current?.scrollIntoView({ block: 'start' }); }, [open]);
  return <>
    <section ref={section} className={`analysis-review expansion ${open ? 'open' : ''}`} id="conversation-review" inert={!open} aria-hidden={!open} aria-label="Analysis details"><div className="expansion-clip"><Analysis view={view} /></div></section>
    {controls && createPortal(<button className="icon-button" aria-label={`Analysis details · ${view.session.analysis_state === 'completed' ? `${view.units.filter(u => u.changed).length} suggested changes · ${view.units.length} messages analyzed` : labels[view.session.analysis_state]}`} title="Review feedback" aria-expanded={open} aria-controls="conversation-review" onClick={() => { onReveal(); setOpen(value => !value); }}><Icon name="review" /></button>, controls)}
  </>;
}
function Renewal({ view, onToggle, act, initialOpen = false }: { view: SessionView; onToggle: () => void; act: (fn: () => Promise<unknown>) => void; initialOpen?: boolean }) {
  const renewal = view.renewal;
  const preparation = view.intentions?.preparation, jobs = view.intentions?.jobs ?? [];
  const unfinished = jobs.filter(j => ['failed', 'interrupted'].includes(j.state));
  const preparing = preparation?.state === 'waiting';
  const progress = preparing ? view.memory?.job?.state === 'completed' ? 'Preparing questions from memory' : 'Waiting for memory update' : '';
  const recovery = <>{(preparing || jobs.length > 0) && <div>
    {preparing && <p className="note">{progress}. You can start another chat.</p>}
    {jobs.length > 0 && <p className="note">{jobs.filter(j => j.state === 'accepted').length} questions from memory saved; {unfinished.length} need attention.</p>}
    {unfinished.length > 0 && <button onClick={() => act(() => window.stomylos.command('retryIntentionQuestions', { sessionId: view.session.id }))}>Retry questions from memory</button>}
    {preparing && <button onClick={() => act(() => window.stomylos.command('retryStarterRenewal', { sessionId: view.session.id }))}>Continue question preparation</button>}
    {preparation?.reason && !['synchronized','no_memory_update'].includes(preparation.reason) && <p className="note">Starter renewal proceeded with the available questions.</p>}
    {jobs.flatMap(j => j.attempts).map(a => <p className="note" key={a.id}>Question attempt {a.route + 1}: {a.status}{a.failure ? ` · ${a.failure.replaceAll('_', ' ')}` : ''}{JSON.parse(a.metadata).usage?.cost != null ? ` · $${Number(JSON.parse(a.metadata).usage.cost).toFixed(6)}` : ''}</p>)}
  </div>}</>;
  if (!renewal) return preparation || jobs.length ? <Disclosure initialOpen={initialOpen} title="Starter renewal" subtitle={progress || 'Questions from memory'} onToggle={onToggle}>{recovery}</Disclosure> : null;
  const subtitle = renewal.state === 'completed' ? `${renewal.accepted_count} new ${renewal.accepted_count === 1 ? 'question' : 'questions'} saved` :
    renewal.state === 'running' ? 'Generating questions' : renewal.state === 'pending' ? 'Pending' : 'Needs attention';
  return <Disclosure initialOpen={initialOpen} title="Starter renewal" subtitle={subtitle} onToggle={onToggle}>
    {recovery}
    <p className="note">{renewal.state === 'completed' ? 'New questions replenish the local pool as space becomes available.' :
      renewal.state === 'running' ? 'Questions are being generated in the background. You can start another chat.' :
      renewal.state === 'pending' ? 'This saved conversation is ready for starter renewal. If it remains pending, choose to try it below.' :
      'Starter renewal did not finish. Your conversation is saved. A retry uses the same conversation and generator settings.'}</p>
    {['pending', 'failed', 'interrupted'].includes(renewal.state) && <button onClick={() => act(() => window.stomylos.command('retryStarterRenewal', { sessionId: view.session.id }))}>Try starter renewal again</button>}
  </Disclosure>;
}
function MemoryDetails({ view, act, show, openShared, initialOpen }: { view: SessionView; act: (fn: () => Promise<unknown>) => void; show: (id: string) => Promise<void>; openShared(): void; initialOpen: boolean }) {
  const memory = view.memory, job = memory?.job;
  const state = job?.state;
  const recover = !!state && ['pending', 'failed', 'interrupted'].includes(state);
  return <Disclosure initialOpen={initialOpen} title="Shared memory" subtitle={state === 'completed' ? 'Updated' : state === 'running' ? 'Updating' : state === 'skipped' ? 'Update skipped' : recover ? 'Update pending' : undefined}>
    <p className="note">This chat keeps the memory it used. Its update contributes to future chats.</p><button onClick={openShared}>Open shared memory</button>
    {recover && <p className="note">Your chat is saved. {memory.blockedBy ? 'An earlier memory update needs to be resolved first.' : 'Choose to retry this update or skip it. Skipping leaves this chat out of future memory.'}</p>}
    {memory?.blockedBy && recover && <button onClick={() => act(() => show(memory.blockedBy!))}>Open earlier chat</button>}
    {recover && !memory.blockedBy && <button onClick={() => act(() => window.stomylos.command('retryMemory', { sessionId: view.session.id }))}>Retry memory update</button>}
    {recover && <button onClick={() => act(() => window.stomylos.command('skipMemory', { sessionId: view.session.id }))}>Skip this memory update</button>}
    <Disclosure title="Changes from this chat">
      <MemoryChangeHistory memory={memory} ended={view.session.state === 'ended'} />
    </Disclosure>
    {([['Used in this chat', memory?.snapshot]] as const).map(([title, doc]) => <Disclosure title={title} key={title}>
      {!doc ? <p className="note">{JSON.parse(view.session.chat_config).memory_version ? 'Memory is chosen when the partner first replies.' : 'This older chat did not use memory.'}</p> : memoryCategories.map(category => <section key={category}>
        <strong>{category[0].toUpperCase() + category.slice(1)}</strong>
        {doc[category].length ? <ul>{doc[category].map(item => <li key={item.id}>{item.text}</li>)}</ul> : <p className="note">Nothing recorded.</p>}
      </section>)}
    </Disclosure>)}
  </Disclosure>;
}
function RequestDetails({ view, onToggle }: { view: SessionView; onToggle: () => void }) {
  const dictations = useDictation().snapshot.records.filter(r => r.sessionId === view.session.id);
  const count = (view.searches?.reduce((n, s) => n + s.attempts.length, 0) ?? 0) + view.requests.length + (view.renewal?.attempts.length ?? 0) + (view.memory?.attempts.length ?? 0) + dictations.reduce((sum, record) => sum + record.attempts.length, 0);
  return <Disclosure title="Request details" subtitle={`${count} ${count === 1 ? 'attempt' : 'attempts'}`} onToggle={onToggle}>
    {!count && <p className="note">No model requests have been made for this chat.</p>}
    {view.requests.map(request => { const metadata = JSON.parse(request.metadata), settings = JSON.parse(request.config); const requestedModel = settings.request_partner?.target.model ?? (request.role === 'chat' ? view.session.model : settings.parameters?.model); return <div className="request" key={request.id}>
      <strong>{request.role === 'chat' ? 'Conversation' : request.role === 'router' ? settings.purpose === 'partner_reselection' ? 'Partner reselection' : 'Partner selection' : 'Grammar analysis'}</strong><span className="tag neutral">{request.status}</span>
      <small>{new Date(request.created_at).toLocaleString()}</small>
      {requestedModel && <small>Requested: {requestedModel}{settings.request_partner?.target.reasoning ? ` · ${JSON.stringify(settings.request_partner.target.reasoning)}` : ''}</small>}
      {settings.purpose === 'partner_reselection' && <small>Excluded: {settings.excluded_model} · {settings.source_message_ids.length} recent messages · {settings.omitted_groups} earlier turns omitted</small>}
      {metadata.model && <small>Reported: {metadata.model}{metadata.provider ? ` · ${metadata.provider}` : ''}</small>}
      {request.failure && <small>{request.role === 'chat' ? errorText(request.failure) : request.failure.replaceAll('_', ' ')}</small>}
      {metadata.finish_reason && <small>Finish reason: {metadata.finish_reason}</small>}
      {metadata.elapsed_seconds != null && <small>{Number(metadata.elapsed_seconds).toFixed(1)} seconds</small>}
      {metadata.send_to_first_answer_seconds != null && <small>From Send: {Number(metadata.send_to_first_answer_seconds).toFixed(2)} s to first answer text · {Number(metadata.send_to_completion_seconds).toFixed(2)} s to completion</small>}
      {request.status === 'interrupted' && request.dispatched_at && <small>The provider's outcome is unknown. An explicit retry may incur another charge.</small>}
      {metadata.usage?.total_tokens != null && <small>{metadata.usage.total_tokens} tokens{metadata.usage.cost != null ? ` · $${Number(metadata.usage.cost).toFixed(5)}` : ''}</small>}
      {metadata.usage?.completion_tokens != null && <small>{metadata.usage.completion_tokens} output tokens{metadata.usage.completion_tokens_details?.reasoning_tokens != null ? ` · ${metadata.usage.completion_tokens_details.reasoning_tokens} reasoning tokens` : ''}</small>}
      <SearchCost metadata={metadata} />
      {request.status !== 'succeeded' && request.response_content && <p className="retained-text">{request.response_content}</p>}
    </div>; })}
    <SearchAttempts view={view} />
    {dictations.flatMap(record => record.attempts.map(attempt => <div className="request" key={attempt.id}>
      <strong>Speech recognition</strong><span className="tag neutral">{attempt.error ? 'Needs attention' : attempt.finishedAt ? 'Completed' : 'Dispatched'}</span>
      <small>{new Date(attempt.dispatchedAt).toLocaleString()} · {record.config.model}</small>
      <small>{record.duration.toFixed(1)} seconds of audio</small>
      {attempt.error && <small>{attempt.error.replaceAll('_', ' ')}. An uploaded request may still be billed.</small>}
      {attempt.usage?.cost != null && <small>${Number(attempt.usage.cost).toFixed(5)}</small>}
      {record.submitted && <small>{record.submitted.edited ? 'Edited dictation was sent.' : 'Dictation was sent.'}</small>}
    </div>))}
    {view.memory?.attempts.map(request => { const metadata = JSON.parse(request.metadata); return <div className="request" key={request.id}>
      <strong>Memory update</strong><span className="tag neutral">{request.status}</span>
      <small>{new Date(request.created_at).toLocaleString()}</small>
      {metadata.model && <small>{metadata.model}</small>}
      {metadata.elapsed_seconds != null && <small>{Number(metadata.elapsed_seconds).toFixed(1)} seconds</small>}
      {metadata.usage?.cost != null && <small>${Number(metadata.usage.cost).toFixed(5)}</small>}
      {request.failure && <small>{request.failure.replaceAll('_', ' ')}</small>}
      {request.status === 'interrupted' && request.dispatched_at && <small>The provider's outcome is unknown. Retrying sends another request.</small>}
    </div>; })}
    {view.renewal?.attempts.map(request => { const metadata = JSON.parse(request.metadata); return <div className="request" key={request.id}>
      <strong>Starter generation</strong><span className="tag neutral">{request.status}</span>
      <small>{new Date(request.created_at).toLocaleString()}</small>
      <small>{metadata.model ?? view.renewal!.model}{metadata.provider ? ` · ${metadata.provider}` : ''}</small>
      {metadata.elapsed_seconds != null && <small>{Number(metadata.elapsed_seconds).toFixed(1)} seconds</small>}
      {metadata.usage?.total_tokens != null && <small>{metadata.usage.total_tokens} tokens</small>}
      {metadata.usage?.cost != null && <small>${Number(metadata.usage.cost).toFixed(5)}</small>}
      {request.failure && <small>{request.failure.replaceAll('_', ' ')}</small>}
      {request.status === 'interrupted' && request.dispatched_at && <small>The provider's outcome is unknown. An explicit retry may incur another charge.</small>}
    </div>; })}
  </Disclosure>;
}
function Composer({ view, app, act, openingAction, starter, blocked, onComposition, afterAcceptedAction }: { view: SessionView; app: AppSnapshot; act: (fn: () => Promise<unknown>) => void; openingAction?: ReactNode; starter?: ReactNode; blocked: boolean; onComposition: (value: boolean) => void; afterAcceptedAction: () => () => void }) {
  const dictation = useDictation(); const genie = useGenie();
  const selection = useRef<ReturnType<typeof captureGenieRange> | null>(null);
  const id = view.session.id; const draft = useDraft(id); const composing = useRef(false); const textarea = useRef<HTMLTextAreaElement>(null);
  const openingRevision = useRef(view.session.opening_revision);
  useEffect(() => { if (openingRevision.current !== view.session.opening_revision) { openingRevision.current = view.session.opening_revision; textarea.current?.focus({ preventScroll: true }); } }, [view.session.opening_revision]);
  const [sending, setSending] = useState(false); const busy = app.activity.sessionId === id && app.activity.phase !== 'idle';
  const last = view.messages.at(-1); const unresolved = last?.role === 'user' || last?.delivery === 'interrupted';
  const retryLabel = (JSON.parse(view.session.chat_config).characters as Character[]).find(c => c.model === view.partner.retryModel)?.label ?? 'the previous partner';
  const users = view.messages.filter(m => m.origin === 'learner'); const encoder = new TextEncoder();
  const userBytes = users.reduce((total, m) => total + encoder.encode(m.content).length, 0);
  const totalBytes = view.messages.reduce((total, m) => total + encoder.encode(m.content).length, 0);
  const draftBytes = encoder.encode(draft.text).length;
  const overBudget = draft.text !== '/end' && (users.length >= 24 || userBytes + draftBytes > 6000 || totalBytes + draftBytes > 24000);
  const near = users.length >= 19 || userBytes >= 4800 || totalBytes >= 19200;
  useEffect(() => { const timer = setTimeout(() => { void flushDraft(id).catch(() => undefined); }, 350); return () => clearTimeout(timer); }, [id, draft.revision]);
  useEffect(() => { const node = textarea.current; if (node) { node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 160)}px`; } }, [draft.text]);
  const send = () => act(async () => {
    if ((view.outdatedOpening && draft.text !== '/end') || blocked || genieBusy() || sending || dictationBusy() || overBudget || !draft.text.trim()) return;
    const accepted = afterAcceptedAction();
    setSending(true);
    try {
      const dictationIds = await prepareDictationSend(id); const submitted = currentDraft(id);
      await window.stomylos.command('sendMessage', { sessionId: id, text: submitted.text, revision: submitted.revision, dictationIds });
      submittedDraft(id, submitted.revision); dictationSent(id); textarea.current?.focus({ preventScroll: true });
      if (submitted.text !== '/end') accepted();
    } finally { setSending(false); }
  });
  return <footer className={genie.locked ? 'help-open' : undefined}>
    {overBudget && <p className="limit-note">This draft exceeds the remaining chat allowance. It is preserved; shorten or copy it before sending.</p>}
    {view.outdatedOpening && <p className="limit-note" role="status">This question is outdated. Choose another question or start with your own message. Your draft is preserved.</p>}
    {near && <p className="limit-note">This chat is nearing its size limit. You can end it and continue in a new chat.</p>}
    {unresolved && !busy && <div className="reply-recovery"><span>{view.partner.pending?.state === 'failed' ? 'Auto selection is incomplete.' : 'The last reply is incomplete.'}{view.partner.pending && view.partner.canRetryReply ? ` Retry reply uses ${retryLabel}.` : ''}</span>
      {view.partner.canRetryReply && <button title={view.partner.retryModel ? `Retry with ${view.partner.retryModel}` : undefined} onClick={() => act(async () => { const accepted = afterAcceptedAction(); await window.stomylos.command('retryReply', { sessionId: id }); accepted(); })}>Retry reply</button>}
      {view.partner.canUseSelected && <button onClick={() => act(async () => { const accepted = afterAcceptedAction(); await window.stomylos.command('useSelectedPartner', { sessionId: id }); accepted(); })}>Use selected partner</button>}
      {view.partner.pending?.state === 'failed' && <button onClick={() => act(async () => { const accepted = afterAcceptedAction(); await window.stomylos.command('retryPartnerSelection', { sessionId: id }); accepted(); })}>Retry selection</button>}
    </div>}
    <div className="composer">
      <GenieDock sessionId={id} textarea={textarea} storageError={app.activity.storageError} />
      {starter && !genie.locked && <div className="starter-dock" aria-label="Conversation starter">{starter}</div>}
      <DictationPanel sessionId={id} disabled={blocked || sending || busy || unresolved || !app.settings.keyPresent || !!app.activity.storageError || app.activity.closing} />
      <textarea ref={textarea} data-voice-composer aria-label="Your message" title="Enter to send · Shift+Enter for a new line · F8 for voice input" placeholder={view.session.state === 'draft' && view.session.opening_kind === 'user' ? "What's on your mind?" : 'Your message…'} value={draft.text}
      readOnly={dictation.locked || genie.locked || blocked} disabled={app.activity.closing} onSelect={event => { selection.current = captureGenieRange(event.currentTarget, currentDraft(id).text); }} onChange={event => editDraft(id, event.target.value)}
      onCompositionStart={() => { composing.current = true; onComposition(true); }} onCompositionEnd={() => { composing.current = false; onComposition(false); }}
      onKeyDown={event => { if (event.key === 'Enter' && !event.repeat && !dictationBusy() && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
        event.preventDefault(); if (draft.text === '/end' || (!busy && !unresolved)) send();
      } }} />
      <div className="composer-actions"><button className="icon-button genie-help" data-explain-return aria-label="Genie" title="Genie · Help with wording" disabled={blocked || genie.locked || sending || busy || unresolved || dictation.locked || users.length >= 24 || !app.settings.keyPresent || !!app.activity.storageError || app.activity.closing}
        onPointerDown={() => { if (textarea.current) selection.current = captureGenieRange(textarea.current, currentDraft(id).text); }}
        onClick={() => { if (!composing.current && textarea.current) act(() => openGenie(id, selection.current ?? captureGenieRange(textarea.current!, currentDraft(id).text))); }}><Icon name="help" /></button><button className="icon-button search-toggle" aria-pressed={view.session.search_mode === 'auto'}
          aria-label={`Web search: ${view.session.search_mode === 'auto' ? 'Auto' : 'Off'}`}
          title={view.session.search_mode === 'auto' ? 'Web search: Auto — Search when helpful' : 'Web search: Off — No web search'}
          disabled={blocked || sending || busy || unresolved || genie.locked || dictation.locked || !!app.activity.storageError || app.activity.closing}
          onClick={() => act(() => window.stomylos.command('searchMode', { sessionId: id, mode: view.session.search_mode === 'auto' ? 'off' : 'auto' }))}>
          <Icon name={view.session.search_mode === 'auto' ? 'globe' : 'globeOff'} /></button>{openingAction}<UndoGenie sessionId={id} textarea={textarea} /><span className="composer-spacer" /><RecordButton sessionId={id} disabled={blocked || genie.locked || sending || busy || unresolved || !app.settings.keyPresent || !!app.activity.storageError || app.activity.closing} />
        <span className={draft.error ? 'draft-error' : 'sr-only'} role="status">{draft.error ? 'Draft not saved' : draft.revision !== draft.saved ? 'Saving draft…' : 'Draft saved'}</span>
        <button className="primary icon-button send" aria-label="Send" title="Send · Enter" onClick={send} disabled={(view.outdatedOpening && draft.text !== '/end') || blocked || genie.locked || sending || dictation.locked || overBudget || !draft.text.trim() || app.activity.closing || (draft.text !== '/end' && (busy || unresolved))}><Icon name="send" /></button></div></div>
  </footer>;
}
function App() {
  const [learning, setLearning] = useState(false);
  const [requestedReport, setRequestedReport] = useState<string | null>(null);
  const handledReport = useCallback(() => setRequestedReport(null), []);
  const [relatedReports, setRelatedReports] = useState<{reports: PatternCard[]; total: number} | null>(null);
  const patternState = usePatternState();
  const startupError = useStartupError();
  const genie = useGenie();
  const dictation = useDictation();
  const [openingBusy, setOpeningBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const app = useApp(); const [selected, setSelected] = useState<string | null>(null); const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null); const [settings, setSettings] = useState(false); const [newDialog, setNewDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  useEffect(() => {
    setRelatedReports(null); if (!deleteTarget) return; let current = true;
    void window.stomylos.command('patternRelated', { id: deleteTarget.id }).then(result => { if (current) setRelatedReports(result); }).catch(() => undefined);
    return () => { current = false; };
  }, [deleteTarget, patternState.revision]);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [detailsSection, setDetailsSection] = useState<'memory' | 'starter' | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('voice');
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const [reviewControls, setReviewControls] = useState<HTMLDivElement | null>(null);
  const [historyOpen, setHistoryOpen] = useState(() => { try { return localStorage.getItem('library-open') === 'true'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('library-open', String(historyOpen)); } catch { /* Library visibility still works without preferences storage. */ } }, [historyOpen]);
  const library = useHistory(app);
  const bookmarks = useBookmarks(selected, (id, marked) => setView(previous => previous?.session.id === id ? { ...previous, bookmarked: marked } : previous));
  const historyFocus = useRef<{ id: string; index: number } | null>(null);
  const mark = (session: { id: string; bookmarked: boolean }, row = false) => {
    if (row && library.filter === 'bookmarked' && session.bookmarked) historyFocus.current = { id: session.id, index: library.sessions.findIndex(item => item.id === session.id) };
    act(() => bookmarks.set(session.id, !session.bookmarked));
  };
  useLayoutEffect(() => {
    const target = historyFocus.current;
    if (!target || library.loading || bookmarks.pending.has(target.id)) return;
    historyFocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest('.history-row, [role="menu"]')) return;
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('.history-more'));
    (rows[Math.min(Math.max(0, target.index), rows.length - 1)] ?? document.querySelector<HTMLButtonElement>('[data-history-filter="bookmarked"]'))?.focus({ preventScroll: true });
  }, [library.loading, library.sessions, bookmarks.pending]);
  const scroll = useConversationScroll(view?.session.id ?? null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const act = useCallback((fn: () => Promise<unknown>) => { setError(null); void fn().catch(cause => setError(errorText(cause))); }, []);
  useEffect(() => onDeleted(id => {
    forgetDraft(id);
    if (selectedRef.current === id) { selectedRef.current = null; setSelected(null); setView(null); setDetails(false); }
  }), []);
  useEffect(() => { if (app?.activity.error) setError(errorText(app.activity.error)); }, [app?.activity.error]);
  const show = useCallback(async (id: string) => { if (genieBusy()) return; if (!await beforeDictationNavigation()) return; if (selectedRef.current) await flushDraft(selectedRef.current); setLearning(false); setSelected(id); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus({ preventScroll: true })); }, []);
  const openLearning = async () => { if (genieBusy() || composing || !await beforeDictationNavigation()) return false; if (selectedRef.current) await flushDraft(selectedRef.current); await window.stomylos.command('speechStop', undefined); setHistoryOpen(true); setLearning(true); return true; };
  const backToChat = () => { setLearning(false); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus({ preventScroll: true })); };
  useEffect(() => { if (app && !selected) setSelected((app.unfinished ?? app.sessions.find(s => !isDeleted(s.id)))?.id ?? null); }, [app, selected]);
  useEffect(() => {
    if (!selected) return; let alive = true; selectDictationSession(selected); selectSpeechSession(selected);
    const refresh = () => { void loadView(selected).then(next => { if (alive) { initializeDraft(selected, next.session.draft); setView(next); } }).catch(cause => { if (alive && !isDeleted(selected)) setError(errorText(cause)); }); };
    setView(null); refresh(); const unsubscribe = onViewChanged(id => { if (id === selected) refresh(); });
    return () => { alive = false; unsubscribe(); };
  }, [selected]);
  useEffect(() => onClose(() => act(async () => { await closeGenieForApp(); if (!await beforeDictationNavigation()) return; await flushAllDrafts(); await window.stomylos.command('close', undefined); })), [act]);
  if (!app) return <div className="startup"><strong>Stomylos</strong><p>{startupError ? 'Your conversations could not be loaded.' : 'Opening your conversations…'}</p>{startupError && <button onClick={reloadSnapshot}>Try loading again</button>}</div>;
  const unfinished = app.unfinished; const partner = (view ? JSON.parse(view.session.chat_config).characters as Character[] : app.characters).find(c => c.id === view?.session.character)?.label ?? 'Partner';
  const history = library.sessions;
  const bookmarkDisabled = (id: string) => bookmarks.pending.has(id) || genie.locked || deleting || !!app.activity.storageError || app.activity.closing;
  const currentSummary = view ? { ...view.session, title: view.session.starter_text ?? view.messages.find(m => m.origin === 'learner')?.content ?? 'New chat', bookmarked: view.bookmarked, canBookmark: view.canBookmark } : null;
  const startNew = async () => { if (!await beforeDictationNavigation()) return; await flushAllDrafts(); if (unfinished) await window.stomylos.command('endSession', { sessionId: unfinished.id });
    const id = await window.stomylos.command('newSession', undefined); setNewDialog(false); library.reset(); await show(id); };
  const requestDelete = (session: SessionSummary) => { setDeleteError(null); setDeleteTarget(session); };
  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true); setDeleteError(null);
    try { await window.stomylos.command('deleteSession', { sessionId: deleteTarget.id }); setDeleteTarget(null); }
    catch (cause) { setDeleteError(errorText(cause)); }
    finally { setDeleting(false); }
  };
  const canChangeOpening = view?.session.state === 'draft' && JSON.parse(view.session.chat_config).opening?.version === 'stomylos_opening_v1';
  const openingAction = canChangeOpening && <button className="icon-button opening-action" aria-label={view?.session.opening_kind === 'starter' ? 'Start with your own topic' : 'Show a starter question'} title={view?.session.opening_kind === 'starter' ? 'Start with your own topic' : 'Show a starter question'} aria-pressed={view?.session.opening_kind === 'starter'}
    disabled={openingBusy || composing || dictation.locked || !!app.activity.storageError || app.activity.closing}
    onClick={() => act(async () => {
      if (!view || openingBusy || composing || dictationBusy()) return;
      const session = view.session; setOpeningBusy(true);
      try {
        await flushDraft(session.id);
        await window.stomylos.command('setOpening', { sessionId: session.id, operationId: crypto.randomUUID(),
          expectedRevision: session.opening_revision, kind: session.opening_kind === 'starter' ? 'user' : 'starter' });
      } finally { setOpeningBusy(false); }
    })}><Icon name="starter" /></button>;
  const starter = view?.messages.find(message => message.origin === 'starter');
  const starterAction = starter && view?.session.state === 'draft' && <button className="icon-button another-question" aria-label="Another question" title="Another question" disabled={openingBusy || composing || dictation.locked} onClick={() => {
    const args = { sessionId: view.session.id, operationId: crypto.randomUUID(), expectedQuestionId: view.session.starter_id!, expectedRevision: view.session.opening_revision };
    act(async () => { if (await beforeDictationNavigation()) { await flushDraft(args.sessionId); await window.stomylos.command('replaceStarter', args); } });
  }}><Icon name="refresh" /></button>;
  return <div className={`app ${historyOpen ? '' : 'history-collapsed'}`}><header className="app-header" inert={genie.locked}>
    <div className="app-navigation" aria-label="App navigation">
      <IconButton className="new-chat lifecycle-action" label="New chat" icon="plus" onClick={() => unfinished ? setNewDialog(true) : act(startNew)} />
      <IconButton className="history-toggle" label={historyOpen ? 'Hide history' : 'Show history'} tooltip={historyOpen ? 'Hide library' : 'Show library'} icon="sidebar" aria-expanded={historyOpen} aria-controls="conversation-sidebar" onClick={() => setHistoryOpen(open => !open)} />
      <IconButton ref={settingsTrigger} label="Settings" icon="settings" onClick={() => setSettings(true)} />
    </div>
    <div className="chat-navigation">
      <div className="header-partner">{view && <Partner view={view} characters={app.characters} act={act} blocked={app.activity.phase !== 'idle' || !!app.activity.storageError || app.activity.closing} />}</div>
      {(app.settings.simulation || app.settings.development) && <span className="build-label">{app.settings.simulation ? 'Preview' : 'Development'}</span>}
      {view?.canBookmark && <IconButton icon="bookmark" className="bookmark-toggle" label={view.bookmarked ? 'Remove bookmark' : 'Bookmark chat'} title={view.bookmarked ? 'Remove bookmark' : 'Bookmark chat'} aria-pressed={view.bookmarked} aria-busy={bookmarks.pending.has(view.session.id)} disabled={bookmarkDisabled(view.session.id)} onClick={() => mark({ id: view.session.id, bookmarked: view.bookmarked })} />}
      <Menu.Root><Menu.Trigger asChild><IconButton className="more-button" label="Chat options" icon="more" /></Menu.Trigger><Menu.Portal><Menu.Content className="partner-menu more-menu" align="end" sideOffset={8} collisionPadding={12}>
        <Menu.Item className="partner-option" disabled={!view} onSelect={() => { setDetailsSection(null); setDetails(true); }}>Conversation details</Menu.Item>
        <Menu.Separator className="menu-separator" />
        <Menu.Item className="partner-option destructive" disabled={!view || view.session.state !== 'ended' || deleting || !!app.activity.storageError} onSelect={() => currentSummary && requestDelete(currentSummary)}>Delete chat</Menu.Item>
      </Menu.Content></Menu.Portal></Menu.Root>
      {view && view.session.state !== 'ended' && <IconButton className="end-chat lifecycle-action" label="End chat" icon="exit" onClick={() => act(async () => { if (!await beforeDictationNavigation()) return; await flushDraft(view.session.id); await window.stomylos.command('endSession', { sessionId: view.session.id }); })} />}
    </div>
  </header><aside id="conversation-sidebar" hidden={!historyOpen} inert={!!genie.opening || !!genie.episode?.open}>
    <div className="library-tabs"><IconButton icon="chat" label="Chats" aria-pressed={!learning} onClick={backToChat} />
      <IconButton icon="book" className="learning-nav" label="Reports" tooltip={patternState.phase !== 'idle' ? 'Reports · Creating…' : patternState.reportId && !patternState.error ? 'Reports · Ready' : 'Reports'} aria-pressed={learning} onClick={() => act(openLearning)}>{(patternState.phase !== 'idle' || patternState.reportId) && <span className="report-indicator" aria-label={patternState.phase !== 'idle' ? 'Creating report' : patternState.error ? 'Report needs attention' : 'Report ready'} />}</IconButton>
</div>
    {!learning && <div className="history-filters" role="group" aria-label="Filter conversation history">{(['all', 'bookmarked'] as const).map(filter => <button key={filter} data-history-filter={filter} aria-pressed={library.filter === filter} onClick={() => library.choose(filter)}>{filter === 'all' ? 'All' : 'Bookmarked'}</button>)}</div>}
    {!learning && library.failed && <div className="history-notice" role="alert">History could not be loaded. <button onClick={library.retry}>Try loading again</button></div>}
    {!learning && library.loading && <div className="history-notice" role="status">Loading conversations…</div>}
    {!learning && !library.loading && !library.failed && !history.length && library.filter === 'bookmarked' && <div className="history-notice">No bookmarked chats yet.</div>}
    <nav aria-label="Conversation history" aria-busy={library.loading} hidden={learning}>{history.filter(session => !isDeleted(session.id)).map(session => <div className="history-row" key={session.id}><button title={session.title} aria-current={!learning && session.id === selected ? 'page' : undefined} className={`history-item ${!learning && session.id === selected ? 'selected' : ''}`} onClick={() => act(() => show(session.id))}>
      <strong>{session.bookmarked && <Icon name="bookmark" className="history-bookmark" />}<span>{session.title}</span></strong><div className="history-meta"><small>{session.state === 'ended' ? ({ completed: 'Ended', skipped: 'No messages', pending: 'Analysis pending', failed: 'Analysis failed', none: 'Ended', running: 'Analyzing' }[session.analysis_state] ?? labels[session.analysis_state]) : session.state === 'draft' ? 'New chat' : 'In progress'}</small>
      <time>{new Date(session.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></div>
    </button><Menu.Root><Menu.Trigger className="history-more" disabled={library.loading} aria-label={`Options for ${session.title}`} title="Chat options"><Icon name="more" /></Menu.Trigger><Menu.Portal><Menu.Content className="partner-menu more-menu" sideOffset={4}>
      <Menu.Item className="partner-option" disabled={!session.canBookmark || bookmarkDisabled(session.id)} onSelect={() => mark(session, true)}>{session.bookmarked ? 'Remove bookmark' : 'Bookmark chat'}</Menu.Item>
      {!session.canBookmark && <div className="menu-hint">Send a message before bookmarking.</div>}
      <Menu.Separator className="menu-separator" />
      <Menu.Item className="partner-option destructive" disabled={session.state !== 'ended' || deleting || !!app.activity.storageError} onSelect={() => requestDelete(session)}>Delete chat</Menu.Item>
      {session.state !== 'ended' && <div className="menu-hint">End this chat before deleting it.</div>}
    </Menu.Content></Menu.Portal></Menu.Root></div>)}</nav>
    {!learning && (library.offset > 0 || library.hasMore) && <div className="history-pages"><button disabled={!library.offset || library.loading} onClick={() => library.move(library.offset - 40)}>Newer</button><button disabled={!library.hasMore || library.loading} onClick={() => library.move(library.offset + 40)}>Older</button></div>}
    <Learning requestedReport={requestedReport} handledReport={handledReport} active={learning && historyOpen} revision={app.revision} state={patternState} disabled={!!app.activity.storageError || app.activity.closing} keyPresent={app.settings.keyPresent} back={backToChat} source={show} />
  </aside><div className="workspace">

    <span className="bookmark-announcement" role="status" aria-live="polite">{bookmarks.announcement}</span>
    {bookmarks.undo && <BookmarkUndo key={bookmarks.undo.serial} undo={bookmarks.undo} disabled={bookmarkDisabled(bookmarks.undo.sessionId)} restore={() => act(() => bookmarks.set(bookmarks.undo!.sessionId, true))} dismiss={bookmarks.dismiss} />}
    {error && <div className="notice" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError(null)} aria-label="Dismiss message" title="Dismiss"><Icon name="close" /></button></div>}
    {app.activity.storageError && <div className="notice danger" role="alert"><span>{app.activity.storageError.startsWith('database_worker_') ? 'Storage stopped. Copy any unsaved text before restarting the app. Saved history will recover on restart.' : 'Your latest changes could not be saved. Keep this window open.'}</span>{!app.activity.storageError.startsWith('database_worker_') && <button onClick={() => act(() => window.stomylos.command('retrySaving', undefined))}>Retry saving</button>}</div>}
    {app.activity.deletionCleanupPending && <div className="notice danger" role="alert"><span>The chat was deleted, but some voice files still need cleanup.</span><button onClick={() => act(() => window.stomylos.command('retryDeletionCleanup', undefined))}>Retry cleanup</button></div>}
    {view && maintenanceNotices(view).length > 0 && <div className="maintenance-summary" role="status">
      <span>{maintenanceNotices(view).map(notice => notice.text).join(' · ')}</span>
      <button onClick={() => { setDetailsSection(maintenanceNotices(view)[0].section); setDetails(true); }}>Review updates</button>
    </div>}
    <main inert={genie.locked} ref={scroll.scroller} tabIndex={0} aria-label="Conversation">
      <div className="page" ref={scroll.content}>{view ? <>
        <div className="transcript">{view.messages.filter(message => !(canChangeOpening && message.origin === 'starter')).map(message => <Bubble key={message.id} message={message} metadata={view.requests.find(r => r.id === message.request_id) ? JSON.parse(view.requests.find(r => r.id === message.request_id)!.metadata) : undefined} partner="Partner" />)}</div>

        {app.activity.sessionId === view.session.id && app.activity.phase === 'routing' && <p className="note" role="status">Choosing your conversation partner…</p>}
        {app.activity.sessionId === view.session.id && app.activity.phase === 'preparing' && <p className="note" role="status">Preparing your reply…</p>}
        {view.session.state === 'ended' && <>
          <div className="ended-marker">{labels[view.session.analysis_state]}{view.session.draft && <button className="icon-button retained-draft-link" aria-label="View unsent draft" title="View unsent draft" onClick={() => setDetails(true)}><Icon name="info" /></button>}</div>
          {['failed', 'pending'].includes(view.session.analysis_state) && <button className="analysis-retry" onClick={() => act(() => window.stomylos.command('retryAnalysis', { sessionId: view.session.id }))}>Try analysis again</button>}
          <Feedback key={view.session.id} view={view} controls={reviewControls} onReveal={scroll.pause} />
        </>}
      </> : <p className="note">{selected ? 'Loading conversation…' : 'No conversation selected. Start a new chat when you are ready.'}</p>}</div>
    </main>
    {scroll.away && !genie.locked && <div className="latest-position"><button className="latest-message" aria-label="Go to latest message" title="Go to latest message" onClick={() => {
      scroll.resume();
      const target = document.querySelector<HTMLTextAreaElement>('.composer textarea') ?? scroll.scroller.current;
      target?.focus({ preventScroll: true });
    }}><Icon name="down" /><span aria-live="polite">{scroll.unread ? 'New reply' : 'Latest message'}</span></button></div>}
    <div className="conversation-footer">{view && view.session.state !== 'ended' ? <Composer key={view.session.id} view={view} app={app} act={act} blocked={openingBusy} onComposition={setComposing} afterAcceptedAction={scroll.afterAcceptedAction} openingAction={<>{openingAction}{starterAction}</>} starter={canChangeOpening && starter && <Bubble message={starter} partner="Partner" />} /> : <footer className="ended-footer">
      <div ref={setReviewControls} className="review-controls" />
      <>{unfinished && <IconButton label="Return to current chat" icon="back" onClick={() => act(() => show(unfinished.id))} />}</></footer>}</div>
  </div>
  <ExplainDialog sessionId={view?.session.id ?? null} />
  <DictationNavigationDialog />
  <Modal open={!!deleteTarget} onOpenChange={open => { if (!open && !deleting) setDeleteTarget(null); }} title="Delete this chat?">
    <p className="delete-title">{deleteTarget?.title}</p><p className="note">{deleteTarget && new Date(deleteTarget.created_at).toLocaleString()}</p>
    <p className="note">This removes the conversation, its bookmark, unsent draft, grammar analysis, request records and associated voice files from this computer. This cannot be undone.</p>
    <p className="note">Shared memory already learned from this chat, shared starter questions and information saved in other chats will remain. Saved learning reports may still contain excerpts; remove those separately in Reports. Existing backups and provider records are not changed.</p>
    {!!relatedReports?.total && <details><summary>{relatedReports.total} learning reports contain excerpts</summary>
      {relatedReports.reports.map(r => <p key={r.id}><button className="quiet" disabled={deleting} onClick={() => act(async () => { if (await openLearning()) { setDeleteTarget(null); setRequestedReport(r.id); } })}>View report · {new Date(r.created_at).toLocaleDateString()} · {r.scope.count} conversations</button></p>)}
      {relatedReports.total > relatedReports.reports.length && <p className="note">Showing the 20 most recent. All saved reports are available in Reports.</p>}</details>}
    {deleteError && <p className="destructive" role="alert">{deleteError}</p>}
    {app.activity.storageError && <p className="destructive" role="alert">Deletion is waiting for storage. <button onClick={() => { void window.stomylos.command('retrySaving', undefined).catch(cause => setDeleteError(errorText(cause))); }}>Retry saving</button></p>}
    <div className="dialog-actions"><button disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</button><button className="delete-confirm" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? 'Deleting…' : 'Delete chat'}</button></div>
  </Modal>
  <Modal open={details} onOpenChange={setDetails} title="Conversation details">{view && <>
    <MemoryDetails view={view} act={act} initialOpen={detailsSection === 'memory'} openShared={() => { setDetails(false); setSettingsTab('memory'); setSettings(true); }} show={async id => { setDetails(false); await show(id); }} />
    <RequestDetails view={view} onToggle={() => undefined} />
    <Renewal initialOpen={detailsSection === 'starter'} view={view} onToggle={() => undefined} act={act} />
    {view.session.state === 'ended' && view.session.draft && <Disclosure title="Unsent draft"><p className="retained-text">{view.session.draft}</p></Disclosure>}
    {view.session.state === 'ended' && <DictationPanel sessionId={view.session.id} disabled />}
  </>}</Modal>
  <SettingsDialog beforeBackup={async () => { if (app.activity.storageError) throw new Error('save_required'); if (composing || dictationBusy()) throw new Error('backup_busy'); await flushAllDrafts(); }} open={settings} onOpenChange={setSettings} tab={settingsTab} onTabChange={setSettingsTab} settings={app.settings} errorText={errorText} returnFocus={() => settingsTrigger.current?.focus({ preventScroll: true })} />
  <Modal open={newDialog} onOpenChange={setNewDialog} title="Start a new chat?"><p className="note">Your current chat is still open. End it to save the conversation and start a fresh one. Any unsent draft will be kept separately.</p>
    <div className="dialog-actions"><button onClick={() => { setNewDialog(false); if (unfinished) act(() => show(unfinished.id)); }}>Keep current chat</button><button className="primary" onClick={() => act(startNew)}>End and start new</button></div>
  </Modal></div>;
}
createRoot(document.getElementById('root')!).render(<App />);
