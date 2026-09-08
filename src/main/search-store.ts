import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Json, Message, RequestRecord, Session } from '../shared/types';
import type { SearchAttempt, SearchMode, SearchTurn, SearchView } from '../shared/search';
import { AppFailure } from './errors';
import { searchBoolean, searchHash, searchInput, searchRouterBody, searchSnapshot, validateSearchSnapshot, withSearch } from './search-contract';

const now = () => new Date().toISOString();
export class SearchStore {
  constructor(private db: Database.Database) {}
  private turn(userId: string): SearchTurn | null {
    const turn = this.db.prepare('SELECT * FROM search_turns WHERE user_message_id=?').get(userId) as SearchTurn | undefined;
    if (!turn) return null;
    if (searchHash(turn.input) !== turn.input_hash || searchHash(turn.config) !== turn.config_hash) throw new AppFailure('search_source_changed');
    validateSearchSnapshot(JSON.parse(turn.config));
    return turn;
  }
  view(sessionId: string): SearchView | null {
    const user = this.db.prepare("SELECT id FROM messages WHERE session_id=? AND role='user' ORDER BY sequence DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
    const turn = user ? this.turn(user.id) : null;
    return turn ? { turn, attempts: this.attempts(turn.user_message_id) } : null;
  }
  history(sessionId: string): SearchView[] {
    const turns = this.db.prepare('SELECT t.user_message_id FROM search_turns t JOIN messages m ON m.id=t.user_message_id WHERE t.session_id=? ORDER BY m.sequence').all(sessionId) as { user_message_id: string }[];
    return turns.map(t => ({ turn: this.turn(t.user_message_id)!, attempts: this.attempts(t.user_message_id) }));
  }
  private attempts(userId: string): SearchAttempt[] {
    return this.db.prepare('SELECT * FROM search_router_attempts WHERE user_message_id=? ORDER BY ordinal').all(userId) as SearchAttempt[];
  }
  freeze(session: Session, previous: Message[], message: Message, sentAt: string) {
    const input = searchInput(previous.at(-1)?.content ?? '', message.content), config = JSON.stringify(searchSnapshot());
    const off = session.search_mode === 'off';
    this.db.prepare('INSERT INTO search_turns VALUES(?,?,?,?,?,?,?,?,?,?)').run(message.id, session.id, session.search_mode,
      input, searchHash(input), config, searchHash(config), sentAt, off ? 'off' : null, off ? 0 : null);
  }
  setMode(session: Session, messages: Message[], mode: SearchMode) {
    if (!['auto', 'off'].includes(mode)) throw new AppFailure('invalid_search_mode');
    const last = messages.at(-1);
    if (session.state === 'ended' || last?.role === 'user' || last?.delivery === 'interrupted' || last?.delivery === 'streaming') throw new AppFailure('search_mode_locked');
    this.db.prepare('UPDATE sessions SET search_mode=? WHERE id=?').run(mode, session.id);
  }
  prepare(sessionId: string): SearchAttempt | null {
    return this.db.transaction(() => {
      const view = this.view(sessionId); if (!view || view.turn.decision) return null;
      const active = this.db.prepare("SELECT 1 FROM sessions WHERE id=? AND state='active'").get(sessionId);
      if (!active) throw new AppFailure('session_ended');
      const pending = view.attempts.find(a => a.status === 'queued'); if (pending) return this.checked(pending);
      if (view.attempts.some(a => a.status === 'dispatched')) throw new AppFailure('search_in_progress');
      if (view.attempts.length === 2) {
        this.db.prepare("UPDATE search_turns SET decision='router_unavailable',permitted=1 WHERE user_message_id=? AND decision IS NULL").run(view.turn.user_message_id);
        return null;
      }
      const ordinal = view.attempts.length, body = searchRouterBody(JSON.parse(view.turn.config), view.turn.input, ordinal);
      const config = JSON.stringify(body), id = randomUUID();
      this.db.prepare("INSERT INTO search_router_attempts(id,user_message_id,ordinal,status,config,config_hash,created_at) VALUES(?,?,?,'queued',?,?,?)")
        .run(id, view.turn.user_message_id, ordinal, config, searchHash(config), now());
      return this.attempts(view.turn.user_message_id).find(a => a.id === id)!;
    })();
  }
  private checked(attempt: SearchAttempt): SearchAttempt {
    const turn = this.turn(attempt.user_message_id);
    if (!turn || searchHash(attempt.config) !== attempt.config_hash ||
        attempt.config !== JSON.stringify(searchRouterBody(JSON.parse(turn.config), turn.input, attempt.ordinal))) throw new AppFailure('search_source_changed');
    return attempt;
  }
  dispatch(id: string) {
    const attempt = this.db.prepare('SELECT * FROM search_router_attempts WHERE id=?').get(id) as SearchAttempt | undefined;
    if (!attempt) throw new AppFailure('search_attempt_missing');
    this.checked(attempt);
    if (attempt.status === 'dispatched') return; // Save acknowledgement retry, not permission to resend HTTP.
    if (this.db.prepare("UPDATE search_router_attempts SET status='dispatched',dispatched_at=? WHERE id=? AND status='queued'").run(now(), id).changes !== 1) throw new AppFailure('request_not_queued');
  }
  finish(id: string, content: string | null, metadata: Json, failure: string | null, interrupted = false) {
    this.db.transaction(() => {
      const attempt = this.db.prepare('SELECT * FROM search_router_attempts WHERE id=?').get(id) as SearchAttempt | undefined;
      if (!attempt) throw new AppFailure('search_attempt_missing');
      this.checked(attempt);
      if (!['queued', 'dispatched'].includes(attempt.status)) return;
      const permitted = failure === null ? searchBoolean(content ?? '') : null;
      if (!failure && attempt.status !== 'dispatched') throw new AppFailure('request_not_dispatched');
      this.db.prepare('UPDATE search_router_attempts SET status=?,finished_at=?,response_content=?,metadata=?,failure=? WHERE id=?')
        .run(failure ? interrupted ? 'interrupted' : 'failed' : 'succeeded', now(), content, JSON.stringify(metadata), failure, id);
      if (permitted !== null) this.db.prepare('UPDATE search_turns SET decision=?,permitted=? WHERE user_message_id=? AND decision IS NULL')
        .run(attempt.ordinal === 0 ? 'primary' : 'fallback', Number(permitted), attempt.user_message_id);
    })();
  }
  recover() {
    this.db.prepare("UPDATE search_router_attempts SET status='interrupted',failure='interrupted_unknown_outcome',finished_at=? WHERE status='dispatched'").run(now());
  }
  attach(request: RequestRecord, user: Message) {
    const turn = this.turn(user.id); if (!turn) return;
    if (!turn.decision || turn.permitted === null) throw new AppFailure('search_decision_pending');
    const config = JSON.stringify({ turn_hash: turn.config_hash, input_hash: turn.input_hash, mode: turn.mode,
      decision: turn.decision, permitted: !!turn.permitted, contract: JSON.parse(turn.config) });
    if (request.parent_id) {
      const parent = this.db.prepare('SELECT config FROM chat_search_context WHERE request_id=?').get(request.parent_id) as { config: string } | undefined;
      if (!parent || parent.config !== config) throw new AppFailure('search_retry_changed');
    }
    this.db.prepare('INSERT INTO chat_search_context VALUES(?,?,?,?,?)').run(request.id, user.id, request.session_id, config, searchHash(config));
  }
  body(request: RequestRecord, user: Message, body: Json): Json {
    const context = this.db.prepare('SELECT * FROM chat_search_context WHERE request_id=?').get(request.id) as { user_message_id: string; config: string; config_hash: string } | undefined;
    const turn = this.turn(user.id);
    if (!turn && !context) return withSearch(body, false);
    if (!turn || !context || context.user_message_id !== user.id || searchHash(context.config) !== context.config_hash) throw new AppFailure('search_source_changed');
    const saved = JSON.parse(context.config);
    validateSearchSnapshot(saved.contract);
    if (saved.turn_hash !== turn.config_hash || saved.input_hash !== turn.input_hash || saved.mode !== turn.mode ||
        saved.decision !== turn.decision || saved.permitted !== !!turn.permitted || !turn.decision) throw new AppFailure('search_source_changed');
    return withSearch(body, turn.mode === 'auto' && saved.permitted);
  }
  delete(sessionId: string) {
    this.db.prepare('DELETE FROM chat_search_context WHERE session_id=?').run(sessionId);
    this.db.prepare('DELETE FROM search_router_attempts WHERE user_message_id IN (SELECT user_message_id FROM search_turns WHERE session_id=?)').run(sessionId);
    this.db.prepare('DELETE FROM search_turns WHERE session_id=?').run(sessionId);
  }
}
