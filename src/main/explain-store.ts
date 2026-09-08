import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { ExplainRecord, ExplainSource, ExplainTarget } from '../shared/explain';
import type { Json, Message } from '../shared/types';
import { AppFailure } from './errors';
import { explainBody, explainRange } from './explain';
const now = () => new Date().toISOString();
export class ExplainStore {
  constructor(private db: Database.Database) {}
  private decode(row: any): ExplainRecord { if (!row) throw new AppFailure('explain_missing'); const { source_json, request_body: _body, metadata: _meta, ...record } = row; return { ...record, source: JSON.parse(source_json) }; }
  get(id: string): ExplainRecord { return this.decode(this.db.prepare('SELECT * FROM explanations WHERE id=?').get(id)); }
  list(sessionId: string): ExplainRecord[] { return this.db.prepare('SELECT * FROM explanations WHERE session_id=? ORDER BY created_at,id').all(sessionId).map(r => this.decode(r)); }
  prepare(target: ExplainTarget): ExplainRecord {
    return this.db.transaction(() => {
      const message = this.db.prepare('SELECT * FROM messages WHERE id=? AND session_id=?').get(target.messageId, target.sessionId) as Message | undefined;
      if (!message || message.role !== 'assistant' || message.delivery !== 'complete' || message.content !== target.source) throw new AppFailure('explain_stale');
      explainRange(message.content, target.start, target.end);
      const previous = this.db.prepare('SELECT * FROM messages WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT 1').get(target.sessionId, message.sequence) as Message | undefined;
      const source: ExplainSource = { preceding_message: previous?.role === 'user' ? previous.content : null, full_passage: message.content,
        selected_text: message.content.slice(target.start, target.end), selection: { start: target.start, end: target.end, offset_unit: 'utf16' } };
      const body = explainBody(source), key = createHash('sha256').update(JSON.stringify(source)).digest('hex');
      const existing = this.db.prepare('SELECT * FROM explanations WHERE session_id=? AND message_id=? AND target_key=?').get(target.sessionId, target.messageId, key);
      if (existing) return this.decode(existing);
      const id = randomUUID();
      this.db.prepare("INSERT INTO explanations(id,session_id,message_id,target_key,source_json,request_body,state,created_at) VALUES(?,?,?,?,?,?,'interrupted',?)").run(id, target.sessionId, target.messageId, key, JSON.stringify(source), JSON.stringify(body), now());
      return this.get(id);
    })();
  }
  start(id: string): { record: ExplainRecord; attempt: string; body: Json } {
    return this.db.transaction(() => {
      const record = this.get(id); if (record.state === 'ready' || record.state === 'pending') throw new AppFailure('explain_busy');
      const attempt = randomUUID();
      this.db.prepare("INSERT INTO explanation_attempts(id,explanation_id,state,created_at) VALUES(?,?,'pending',?)").run(attempt, id, now());
      this.db.prepare("UPDATE explanations SET state='pending',revision=revision+1,failure=NULL WHERE id=?").run(id);
      const row = this.db.prepare('SELECT request_body FROM explanations WHERE id=?').get(id) as { request_body: string };
      return { record: this.get(id), attempt, body: JSON.parse(row.request_body) };
    })();
  }
  finish(id: string, attempt: string, content: string | null, metadata: Json, failure: string | null): ExplainRecord {
    return this.db.transaction(() => {
      const record = this.get(id);
      if (record.state === 'ready') return record; // Lost acknowledgement must not generate again.
      const a = this.db.prepare('SELECT state FROM explanation_attempts WHERE id=? AND explanation_id=?').get(attempt, id) as { state: string } | undefined;
      if (!a || a.state !== 'pending') throw new AppFailure('explain_stale');
      const state = content !== null ? 'ready' : failure === 'request_cancelled' ? 'interrupted' : 'failed';
      this.db.prepare('UPDATE explanation_attempts SET state=?,content=?,metadata=?,failure=?,finished_at=? WHERE id=?').run(state, content, JSON.stringify(metadata), failure, now(), attempt);
      this.db.prepare('UPDATE explanations SET revision=revision+1,state=?,content=?,metadata=?,failure=? WHERE id=?').run(state, content, JSON.stringify(metadata), failure, id);
      return this.get(id);
    })();
  }
  recover() { this.db.prepare("UPDATE explanations SET revision=revision+1,state='interrupted',failure='request_cancelled' WHERE state='pending'").run(); this.db.prepare("UPDATE explanation_attempts SET state='interrupted',failure='request_cancelled',finished_at=? WHERE state='pending'").run(now()); }
}
