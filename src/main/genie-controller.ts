import { prepareProviderRequest } from './provider-policy';
import { randomUUID } from 'node:crypto';
import type { GenieSource, GenieRange, GenieSnapshot, GenieEpisode, GenieDraftResult } from '../shared/genie';
import type { Json } from '../shared/types';
import { AppFailure, failureCode } from './errors';
import { CompletionFailure, type Gateway } from './transport';
import { genieBody, genieIdentity, genieLimits, genieRange, genieReplacement, genieTimeout, parseGenie } from './genie';

type Hooks = {
  source: (sessionId: string, text: string, revision: number) => Promise<GenieSource>;
  save: (source: GenieSource, text: string, revision: number) => Promise<void>;
  emit: (snapshot: GenieSnapshot) => void;
};
export class GenieController {
  private state: GenieSnapshot = { revision: 0, episode: null, undo: null, draftResult: null };
  private history: { role: string; content: string }[] = [];
  private pendingBody: Json | null = null;
  private flight: { abort: AbortController; promise: Promise<void> } | null = null;
  private undoSource: { source: GenieSource; range: GenieRange } | null = null;
  private receipts = new Map<string, { payload: string; promise: Promise<any> }>();
  private epoch = 0;
  private lastTarget: { operationId: string; payload: string; snapshot: GenieSnapshot } | null = null;
  constructor(private gateway: Gateway, private hooks: Hooks) {}
  get locked() { return this.state.episode?.open === true; }
  get saving() { return this.state.episode?.phase === 'saving'; }
  snapshot(): GenieSnapshot { return structuredClone(this.state); }
  private publish() { this.state.revision++; this.hooks.emit(this.snapshot()); }
  private episode(id: string) {
    const e = this.state.episode;
    if (!e || e.id !== id) throw new AppFailure('genie_stale');
    return e;
  }
  private stillOpen(e: GenieEpisode, epoch: number) {
    if (this.state.episode !== e || !e.open || epoch !== this.epoch) throw new AppFailure('genie_stale');
  }
  private once<T>(operationId: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(payload), old = this.receipts.get(operationId);
    if (old) { if (old.payload !== key) throw new AppFailure('genie_operation_conflict'); return old.promise; }
    if (this.receipts.size >= 1024) throw new AppFailure('genie_limit');
    const promise = operation(); this.receipts.set(operationId, { payload: key, promise }); return promise;
  }
  async open(args: { sessionId: string; text: string; revision: number; range: GenieRange; operationId: string }): Promise<GenieSnapshot> {
    const source = await this.hooks.source(args.sessionId, args.text, args.revision), range = genieRange(source.text, args.range);
    const old = this.state.episode;
    if (old && old.source.sessionId === source.sessionId && old.source.text === source.text && old.source.contextHash === source.contextHash && JSON.stringify(old.range) === JSON.stringify(range)) {
      old.source = source;
      old.open = true; this.publish(); return this.snapshot();
    }
    if (this.locked) throw new AppFailure('genie_busy');
    genieBody(source, range); await this.dispose();
    this.begin(source, range, args.operationId); return this.snapshot();
  }
  private begin(source: GenieSource, range: GenieRange, id: string = randomUUID()) {
    const body = genieBody(source, range);
    this.history = []; this.receipts.clear(); this.undoSource = null; this.state.undo = null; this.state.draftResult = null;
    this.state.episode = { id, sessionId: source.sessionId, source, range, open: true, phase: 'waiting',
      turns: [], candidateId: null, followup: '', followupRevision: 0, attempts: [] };
    this.pendingBody = body; this.newTurn(null); this.dispatch();
  }
  updateDraft(id: string, text: string, revision: number) {
    const e = this.episode(id);
    if (Buffer.byteLength(text) > genieLimits.followup) throw new AppFailure('genie_limit');
    if (revision < e.followupRevision) return;
    if (revision === e.followupRevision && text !== e.followup) throw new AppFailure('genie_stale');
    e.followup = text; e.followupRevision = revision; this.publish();
  }
  async submit(args: { episodeId: string; text: string; revision: number; operationId: string }) {
    return this.once(args.operationId, ['submit', args], async () => {
      const e = this.episode(args.episodeId), epoch = this.epoch;
      if (!e.open || e.phase !== 'ready' || this.flight) throw new AppFailure('genie_busy');
      await this.hooks.source(e.sessionId, e.source.text, e.source.revision).then(s => this.sameSource(e, s));
      this.stillOpen(e, epoch);
      if (!args.text.trim() || Buffer.byteLength(args.text) > genieLimits.followup) throw new AppFailure('genie_limit');
      if (args.revision < e.followupRevision) throw new AppFailure('genie_stale');
      const next = [...this.history, { role: 'user', content: args.text }];
      const body = genieBody(e.source, e.range, next);
      this.history = next; this.pendingBody = body;
      e.followup = ''; e.followupRevision = args.revision + 1;
      this.newTurn(args.text); this.dispatch();
    });
  }
  async retry(id: string, operationId: string) {
    return this.once(operationId, ['retry', id], async () => {
      const e = this.episode(id), epoch = this.epoch;
      if (!e.open || !['failed', 'interrupted'].includes(e.phase) || this.flight || !this.pendingBody) throw new AppFailure('genie_busy');
      this.sameSource(e, await this.hooks.source(e.sessionId, e.source.text, e.source.revision));
      this.stillOpen(e, epoch);
      e.turns.at(-1)!.reply = null; this.dispatch();
    });
  }
  private newTurn(user: string | null) {
    const e = this.state.episode!;
    e.candidateId = null;
    e.turns.push({ id: randomUUID(), user, reply: null, status: 'waiting', error: null });
  }
  private dispatch() {
    const e = this.state.episode!, turn = e.turns.at(-1)!, body = this.pendingBody!;
    const abort = new AbortController(), attempt = { id: randomUUID(), status: 'waiting', error: null as string | null, cost: null as number | null };
    e.attempts.push(attempt); e.phase = 'waiting'; e.candidateId = null; turn.status = 'waiting'; turn.error = null;
    const promise = (async () => {
      try {
        const routed = prepareProviderRequest(body, genieIdentity);
        const result = await this.gateway.complete(routed.body, routed.identity!, abort.signal, genieTimeout);
        if (abort.signal.aborted || this.state.episode !== e) return;
        attempt.cost = typeof result.metadata.usage?.cost === 'number' && Number.isFinite(result.metadata.usage.cost) ? result.metadata.usage.cost : null;
        const reply = parseGenie(result.content), replacement = genieReplacement(e.source, e.range, reply);
        turn.reply = reply; turn.status = 'ready'; e.phase = 'ready'; attempt.status = 'succeeded';
        e.candidateId = replacement === null ? null : turn.id;
        this.history.push({ role: 'assistant', content: result.content }); this.pendingBody = null;
      } catch (error) {
        if (abort.signal.aborted || this.state.episode !== e) return;
        if (error instanceof CompletionFailure && typeof error.metadata.usage?.cost === 'number') attempt.cost = error.metadata.usage.cost;
        turn.status = 'failed'; turn.error = failureCode(error); e.phase = 'failed'; attempt.status = 'failed'; attempt.error = turn.error;
      } finally {
        if (this.flight?.abort === abort) this.flight = null;
        if (this.state.episode === e) this.publish();
      }
    })();
    this.flight = { abort, promise }; this.publish();
  }
  async cancel(id: string, close = false) {
    const e = this.episode(id);
    if (e.phase === 'saving') throw new AppFailure('save_required');
    this.epoch++;
    if (close) e.open = false;
    const flight = this.flight;
    if (flight) {
      flight.abort.abort(); e.phase = 'interrupted'; e.candidateId = null;
      const turn = e.turns.at(-1)!; turn.status = 'interrupted'; turn.error = 'request_cancelled';
      const attempt = e.attempts.at(-1)!; attempt.status = 'interrupted'; attempt.error = 'request_cancelled';
    }
    this.publish(); await flight?.promise;
  }
  async target(id: string, range: GenieRange, operationId: string) {
    const payload = JSON.stringify([id, range]);
    if (this.lastTarget?.operationId === operationId) {
      if (payload !== this.lastTarget.payload) throw new AppFailure('genie_operation_conflict');
      return structuredClone(this.lastTarget.snapshot);
    }
    const e = this.episode(id), epoch = this.epoch;
    if (!e.open || e.phase === 'saving') throw new AppFailure('genie_busy');
    const source = await this.hooks.source(e.sessionId, e.source.text, e.source.revision); this.sameSource(e, source);
    this.stillOpen(e, epoch);
    const normalized = genieRange(source.text, range); genieBody(source, normalized);
    await this.cancel(id);
    if (!e.open || this.state.episode !== e) throw new AppFailure('genie_stale');
    this.begin(source, normalized, operationId);
    const result = this.snapshot(); this.lastTarget = { operationId, payload, snapshot: result }; return result;
  }
  private sameSource(e: GenieEpisode, source: GenieSource) {
    if (JSON.stringify(e.source) !== JSON.stringify(source)) throw new AppFailure('genie_stale');
  }
  async apply(args: { episodeId: string; candidateId: string; revision: number; operationId: string }): Promise<GenieDraftResult> {
    return this.once(args.operationId, ['apply', args], async () => {
      const e = this.episode(args.episodeId), turn = e.turns.at(-1)!, epoch = this.epoch;
      if (!e.open || e.phase !== 'ready' || e.candidateId !== args.candidateId || !turn.reply) throw new AppFailure('genie_stale');
      this.sameSource(e, await this.hooks.source(e.sessionId, e.source.text, e.source.revision));
      this.stillOpen(e, epoch);
      const text = genieReplacement(e.source, e.range, turn.reply);
      if (text === null || args.revision <= e.source.revision) throw new AppFailure('genie_stale');
      e.phase = 'saving'; this.publish();
      try { await this.hooks.save(e.source, text, args.revision); }
      catch (error) { e.phase = 'ready'; this.publish(); throw error; }
      const range: GenieRange = { start: e.range.start, end: e.range.start + turn.reply.suggested_text!.length, direction: 'forward', scope: 'selection' };
      const result = { sessionId: e.sessionId, text, revision: args.revision, range };
      this.undoSource = { source: e.source, range: e.range };
      this.state.undo = { id: args.operationId, sessionId: e.sessionId, text, revision: args.revision };
      this.state.draftResult = result; e.open = false; e.phase = 'ready'; e.candidateId = null; this.publish(); return result;
    });
  }
  async undo(args: { undoId: string; revision: number; operationId: string }): Promise<GenieDraftResult> {
    return this.once(args.operationId, ['undo', args], async () => {
      const undo = this.state.undo, original = this.undoSource;
      if (this.locked || !undo || !original || undo.id !== args.undoId || args.revision <= undo.revision) throw new AppFailure('genie_stale');
      const source = await this.hooks.source(undo.sessionId, undo.text, undo.revision);
      if (source.contextHash !== original.source.contextHash) throw new AppFailure('genie_stale');
      await this.hooks.save(source, original.source.text, args.revision);
      const result = { sessionId: source.sessionId, text: original.source.text, revision: args.revision, range: original.range };
      this.state.undo = null; this.undoSource = null; this.state.draftResult = result; this.publish(); return result;
    });
  }
  invalidateDraft(id: string, revision: number, text: string) {
    const u = this.state.undo, d = this.state.draftResult;
    let changed = false;
    if (u?.sessionId === id && (u.revision !== revision || u.text !== text)) { this.state.undo = null; this.undoSource = null; changed = true; }
    if (d?.sessionId === id && (d.revision !== revision || d.text !== text)) { this.state.draftResult = null; changed = true; }
    if (changed) this.publish();
  }
  async dispose(sessionId?: string) {
    if (sessionId && this.state.episode?.sessionId !== sessionId && this.state.undo?.sessionId !== sessionId) return;
    this.epoch++; this.lastTarget = null;
    const flight = this.flight; flight?.abort.abort(); this.state.episode = null; this.state.undo = null; this.state.draftResult = null;
    this.history = []; this.pendingBody = null; this.undoSource = null; this.receipts.clear(); this.publish(); await flight?.promise;
  }
}
