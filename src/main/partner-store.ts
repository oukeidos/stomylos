import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Json, Message, PartnerView, RequestRecord, Session } from '../shared/types';
import { AppFailure } from './errors';
import { character, hash, isLearner, transcriptJson } from './contracts';
import { chooseOtherPartner, partnerRouterSnapshot } from './partner-router';

export interface PartnerOperation {
  id: string; session_id: string; revision: number; choice: string | null; excluded_model: string;
  source_sequence: number | null; source_hash: string | null; config: string | null; config_hash: string | null;
  state: 'pending' | 'routing' | 'ready' | 'failed' | 'completed' | 'superseded';
  selected_character: string | null; selected_model: string | null; router_request_id: string | null;
}
interface State { revision: number; current_character: string; current_model: string; pending_operation_id: string | null }
const fail = (code: string): never => { throw new AppFailure('partner_' + code); };
export class PartnerStore {
  constructor(private db: Database.Database) {}
  private row<T>(sql: string, ...args: unknown[]) { return this.db.prepare(sql).get(...args) as T | undefined; }
  private run(sql: string, ...args: unknown[]) { return this.db.prepare(sql).run(...args); }
  state(session: Session): State {
    return this.row<State>('SELECT * FROM session_partner_state WHERE session_id=?', session.id) ??
      { revision: 0, current_character: session.character!, current_model: session.model!, pending_operation_id: null };
  }
  pending(session: Session): PartnerOperation | null {
    const id = this.state(session).pending_operation_id;
    return id ? this.row<PartnerOperation>('SELECT * FROM partner_selection_operations WHERE id=? AND session_id=?', id, session.id) ?? fail('operation_missing') : null;
  }
  view(session: Session, messages: Message[], requests: RequestRecord[]): PartnerView {
    const state = this.state(session), pending = this.pending(session), user = messages.findLast(isLearner);
    const last = requests.findLast(r => r.role === 'chat' && r.source_sequence === user?.sequence);
    const unresolved = messages.at(-1)?.role === 'user' || messages.at(-1)?.delivery === 'interrupted';
    return { revision: state.revision, currentCharacter: state.current_character, currentModel: state.current_model,
      pending: pending ? { id: pending.id, choice: pending.choice, state: pending.state } : null,
      canRetryReply: !!unresolved && (last ? ['failed', 'interrupted'].includes(last.status) : !pending || pending.state === 'pending'),
      canUseSelected: !!unresolved && !!pending && ['pending', 'ready'].includes(pending.state) &&
        (pending.choice === null || character(pending.choice, JSON.parse(session.chat_config)).model !== state.current_model),
      retryModel: last ? JSON.parse(last.config).request_partner?.target.model ?? session.model : session.model };
  }
  change(session: Session, choice: string | null, id: string, expectedRevision: number) {
    if (session.state !== 'active' || !session.character || !session.model) fail('not_available');
    const saved = JSON.parse(session.chat_config); if (choice !== null) character(choice, saved);
    const prior = this.row<PartnerOperation>('SELECT * FROM partner_selection_operations WHERE id=?', id);
    if (prior) { if (prior.session_id !== session.id || prior.choice !== choice || prior.revision !== expectedRevision + 1) fail('operation_conflict'); return; }
    if (this.row("SELECT 1 FROM model_requests WHERE session_id=? AND role IN ('chat','router') AND status IN ('queued','dispatched')", session.id)) fail('busy');
    const state = this.state(session); if (state.revision !== expectedRevision) fail('selection_changed');
    const pending = this.pending(session);
    if (pending?.state === 'routing') fail('busy');
    if (pending) this.run("UPDATE partner_selection_operations SET state='superseded' WHERE id=?", pending.id);
    const revision = state.revision + 1;
    const same = choice === state.current_character;
    this.run(`INSERT INTO partner_selection_operations(id,session_id,revision,choice,excluded_model,state,created_at)
      VALUES(?,?,?,?,?,?,?)`, id, session.id, revision, choice, state.current_model, same ? 'superseded' : 'pending', new Date().toISOString());
    this.run(`INSERT INTO session_partner_state VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      revision=excluded.revision,pending_operation_id=excluded.pending_operation_id`, session.id, revision, state.current_character, state.current_model, same ? null : id);
  }
  bind(session: Session, messages: Message[]) {
    let op = this.pending(session); if (!op) return null;
    const user = messages.findLast(isLearner); if (!user) fail('source_missing');
    if (op.source_sequence !== null && op.source_sequence < user!.sequence) {
      // A successful original-model retry can leave a bound replacement unused.
      // Carry the user's choice forward, preserving the old frozen operation.
      const answered = messages.some(m => m.sequence > op!.source_sequence! && m.sequence < user!.sequence && m.origin === 'model' && m.delivery === 'complete');
      if (!answered) fail('source_changed');
      this.change(session, op.choice, randomUUID(), this.state(session).revision);
      op = this.pending(session); if (!op) return null;
    }
    const source = messages.filter(m => m.sequence <= user!.sequence), sourceHash = hash(transcriptJson(source));
    if (op.source_sequence !== null) {
      if (op.source_sequence !== user!.sequence || op.source_hash !== sourceHash || !op.config || hash(op.config) !== op.config_hash) fail('source_changed');
      return op;
    }
    const saved = JSON.parse(session.chat_config);
    const config = JSON.stringify(op.choice === null ? partnerRouterSnapshot(saved, source, op.excluded_model) : { choice: character(op.choice, saved) });
    this.run(`UPDATE partner_selection_operations SET source_sequence=?,source_hash=?,config=?,config_hash=?,state=?,selected_character=?,selected_model=? WHERE id=?`,
      user!.sequence, sourceHash, config, hash(config), op.choice === null ? 'routing' : 'ready', op.choice,
      op.choice === null ? null : character(op.choice, saved).model, op.id);
    return this.pending(session);
  }
  routerRequest(session: Session, requestId: string) {
    const op = this.pending(session); if (!op || op.choice !== null || !['routing','failed'].includes(op.state)) fail('not_retryable');
    this.run("UPDATE partner_selection_operations SET router_request_id=?,state='routing' WHERE id=?", requestId, op!.id);
  }
  resolve(session: Session, requestId: string, scores: Record<string, number>) {
    const op = this.pending(session);
    if (op?.state === 'ready' && op.router_request_id === requestId) return;
    if (!op || op.state !== 'routing' || op.router_request_id !== requestId) fail('selection_changed');
    const counts = Object.fromEntries((this.db.prepare('SELECT character,COUNT(*) AS n FROM route_decisions GROUP BY character').all() as {character: string; n: number}[]).map(r => [r.character,r.n]));
    const decision = chooseOtherPartner(JSON.parse(session.chat_config), op!.excluded_model, scores, counts);
    this.run("UPDATE partner_selection_operations SET state='ready',selected_character=?,selected_model=?,decision=? WHERE id=?",
      decision.character, decision.model, JSON.stringify({ ...decision, scores }), op!.id);
  }
  fail(requestId: string) { this.run("UPDATE partner_selection_operations SET state='failed' WHERE router_request_id=? AND state='routing'", requestId); }
  apply(session: Session, request: RequestRecord) {
    const op = this.pending(session); if (!op) return;
    if (op.state !== 'ready' || op.source_sequence !== request.source_sequence) fail('selection_pending');
    this.run("UPDATE partner_selection_operations SET state='completed',chat_request_id=? WHERE id=?", request.id, op.id);
    this.run('UPDATE session_partner_state SET current_character=?,current_model=?,pending_operation_id=NULL,revision=revision+1 WHERE session_id=?', op.selected_character, op.selected_model, session.id);
  }
  recover() { this.run("UPDATE partner_selection_operations SET state='failed' WHERE state='routing'"); }
  delete(id: string) {
    this.run('DELETE FROM session_partner_state WHERE session_id=?', id);
    this.run('DELETE FROM partner_selection_operations WHERE session_id=?', id);
  }
}
