import { endRetryDelay, waitEndRetry } from './end-retry';
import { cleanupBody } from './memory-cleanup';
import { ExplainController } from './explain-controller';
import { partnerRouterBody } from './partner-router';
import { PatternReportController } from './pattern-report-controller';
import type { PatternCommandArgs } from '../shared/pattern-report';
import { GenieController } from './genie-controller';
import type { GenieSource } from '../shared/genie';
import type { SpeechController } from './tts';
import type { DictationController } from './asr';
import type { Activity, AppEvent, AppSnapshot, CommandArgs, CommandResults, RequestRecord, SessionSummary, SessionPage, Settings, RenewalAttempt, Json } from '../shared/types';
import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from './db-client';
import type { Store, StoreMethod } from './database';
import type { Gateway } from './transport';
import { CompletionFailure } from './transport';
import { routeSearch } from './search-router';
import { parseStarterQuestions, starterBody } from './starter-renewal';
import { applyMemory, memoryBody } from './memory-updater';
import { AppFailure, failureCode } from './errors';
import type { Credentials } from './credentials';
import { characters, conversationBody, conversationRequestSnapshot, grammarBody, isLearner, routerBody, routerScores, routerSnapshot, validateGrammar, hash } from './contracts';

type PendingSave = { attempt: () => Promise<unknown>; resolve: (value: any) => void };
export class Coordinator {
  readonly genie: GenieController;
  readonly explain: ExplainController;
  readonly patterns: PatternReportController;
  patternViewer: { open(id: string, html: string, createdAt: string): Promise<void>; close(id?: string): void } | null = null;
  speech?: SpeechController;
  dictation?: DictationController;
  private revision = 0;
  private control: Promise<unknown> = Promise.resolve();
  private saveTail: Promise<unknown> = Promise.resolve();
  private pendingSave: PendingSave | null = null;
  private retryingSave = false;
  private cachedPage: SessionPage = { sessions: [], hasMore: false, offset: 0, filter: 'all' };
  private cachedUnfinished: SessionSummary | null = null;
  private drafts = new Map<string, { revision: number; text: string }>();
  private interactive: { abort: AbortController; promise: Promise<void> } | null = null;
  private grammarQueue: RequestRecord[] = [];
  private grammar: { sessionId: string; abort: AbortController; promise: Promise<void> } | null = null;
  private renewalQueue: { attempt: RenewalAttempt; sessionId: string }[] = [];
  private renewal: { id: string; sessionId: string; abort: AbortController; promise: Promise<void> } | null = null;
  private scheduledRenewals = new Set<string>();
  private memoryAuthorized = new Set<string>();
  private memoryWake = 0;
  private deleting = new Set<string>();
  private memory: { sessionId: string | null; abort: AbortController; promise: Promise<void> } | null = null;
  private activity: Activity = { sessionId: null, requestId: null, phase: 'idle', streamingMessageId: null, streamingText: '', storageError: null, error: null, closing: false };
  constructor(private db: DatabaseClient, private gateway: Gateway, private settings: Settings,
    private emit: (event: AppEvent) => void, private refresh: () => boolean,
    private credentials?: Pick<Credentials, 'manage' | 'snapshot' | 'currentKey'>) {
    this.patterns = new PatternReportController(db, gateway, {
      write: (method, ...args) => this.write(method, ...args),
      publish: snapshot => this.emit({ type: 'pattern', snapshot }),
      open: async (id, html, at) => { if (!this.patternViewer) throw new AppFailure('pattern_viewer_unavailable'); await this.patternViewer.open(id, html, at); },
      closeViewer: id => this.patternViewer?.close(id),
      retrySave: () => this.command('retrySaving', undefined)
    });
    this.explain = new ExplainController(db, gateway, record => this.emit({ type: 'explain', record }), () => this.settings.keyPresent);
    this.genie = new GenieController(gateway, {
      source: (id, text, revision) => this.genieSource(id, text, revision),
      save: (source, text, revision) => this.saveGenieDraft(source, text, revision),
      emit: snapshot => this.emit({ type: 'genie', snapshot })
    });
  }
  private async genieSource(id: string, text: string, revision: number): Promise<GenieSource> {
    if (this.activity.storageError || this.activity.closing) throw new AppFailure('save_required');
    if (!this.settings.keyPresent) throw new AppFailure('api_key_missing');
    if (this.interactive) throw new AppFailure('reply_in_progress');
    if (this.dictation?.locked || this.dictation?.needsSave) throw new AppFailure('asr_busy');
    const view = await this.db.call('view', id), last = view.messages.at(-1), known = this.drafts.get(id);
    if (view.session.state === 'ended' || last?.role === 'user' || last?.delivery === 'interrupted' || view.messages.filter(isLearner).length >= 24) throw new AppFailure('genie_session_unavailable');
    if (!known || known.revision !== revision || known.text !== text || view.session.draft !== text) throw new AppFailure('genie_stale');
    return { sessionId: id, text, revision,
      contextHash: hash(JSON.stringify([view.session.opening_kind, view.session.opening_revision, view.messages])),
      messages: view.messages.map(({ role, content }) => ({ role, content })) };
  }
  private async saveGenieDraft(source: GenieSource, text: string, revision: number) {
    const current = await this.genieSource(source.sessionId, source.text, source.revision);
    if (current.contextHash !== source.contextHash || revision <= source.revision) throw new AppFailure('genie_stale');
    const ids = this.dictation?.snapshot().records.filter(r => r.sessionId === source.sessionId && r.inserted && !r.submitted && !r.discarded && r.draftBinding?.textHash === hash(source.text)).map(r => r.id) ?? [];
    await this.write('saveDraft', source.sessionId, text);
    this.drafts.set(source.sessionId, { revision, text });
    // Voice linkage has its own visible save-only recovery; the text is already durable.
    await this.dictation?.bindDraft(source.sessionId, ids, revision, text).catch(() => undefined);
    await this.publish(source.sessionId);
  }
  private cachedEndBlockers: { sessionId: string; title: string }[] = [];
  async initialize() { await this.db.ready; if (!(await this.db.call('endBlocker'))) await this.db.call('createSession'); }
  async snapshot(): Promise<AppSnapshot> {
    const revision = this.revision; const activity = { ...this.activity }; const settings = { ...this.settings };
    let page = this.cachedPage; let unfinished = this.cachedUnfinished;
    try {
      [page, unfinished, this.cachedEndBlockers] = await Promise.all([this.db.call('sessionPage'), this.db.call('unfinished'), this.db.call('endBlockers')]);
      this.cachedPage = page; this.cachedUnfinished = unfinished;
    } catch (error) { if (!this.activity.storageError) throw error; }
    return { endBlocker: this.cachedEndBlockers[0]?.sessionId ?? null, endBlockers: this.cachedEndBlockers, revision, sessions: page.sessions, historyHasMore: page.hasMore, unfinished, activity, settings, characters };
  }
  databaseFailed() { this.patterns.databaseFailed(); this.speech?.stop(); this.emit({ type: 'dictation-interrupt' }); this.activity.storageError = 'database_worker_stopped'; this.backupReject?.(new AppFailure('save_required')); void this.publish().catch(() => undefined); }
  private async publish(id?: string) {
    this.revision++;
    if (id) this.emit({ type: 'session-changed', sessionId: id, revision: this.revision });
    this.emit({ type: 'snapshot', snapshot: await this.snapshot() });
  }
  private write<K extends StoreMethod>(method: K, ...args: Parameters<Store[K]>): Promise<ReturnType<Store[K]>> {
    const operation = async () => {
      const attempt = () => this.db.call(method, ...args);
      try { return await attempt(); }
      catch (error) {
        const code = failureCode(error);
        if (!['operation_failed', 'database_worker_failed', 'database_worker_stopped'].includes(code)) throw error;
        this.activity.storageError = code; this.backupReject?.(new AppFailure('save_required'));
        return new Promise<ReturnType<Store[K]>>(resolve => {
          this.pendingSave = { attempt, resolve }; void this.publish().catch(() => undefined);
        });
      }
    };
    const promise = this.saveTail.then(operation); this.saveTail = promise.catch(() => undefined); return promise;
  }
  private backupLocked = false;
  private backupReject?: (error: Error) => void;
  private commandsInFlight = new Set<Promise<unknown>>();
  private assertBackupIdle() {
    if (this.activity.storageError || this.pendingSave || this.dictation?.needsSave) throw new AppFailure('save_required');
    if (this.activity.closing || this.interactive || this.grammar || this.renewal || this.memory ||
        this.grammarQueue.length || this.renewalQueue.length || this.deleting.size || this.genie.locked ||
        this.explain.backupBusy || this.patterns.backupBusy ||
        this.speech?.backupBusy || this.dictation?.locked) throw new AppFailure('backup_busy');
  }
  async withBackup<T>(operation: () => Promise<T>): Promise<T> {
    if (this.backupLocked) throw new AppFailure('backup_busy');
    this.assertBackupIdle(); this.backupLocked = true;
    let active = true;
    const failed = new Promise<never>((_, reject) => { this.backupReject = reject; });
    try {
      await Promise.race([failed, (async () => {
        await Promise.all([...this.commandsInFlight]);
        if (!active) return;
        this.assertBackupIdle(); await this.saveTail;
        if (!active) return;
        await this.speech?.pauseOpening(); await this.speech?.settleBackup();
        this.assertBackupIdle();
      })()]);
      this.backupReject = undefined;
      this.speech?.stop();
      return await operation();
    } finally {
      active = false; this.backupReject = undefined;
      this.speech?.resumeOpening(); this.backupLocked = false;
      if (this.grammarQueue.length) this.pump();
      if (this.renewalQueue.length) this.pumpRenewal();
      if (this.memoryAuthorized.size) this.pumpMemory();
    }
  }
  async closeForRestore() { return this.close(); }
  async command<K extends keyof CommandArgs>(name: K, args: CommandArgs[K]): Promise<CommandResults[K]> {
    if (this.backupLocked) throw new AppFailure('backup_busy');
    const pending = this.runCommand(name, args); this.commandsInFlight.add(pending);
    try { return await pending; } finally { this.commandsInFlight.delete(pending); }
  }
  private async runCommand<K extends keyof CommandArgs>(name: K, args: CommandArgs[K]): Promise<CommandResults[K]> {
    if (name === 'genieSnapshot') return this.genie.snapshot() as CommandResults[K];
    if (name === 'genieDraft') { const a = args as CommandArgs['genieDraft']; this.genie.updateDraft(a.episodeId, a.text, a.revision); return undefined as CommandResults[K]; }
    if (name === 'genieClose' || name === 'genieCancel') { await this.genie.cancel((args as CommandArgs['genieClose']).episodeId, name === 'genieClose'); return undefined as CommandResults[K]; }
    if (['patternRelated', 'patternPreview', 'patternState', 'patternList', 'patternDetail', 'patternRetrySave', 'patternClose'].includes(name)) return this.patterns.command(name as keyof PatternCommandArgs, args as never) as Promise<CommandResults[K]>;
    if (name === 'currentMemory') return this.db.call('currentMemory') as Promise<CommandResults[K]>;
    if (name === 'snapshot') return this.snapshot() as Promise<CommandResults[K]>;
    if (name === 'listSessions') return this.db.call('sessionPage', (args as CommandArgs['listSessions']).offset, (args as CommandArgs['listSessions']).filter) as Promise<CommandResults[K]>;
    if (args && 'sessionId' in args && this.deleting.has(args.sessionId)) throw new AppFailure('session_deleting');
    if (name === 'loadSession') {
      const view = await this.db.call('view', (args as CommandArgs['loadSession']).sessionId);
      await this.speech?.load(view.messages); return view as CommandResults[K];
    }
    if (name.startsWith('asr') && !['asrBegin', 'asrInserted', 'asrTranscribe'].includes(name)) {
      const asr = this.dictation, a = args as any;
      if (!asr) throw new AppFailure('asr_unavailable');
      if (name === 'asrContext') { await this.db.call('session', a.sessionId); await asr.context(a.sessionId); }
      if (name === 'asrSnapshot') return asr.snapshot() as CommandResults[K];
      if (name === 'asrChunk') return await asr.push(a.id, a.sequence, a.pcm) as CommandResults[K];
      if (name === 'asrFinish') await asr.finish(a.id, a.reason);
      if (name === 'asrCancel') await asr.cancel(a.id, a.discard);
      if (name === 'asrRetrySave') await asr.retrySave(a.id);
      return undefined as CommandResults[K];
    }
    if (name.startsWith('speech')) {
      if (!this.speech) throw new AppFailure('speech_unavailable');
      const a = args as any;
      if (this.genie.locked && ['speechListen', 'speechPreview'].includes(name)) throw new AppFailure('genie_busy');
      if (name === 'speechSnapshot') return this.speech.snapshot() as Promise<CommandResults[K]>;
      if (name === 'speechVoice') await this.speech.setVoice(a.voice);
      if (name === 'speechPreview') await this.speech.preview(a.token, a.retry);
      if (name === 'speechPreviewStop') this.speech.stopPreview();
      if (name === 'speechRecover') await this.speech.recover(a.assetKey, a.attemptId);
      if (name === 'speechStop') this.speech.stop();
      if (name === 'speechMode') await this.speech.setMode(a.mode);
      if (name === 'speechContext') { await this.db.call('session', a.sessionId); this.speech.context(a.sessionId, a.token); }
      if (name === 'speechListen') await this.speech.listen(a.sessionId, a.messageId, a.token, a.retry, false, a.assetKey, a.attemptId);
      if (name === 'speechRetrySave') await this.speech.retrySave(a.sessionId, a.messageId);
      if (name === 'speechClear') await this.speech.clear();
      return undefined as CommandResults[K];
    }
    if (name === 'retrySaving') {
      if (this.retryingSave) throw new AppFailure('save_retry_in_progress');
      const pending = this.pendingSave;
      if (pending) {
        this.retryingSave = true;
        try { const value = await pending.attempt(); this.pendingSave = null; this.activity.storageError = null; pending.resolve(value); await this.publish(); }
        catch { throw new AppFailure('save_still_unavailable'); }
        finally { this.retryingSave = false; }
      }
      return undefined as CommandResults[K];
    }
    const job = this.control.then(async () => {
      if (name === 'explainClose') { this.explain.closeDialog(); return undefined as CommandResults[K]; }
      if (this.activity.storageError) throw new AppFailure('save_required');
      if (this.activity.closing) throw new AppFailure('closing');
      const value = await this.execute(name, args); return value as CommandResults[K];
    });
    this.control = job.catch(() => undefined); return job;
  }
  private async execute(name: keyof CommandArgs, args: any): Promise<unknown> {
    if (name.startsWith('pattern')) {
      if (['patternCreate', 'patternRetry'].includes(name) && !this.settings.keyPresent) throw new AppFailure('api_key_missing');
      return this.patterns.command(name as keyof PatternCommandArgs, args);
    }
    if (name.startsWith('explain')) {
      if (name === 'explainList') return this.explain.list(args.sessionId);
      if (this.genie.locked) throw new AppFailure('genie_busy');
      if (name === 'explainOpen') return this.explain.open(args);
      if (name === 'explainHistory') return this.explain.history(args.sessionId, args.messageId);
      return this.explain.retry(args.id);
    }
    if (name === 'genieOpen' && this.explain.visible) throw new AppFailure('explain_busy');
    const id = args?.sessionId as string;
    if (this.genie.locked && ['sendMessage', 'endSession', 'newSession', 'replaceStarter', 'setOpening', 'selectPartner', 'changePartner', 'useSelectedPartner', 'retryPartnerSelection', 'retryReply', 'asrBegin', 'asrTranscribe', 'asrInserted'].includes(name)) throw new AppFailure('genie_busy');
    if (this.genie.locked && name === 'saveDraft') {
      const known = this.drafts.get(id);
      if (!known || known.revision !== args.revision || known.text !== args.text) throw new AppFailure('genie_busy');
    }
    if (this.dictation?.locked && ['saveDraft', 'sendMessage', 'endSession', 'newSession', 'replaceStarter', 'setOpening', 'changePartner', 'useSelectedPartner', 'retryPartnerSelection', 'retryReply', 'close'].includes(name)) throw new AppFailure('asr_busy');
    if (['sendMessage', 'endSession', 'newSession', 'replaceStarter', 'useSelectedPartner', 'retryPartnerSelection', 'retryReply', 'close'].includes(name)) this.speech?.stop();
    switch (name) {
      case 'genieOpen': this.speech?.stop(); return this.genie.open(args);
      case 'genieSubmit': return this.genie.submit(args);
      case 'genieRetry': return this.genie.retry(args.episodeId, args.operationId);
      case 'genieTarget': return this.genie.target(args.episodeId, args.range, args.operationId);
      case 'genieApply': return this.genie.apply(args);
      case 'genieUndo': return this.genie.undo(args);
      case 'asrTranscribe': {
        if (!this.dictation) throw new AppFailure('asr_unavailable');
        const record = this.dictation.snapshot().records.find(r => r.id === args.id);
        if (!record) throw new AppFailure('asr_record_missing');
        await this.dictationEligible(record.sessionId);
        await this.dictation.transcribe(args.id); return;
      }
      case 'asrBegin': {
        if (!this.dictation) throw new AppFailure('asr_unavailable');
        await this.dictationEligible(id);
        const known = this.drafts.get(id);
        if (known && (args.revision < known.revision || args.revision === known.revision && args.text !== known.text)) throw new AppFailure('draft_changed');
        await this.write('saveDraft', id, args.text);
        this.drafts.set(id, { revision: args.revision, text: args.text });
        await this.dictation.begin(args.id, id, args.revision, args.text); return;
      }
      case 'asrInserted': {
        if (!this.dictation || this.dictation.locked) throw new AppFailure('asr_busy');
        const known = this.drafts.get(id);
        if (!known || known.revision !== args.revision || known.text !== args.text) throw new AppFailure('draft_changed');
        await this.dictation.inserted(args.id, id, args.revision, args.text); return;
      }
      case 'saveDraft': {
        await this.db.call('session', id);
        const known = this.drafts.get(id);
        if (!known || args.revision > known.revision) {
          this.genie.invalidateDraft(id, args.revision, args.text);
          this.drafts.set(id, { revision: args.revision, text: args.text }); await this.write('saveDraft', id, args.text);
        }
        if (this.drafts.get(id)?.revision === args.revision && this.drafts.get(id)?.text === args.text)
          await this.dictation?.bindDraft(id, args.dictationIds ?? [], args.revision, args.text);
        return { revision: args.revision };
      }
      case 'setOpening': {
        await this.speech?.pauseOpening();
        try { const result = await this.write('setOpening', id, args.operationId, args.expectedRevision, args.kind); await this.publish(id); return result; }
        finally { this.speech?.resumeOpening(); }
      }
      case 'replaceStarter': await this.write('replaceQuestion', id, args.operationId, args.expectedQuestionId, args.expectedRevision); await this.publish(id); return;
      case 'changePartner':
        if (this.interactive) throw new AppFailure('reply_in_progress');
        await this.write('changePartner', id, args.character, args.operationId, args.expectedRevision); await this.publish(id); return;
      case 'useSelectedPartner':
      case 'retryPartnerSelection': {
        if (this.interactive) throw new AppFailure('reply_in_progress');
        if (!this.settings.keyPresent) throw new AppFailure('api_key_missing');
        const view = await this.db.call('view', id);
        if (view.session.state !== 'active' || (name === 'useSelectedPartner' ? !view.partner.canUseSelected : view.partner.pending?.state !== 'failed')) throw new AppFailure('partner_not_retryable');
        this.startReply(id, name === 'useSelectedPartner' ? 'different_model' : 'retry_selection'); await this.publish(id); return;
      }
      case 'selectPartner': await this.write('selectManual', id, args.character); await this.publish(id); return;
      case 'searchMode':
        if (this.interactive) throw new AppFailure('reply_in_progress');
        if (this.genie.locked || this.dictation?.locked) throw new AppFailure('search_mode_locked');
        await this.write('searchMode', id, args.mode); await this.publish(id); return;
      case 'refreshKey':
        this.settings.keyPresent = false;
        try { this.settings.keyPresent = this.refresh(); } finally {
          if (this.credentials) this.settings.credentials = this.credentials.snapshot();
          await this.publish();
        }
        return;
      case 'manageKey':
        if (!this.credentials) throw new AppFailure('credential_management_disabled');
        try { this.credentials.manage(args); } finally {
          this.settings.keyPresent = !!this.credentials.currentKey();
          this.settings.credentials = this.credentials.snapshot();
          await this.publish();
        }
        return;
      case 'newSession': { const session = await this.write('createSession'); await this.publish(session.id); return session.id; }
      case 'sendMessage': {
        await this.genie.dispose(id);
        if ((this.drafts.get(id)?.revision ?? -1) > args.revision) throw new AppFailure('draft_changed');
        if (args.text === '/end') { this.drafts.set(id, { revision: args.revision, text: '' }); await this.write('saveDraft', id, ''); await this.end(id); return; }
        if (this.interactive) throw new AppFailure('reply_in_progress');
        if (!this.settings.keyPresent) throw new AppFailure('api_key_missing');
        const message = await this.write('submit', id, args.text, randomUUID());
        await this.dictation?.submitted(id, args.dictationIds ?? [], message.id, message.content);
        if ((this.drafts.get(id)?.revision ?? -1) <= args.revision) this.drafts.set(id, { revision: args.revision, text: '' });
        this.startReply(id); await this.publish(id); return;
      }
      case 'retryReply': {
        if (this.interactive) throw new AppFailure('reply_in_progress');
        if (!this.settings.keyPresent) throw new AppFailure('api_key_missing');
        const view = await this.db.call('view', id); const last = view.messages.at(-1);
        if (view.session.state !== 'active' || !(last?.role === 'user' || last?.delivery === 'interrupted')) throw new AppFailure('reply_not_retryable');
        if (!view.partner.canRetryReply) throw new AppFailure('partner_selection_pending');
        this.startReply(id, 'retry'); return;
      }
      case 'setSessionBookmark': {
        if (this.genie.locked) throw new AppFailure('genie_busy');
        if (this.deleting.has(id)) throw new AppFailure('session_deleting');
        const bookmarked = await this.write('setSessionBookmark', id, args.bookmarked);
        await this.publish(id); return { sessionId: id, bookmarked, revision: this.revision };
      }
      case 'deleteSession': await this.deleteSession(id); return;
      case 'retryDeletionCleanup': await this.cleanupDeletions(); await this.publish(); return;
      case 'endSession': await this.end(id); return;
      case 'retryAnalysis': {
        await this.write('suppressAutomaticRetry', id, 'grammar');
        if (!this.settings.keyPresent) throw new AppFailure('api_key_missing');
        await this.enqueue(id); return;
      }
      case 'retryIntentionQuestions': throw new AppFailure('feature_removed');
      case 'retryStarterRenewal': {
        await this.write('suppressAutomaticRetry', id, 'starter');
        if (!this.settings.keyPresent) throw new AppFailure('api_key_missing');
        if (!(await this.db.call('starterJob', id))) return;
        await this.enqueueRenewal(id, true); return;
      }
      case 'retryMemory': {
        await this.write('suppressAutomaticRetry', id, (await this.db.call('memoryCandidate', id)) ? 'cleanup' : 'update');
        if (!this.settings.keyPresent) throw new AppFailure('api_key_missing');
        await this.write('retryMemory', id); this.enqueueMemory(id); await this.publish(id); return;
      }
      case 'continueEnd': {
        await this.db.call('assertEndActive', id);
        for (const stage of ['grammar','starter','update']) {
          try { await this.write('resumeEndResponse', id, stage); }
          catch (error) { this.activity.error = failureCode(error); }
        }
        const candidate = await this.db.call('memoryCandidate', id);
        if (candidate?.state === 'received') {
          const received = (await this.db.call('cleanupAttempts', id)).findLast(a => a.status === 'received');
          if (received) {
            try { await this.write('acceptCleanup', received.id); }
            catch (error) { await this.write('failCleanup', received.id, failureCode(error)); this.activity.error = failureCode(error); }
          }
        }
        const view = await this.db.call('view', id);
        if (!this.settings.keyPresent) {
          await this.publish(id);
          if (!view.endProcessing?.complete) throw new AppFailure('api_key_missing');
          return;
        }
        if (['pending','failed'].includes(view.session.analysis_state)) {
          await this.write('suppressAutomaticRetry', id, 'grammar'); await this.enqueue(id);
        }
        if (view.renewal && ['pending','failed','interrupted'].includes(view.renewal.state)) {
          await this.write('suppressAutomaticRetry', id, 'starter'); await this.enqueueRenewal(id, true);
        }
        if (view.memory.job && ['pending','failed','interrupted'].includes(view.memory.job.state)) {
          await this.write('suppressAutomaticRetry', id, (await this.db.call('memoryCandidate', id)) ? 'cleanup' : 'update');
          await this.write('retryMemory', id); this.enqueueMemory(id);
        }
        await this.publish(id); return;
      }
      case 'skipMemory':
      case 'cancelEnd': {
        await this.write('cancelEnd', id);
        this.memoryAuthorized.delete(id); this.memoryWake++;
        for (const job of [this.grammar, this.renewal, this.memory]) if (job?.sessionId === id) job.abort.abort();
        await this.publish(id); return;
      }
      case 'close':
        if (this.dictation?.needsSave) throw new AppFailure('asr_save_required');
        return this.close();
    }
    throw new AppFailure('invalid_command');
  }
  private async dictationEligible(id: string) {
    if (this.activity.storageError || this.activity.closing) throw new AppFailure('save_required');
    if (!this.settings.keyPresent) throw new AppFailure('api_key_missing');
    if (this.interactive) throw new AppFailure('reply_in_progress');
    const view = await this.db.call('view', id), last = view.messages.at(-1);
    if (view.session.state === 'ended' || last?.role === 'user' || last?.delivery === 'interrupted') throw new AppFailure('asr_session_unavailable');
  }
  private startReply(id: string, kind: 'send' | 'retry' | 'different_model' | 'retry_selection' = 'send') {
    this.activity = { ...this.activity, sessionId: id, requestId: null, phase: 'preparing', error: null, streamingMessageId: null, streamingText: '' };
    const abort = new AbortController();
    const promise = this.reply(id, abort.signal, kind).catch(error => { this.activity.error = failureCode(error); }).finally(async () => {
      this.activity.phase = 'idle'; this.activity.requestId = null; this.interactive = null; await this.publish(id).catch(() => undefined);
    });
    this.interactive = { abort, promise };
  }
  private async reply(id: string, signal: AbortSignal, kind: 'send' | 'retry' | 'different_model' | 'retry_selection') {
    let view = await this.db.call('view', id);
    if (!view.session.character) {
      let scores: Record<string, number> | null = null; let fallback: string | null = null;
      let request = view.requests.find(r => r.role === 'router' && JSON.parse(r.config).purpose !== 'partner_reselection');
      if (request) fallback = 'router_already_attempted';
      else {
        request = await this.write('createRequest', id, 'router', routerSnapshot(JSON.parse(view.session.chat_config)));
        try {
          if (signal.aborted) throw new AppFailure('request_cancelled');
          await this.write('dispatch', request.id);
          this.activity.phase = 'routing'; this.activity.requestId = request.id; await this.publish(id);
          const source = view.messages.find(isLearner)!; const snapshot = JSON.parse(request.config);
          const result = await this.gateway.complete(routerBody(view.session.starter_text, source.content, JSON.parse(view.session.chat_config)), snapshot.response_identity, signal, 10_000);
          scores = routerScores(result.content, JSON.parse(view.session.chat_config)); await this.write('finishRequest', request.id, result.content, result.metadata);
        } catch (error) {
          fallback = failureCode(error); await this.write('failRequest', request.id, fallback, null, {}, signal.aborted);
        }
      }
      if (signal.aborted) return;
      await this.write('commitRoute', id, scores, fallback, request?.id ?? null);
      view = await this.db.call('view', id);
    }
    if (signal.aborted) return;
    if (kind !== 'retry') {
      const route = await this.write('preparePartner', id, kind, randomUUID());
      if (route) {
        try {
          if (signal.aborted) throw new AppFailure('request_cancelled');
          await this.write('dispatch', route.id);
          this.activity.phase = 'routing'; this.activity.requestId = route.id; await this.publish(id);
          const snapshot = JSON.parse(route.config);
          const result = await this.gateway.complete(partnerRouterBody(snapshot), snapshot.response_identity, signal, snapshot.timeout_seconds * 1000);
          if (signal.aborted) throw new AppFailure('request_cancelled');
          await this.write('finishPartnerRoute', route.id, result.content, result.metadata);
        } catch (error) {
          await this.write('failRequest', route.id, failureCode(error), null, error instanceof CompletionFailure ? error.metadata : {}, signal.aborted);
          throw new AppFailure('partner_selection_failed');
        }
      }
    }
    if (signal.aborted) return;
    if (this.activity.phase === 'routing') {
      this.activity.phase = 'preparing'; this.activity.requestId = null; await this.publish(id);
    }
    await routeSearch({
      view: () => this.db.call('searchView', id),
      prepare: () => this.write('searchPrepare', id),
      dispatch: attemptId => this.write('searchDispatch', attemptId),
      finish: (attemptId, content, metadata, failure, interrupted) => this.write('searchFinish', attemptId, content, metadata, failure, interrupted)
    }, this.gateway, signal);
    if (signal.aborted) return;
    const request = await this.write('prepareChat', id, randomUUID(), kind === 'retry_selection' ? 'different_model' : kind);
    let text = ''; let checkpoint = 0; let pendingCheckpoint: Promise<unknown> = Promise.resolve(); let searchEvidence: Json = {};
    let firstAnswerAt: number | null = null;
    try {
      const body = await this.db.call('chatBody', request.id);
      const bubble = await this.write('prepareReply', id, request.id);
      if (signal.aborted) throw new AppFailure('request_cancelled');
      await this.write('dispatch', request.id);
      this.activity.phase = 'reply'; this.activity.requestId = request.id; this.activity.streamingMessageId = bubble.id;
      await this.publish(id);
      const result = await this.gateway.stream(body, signal, content => {
        if (content && firstAnswerAt === null) firstAnswerAt = Date.now();
        text = content; this.activity.streamingText = content;
        this.emit({ type: 'stream', revision: ++this.revision, sessionId: id, requestId: request.id, messageId: bubble.id, text });
        if (Date.now() - checkpoint >= 250 && !this.activity.storageError) {
          checkpoint = Date.now(); pendingCheckpoint = this.write('checkpoint', bubble.id, text, body.tools ? searchEvidence : undefined);
        }
      }, body.tools ? { search: true, evidence: metadata => { searchEvidence = metadata; } } : undefined);
      if (view.search) {
        const sentAt = Date.parse(view.search.turn.created_at);
        result.metadata.send_to_completion_seconds = Math.max(0, Date.now() - sentAt) / 1000;
        if (firstAnswerAt !== null) result.metadata.send_to_first_answer_seconds = Math.max(0, firstAnswerAt - sentAt) / 1000;
      }
      await pendingCheckpoint; await this.write('finishReply', request.id, bubble.id, result.content, result.metadata);
      void this.speech?.completed({ ...bubble, content: result.content, delivery: 'complete' }).catch(() => undefined);
    } catch (error) {
      await pendingCheckpoint;
      await this.write('failRequest', request.id, failureCode(error), text,
        error instanceof CompletionFailure ? error.metadata : {}, signal.aborted);
      if (!signal.aborted) throw error;
    }
  }
  private async end(id: string) {
    await this.genie.dispose(id);
    if ((await this.db.call('session', id)).state === 'ended') return;
    if (this.interactive && this.activity.sessionId === id) { this.interactive.abort.abort(); await this.interactive.promise; }
    await this.write('end', id, this.drafts.get(id)?.text);
    await this.publish(id);
    if (this.settings.keyPresent) {
      this.enqueueMemory(id);
      await this.enqueueRenewal(id);
      // Read the committed state: a lost end acknowledgement can return false on save retry.
      if ((await this.db.call('session', id)).analysis_state === 'pending') await this.enqueue(id);
    }
  }
  private async enqueue(id: string) {
    await this.db.call('assertEndActive', id);
    const view = await this.db.call('view', id); const snapshot = JSON.parse(view.session.grammar_config ?? 'null');
    if (!snapshot) throw new AppFailure('analysis_not_retryable');
    const previous = view.requests.findLast(r => r.role === 'grammar');
    const request = await this.write('createRequest', id, 'grammar', snapshot, previous?.id ?? null);
    this.grammarQueue.push(request); await this.publish(id); this.pump();
  }
  private pump() {
    if (this.backupLocked || this.deleting.size || this.grammar || this.activity.closing) return;
    const request = this.grammarQueue.shift(); if (!request) return;
    const abort = new AbortController();
    const promise = this.analyze(request, abort.signal).catch(error => { this.activity.error = failureCode(error); }).finally(async () => {
      this.grammar = null; await this.publish(request.session_id).catch(() => undefined); this.pump();
    });
    this.grammar = { sessionId: request.session_id, abort, promise };
  }
  private async analyze(request: RequestRecord, signal: AbortSignal) {
    try {
      const source = await this.db.call('messages', request.session_id); const snapshot = JSON.parse(request.config);
      if (hash(request.config) !== request.config_hash) throw new AppFailure('config_hash_mismatch');
      const body = grammarBody(snapshot, source);
      if (signal.aborted) throw new AppFailure('queued_not_dispatched');
      await this.write('dispatch', request.id); await this.publish(request.session_id);
      const result = await this.gateway.complete(body, snapshot.response_identity, signal, 120_000);
      if (signal.aborted) throw new AppFailure('request_cancelled');
      await this.write('receiveEndResponse', request.session_id, 'grammar', request.id, result.content, result.metadata);
      validateGrammar(result.content, source); await this.write('saveAnalysis', request.id, result.content, result.metadata);
      await this.write('clearEndResponse', request.session_id, 'grammar');
    } catch (error) {
      await this.write('clearEndResponse', request.session_id, 'grammar');
      await this.write('failRequest', request.id, failureCode(error), null, {}, signal.aborted);
      if (await this.automaticRetry(request.session_id, 'grammar', error, signal)) await this.enqueue(request.session_id);
    }
  }
  private async enqueueRenewal(sessionId: string, explicit = false) {
    if (this.deleting.has(sessionId) || this.activity.closing) return;
    const job = await this.db.call('starterJob', sessionId);
    if (!job) { if (explicit) throw new AppFailure('starter_not_retryable'); return; }
    const attempt = explicit ? await this.write('retryStarter', sessionId, randomUUID()) :
      (await this.db.call('starterAttempts', job.id)).find(a => a.status === 'queued');
    if (!attempt || this.scheduledRenewals.has(attempt.id) || this.deleting.has(sessionId) || this.activity.closing) return;
    this.scheduledRenewals.add(attempt.id); this.renewalQueue.push({ attempt, sessionId });
    await this.publish(sessionId); this.pumpRenewal();
  }
  private pumpRenewal() {
    if (this.backupLocked || this.deleting.size || this.renewal || this.activity.closing) return;
    const next = this.renewalQueue.shift(); if (!next) return;
    const abort = new AbortController();
    const promise = this.renew(next.attempt, next.sessionId, abort.signal).finally(async () => {
      this.renewal = null; await this.publish(next.sessionId).catch(() => undefined); this.pumpRenewal();
    });
    this.renewal = { id: next.attempt.id, sessionId: next.sessionId, abort, promise };
  }
  private async renew(attempt: RenewalAttempt, sessionId: string, signal: AbortSignal) {
    let content: string | null = null; let metadata: Json = {}; let started: number | null = null;
    try {
      const job = await this.db.call('starterJob', sessionId);
      if (!job || job.id !== attempt.job_id) throw new AppFailure('starter_job_not_found');
      if (hash(job.input_json) !== job.input_hash || hash(job.config) !== job.config_hash) throw new AppFailure('starter_source_changed');
      const snapshot = JSON.parse(job.config); const body = starterBody(snapshot, job.input_json);
      const input = JSON.parse(job.input_json);
      metadata = { input_bytes: Buffer.byteLength(job.input_json), source_turns: Array.isArray(input) ? input.length : input.session_context.turns.length,
        input_hash: job.input_hash, prompt_hash: snapshot.prompt_sha256, config_hash: job.config_hash,
        queue_seconds: Math.max(0, Date.now() - Date.parse(attempt.created_at)) / 1000 };
      if (signal.aborted) throw new AppFailure('queued_not_dispatched');
      await this.write('dispatchStarter', attempt.id); await this.publish(sessionId);
      started = performance.now();
      const result = await this.gateway.complete(body, snapshot.response_identity, signal, snapshot.timeout_seconds * 1000);
      content = result.content; metadata = { ...metadata, ...result.metadata, elapsed_seconds: (performance.now() - started) / 1000 };
      if (signal.aborted) throw new AppFailure('request_cancelled');
      await this.write('receiveEndResponse', sessionId, 'starter', attempt.id, content, metadata);
      parseStarterQuestions(content); await this.write('saveStarter', attempt.id, content, metadata);
      await this.write('clearEndResponse', sessionId, 'starter');
    } catch (error) {
      if (error instanceof CompletionFailure) { content = error.content; metadata = { ...metadata, ...error.metadata }; }
      if (started !== null) metadata.elapsed_seconds = (performance.now() - started) / 1000;
      await this.write('clearEndResponse', sessionId, 'starter');
      await this.write('failStarter', attempt.id, failureCode(error), content, metadata, signal.aborted);
      if (await this.automaticRetry(sessionId, 'starter', error, signal)) await this.enqueueRenewal(sessionId, true);
    }
  }
  private enqueueMemory(sessionId: string) {
    this.memoryAuthorized.add(sessionId); this.memoryWake++; this.pumpMemory();
  }
  private async memoryChanged(sessionId: string) {
    const session = await this.db.call('session', sessionId);
    if (session.character) this.emit({ type: 'memory-changed', characterId: session.character, revision: ++this.revision });
    await this.publish(sessionId);
    const unfinished = await this.db.call('unfinished'); if (unfinished) await this.publish(unfinished.id);
  }
  private async automaticRetry(id: string, stage: string, error: unknown, signal: AbortSignal): Promise<boolean> {
    const delay = endRetryDelay(error);
    if (signal.aborted || this.activity.closing || delay === null) return false;
    if (!(await this.write('takeAutomaticRetry', id, stage))) return false;
    await waitEndRetry(delay, signal);
    return !signal.aborted && !this.activity.closing;
  }
  private async cleanMemory(sessionId: string, candidate: Json, signal: AbortSignal) {
    const attempt = await this.write('prepareCleanup', sessionId, randomUUID());
    const started = performance.now();
    try {
      if (attempt.status !== 'received') {
        const config = JSON.parse(candidate.config), body = cleanupBody(config, JSON.parse(candidate.document));
        await this.write('dispatchCleanup', attempt.id); await this.publish(sessionId);
        const result = await this.gateway.complete(body, config.response_identity, signal, config.timeout_seconds * 1000);
        if (signal.aborted) throw new AppFailure('request_cancelled');
        await this.write('receiveCleanup', attempt.id, result.content, { ...result.metadata, elapsed_seconds: (performance.now() - started) / 1000 });
      }
      await this.write('acceptCleanup', attempt.id);
    } catch (error) {
      await this.write('failCleanup', attempt.id, failureCode(error), signal.aborted, { content: error instanceof CompletionFailure ? error.content : null, metadata: { ...(error instanceof CompletionFailure ? error.metadata : {}), elapsed_seconds: (performance.now() - started) / 1000 } });
      if (await this.automaticRetry(sessionId, 'cleanup', error, signal)) {
        await this.write('retryMemory', sessionId); this.memoryAuthorized.add(sessionId);
      }
    }
  }
  private pumpMemory() {
    if (this.backupLocked || this.deleting.size || this.memory || this.activity.closing || !this.settings.keyPresent) return;
    const abort = new AbortController(), wake = this.memoryWake;
    const promise = Promise.resolve().then(async () => {
      while (!this.deleting.size && !abort.signal.aborted && !this.activity.closing && this.settings.keyPresent) {
        const sessionId = await this.db.call('memoryReady', [...this.memoryAuthorized]);
        if (!sessionId || this.deleting.size) break;
        this.memory!.sessionId = sessionId;
        this.memoryAuthorized.delete(sessionId);
        const candidate = await this.db.call('memoryCandidate', sessionId);
        if (candidate && candidate.state !== 'completed') {
          await this.cleanMemory(sessionId, candidate, abort.signal);
          await this.memoryChanged(sessionId); this.memory!.sessionId = null; continue;
        }
        const attempt = await this.write('prepareMemory', sessionId, randomUUID());
        let content: string | null = null; let metadata: Json = {}; const started = performance.now();
        try {
          const job = await this.db.call('memoryJob', sessionId);
          if (!job || hash(job.config) !== job.config_hash || hash(attempt.input_json) !== attempt.input_hash) throw new AppFailure('memory_source_changed');
          const packet = JSON.parse(attempt.input_json), snapshot = JSON.parse(job.config);
          const body = memoryBody(snapshot, packet);
          if (abort.signal.aborted) throw new AppFailure('queued_not_dispatched');
          await this.write('dispatchMemory', attempt.id); await this.publish(sessionId);
          const result = await this.gateway.complete(body, snapshot.response_identity, abort.signal, snapshot.timeout_seconds * 1000);
          content = result.content; metadata = { ...result.metadata, elapsed_seconds: (performance.now() - started) / 1000,
            input_hash: attempt.input_hash, base_revision: packet.current_memory.revision, character_id: job.character_id };
          if (abort.signal.aborted) throw new AppFailure('request_cancelled');
          await this.write('receiveEndResponse', sessionId, 'update', attempt.id, content, metadata);
          applyMemory(packet, content, true);
          await this.write('saveMemory', attempt.id, content, metadata);
          await this.write('clearEndResponse', sessionId, 'update');
        } catch (error) {
          if (error instanceof CompletionFailure) { content = error.content; metadata = { ...metadata, ...error.metadata }; }
          metadata.elapsed_seconds = (performance.now() - started) / 1000;
          await this.write('clearEndResponse', sessionId, 'update');
          await this.write('failMemory', attempt.id, failureCode(error), content, metadata, abort.signal.aborted);
          if (await this.automaticRetry(sessionId, 'update', error, abort.signal)) {
            await this.write('retryMemory', sessionId); this.memoryAuthorized.add(sessionId);
          }
        }
        if ((await this.db.call('memoryJob', sessionId))?.state === 'pending') this.memoryAuthorized.add(sessionId);
        await this.memoryChanged(sessionId);
        this.memory!.sessionId = null;
      }
    }).catch(error => { this.activity.error = failureCode(error); }).finally(async () => {
      this.memory = null; await this.publish().catch(() => undefined);
      if (wake !== this.memoryWake) this.pumpMemory();
    });
    this.memory = { sessionId: null, abort, promise };
  }
  async cleanupDeletions() {
    const pending = await this.db.call('pendingDeletions');
    this.activity.deletionCleanupPending = false;
    for (const id of pending) {
      try {
        // Both stores are initialized before startup cleanup. A failed file removal
        // leaves the marker durable; the next launch or explicit retry resumes it.
        const assets = await this.db.call('deletionAssets', id);
        await this.speech?.deleteSession(id, assets.speechKeys);
        await this.dictation?.deleteSession(id, assets.dictationIds);
        await this.db.call('finishDeletion', id);
      } catch { this.activity.deletionCleanupPending = true; }
    }
  }
  private async deleteSession(id: string) {
    // The database owns final eligibility; loadSession is deliberately bypassed.
    try {
      if ((await this.db.call('session', id)).state !== 'ended') throw new AppFailure('delete_requires_ended');
    } catch (error) { if (failureCode(error) !== 'session_not_found') throw error; }
    await this.genie.dispose(id);
    await this.explain.dispose(id);
    await this.patterns.sourceDeleting(id);
    this.deleting.add(id);
    try {
      this.grammarQueue = this.grammarQueue.filter(request => request.session_id !== id);
      this.renewalQueue = this.renewalQueue.filter(job => {
        if (job.sessionId !== id) return true;
        this.scheduledRenewals.delete(job.attempt.id); return false;
      });
      this.memoryAuthorized.delete(id);
      const jobs = [this.grammar, this.renewal, this.memory].filter(job => job?.sessionId === id);
      for (const job of jobs) job!.abort.abort();
      await Promise.all(jobs.map(job => job!.promise));
      const speechKeys = await this.speech?.prepareDeletion(id) ?? [];
      const dictationIds = await this.dictation?.prepareDeletion(id) ?? [];
      await this.write('deleteSession', id, { speechKeys, dictationIds });
      this.drafts.delete(id);
      if (this.activity.sessionId === id) {
        this.activity.sessionId = null; this.activity.streamingMessageId = null; this.activity.streamingText = '';
      }
      this.emit({ type: 'session-deleted', sessionId: id, revision: ++this.revision });
      this.emit({ type: 'memory-changed', characterId: 'shared', revision: ++this.revision });
      await this.cleanupDeletions();
      await this.publish();
    } catch (error) {
      this.speech?.cancelDeletion(id); this.dictation?.cancelDeletion(id);
      throw error;
    } finally {
      this.deleting.delete(id); this.memoryWake++;
      this.pump(); this.pumpRenewal(); this.pumpMemory();
    }
  }
  private async close(): Promise<boolean> {
    this.activity.closing = true; await this.publish();
    await this.genie.dispose();
    await this.explain.dispose();
    await this.patterns.close();
    this.interactive?.abort.abort(); this.grammar?.abort.abort(); this.renewal?.abort.abort(); this.memory?.abort.abort();
    await Promise.all([this.interactive?.promise, this.grammar?.promise, this.renewal?.promise, this.memory?.promise]);
    this.memoryAuthorized.clear();
    for (const request of this.grammarQueue.splice(0)) await this.write('failRequest', request.id, 'queued_not_dispatched', null, {}, true);
    for (const { attempt } of this.renewalQueue.splice(0)) await this.write('failStarter', attempt.id, 'queued_not_dispatched', null, {}, true);
    await this.saveTail;
    if (this.activity.storageError) { this.activity.closing = false; this.patterns.resumeAfterCloseFailure(); await this.publish(); return false; }
    await this.speech?.close();
    await this.dictation?.close();
    await this.db.close(); return true;
  }
}
