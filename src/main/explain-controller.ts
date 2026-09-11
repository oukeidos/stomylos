import type { DatabaseClient } from './db-client';
import type { Gateway } from './transport';
import type { ExplainRecord, ExplainTarget } from '../shared/explain';
import type { Json } from '../shared/types';
import { AppFailure, failureCode } from './errors';
import { explainIdentity } from './explain';
interface Flight { record: ExplainRecord; attempt: string; abort: AbortController; active: boolean }
export class ExplainController {
  get backupBusy() { return this.flights.size > 0 || this.unsaved.size > 0; }
  visible = false;
  private flights = new Map<string, Flight>();
  private unsaved = new Map<string, { record: ExplainRecord; attempt: string; content: string | null; metadata: Json; failure: string | null }>();
  constructor(private db: DatabaseClient, private gateway: Gateway, private emit: (record: ExplainRecord) => void, private canGenerate: () => boolean) {}
  async list(sessionId: string) {
    return (await this.db.call('explainList', sessionId)).map(r => this.unsaved.get(r.id)?.record ?? this.flights.get(r.id)?.record ?? r);
  }
  async open(target: ExplainTarget) {
    this.visible = true;
    const saved = await this.db.call('explainPrepare', target);
    const record = this.unsaved.get(saved.id)?.record ?? this.flights.get(saved.id)?.record ?? saved;
    if (record.state === 'interrupted' && !record.failure) return this.generate(record.id);
    return record;
  }
  async history(sessionId: string, messageId: string) { this.visible = true; return (await this.list(sessionId)).filter(r => r.message_id === messageId); }
  closeDialog() { this.visible = false; }
  async retry(id: string) {
    const pending = this.unsaved.get(id);
    if (pending) {
      const record = await this.db.call('explainFinish', id, pending.attempt, pending.content, pending.metadata, pending.failure);
      this.unsaved.delete(id); this.emit(record); return record;
    }
    const record = await this.db.call('explainGet', id);
    if (record.state === 'ready') return record;
    return this.generate(id);
  }
  private async generate(id: string): Promise<ExplainRecord> {
    const current = this.flights.get(id); if (current) return current.record;
    if (!this.canGenerate()) throw new AppFailure('api_key_missing');
    const started = await this.db.call('explainStart', id);
    const flight: Flight = { ...started, abort: new AbortController(), active: true };
    this.flights.set(id, flight); this.emit(flight.record);
    void (async () => {
      let content: string | null = null, metadata: Json = {}, failure: string | null = null;
      try {
        const routed = await this.db.call('prepareProvider', 'explain', started.attempt, started.body, explainIdentity);
        const result = await this.gateway.complete(routed.body, routed.identity!, flight.abort.signal, 90_000);
        if (!result.content.trim()) throw new AppFailure('explain_empty');
        content = result.content; metadata = result.metadata;
      } catch (error) { failure = failureCode(error); }
      if (!flight.active) return;
      try {
        const record = await this.db.call('explainFinish', id, flight.attempt, content, metadata, failure);
        if (flight.active) this.emit(record);
      } catch {
        if (flight.active) {
          const record: ExplainRecord = { ...flight.record, revision: flight.record.revision + 1, state: 'unsaved', content, failure: 'explain_save' };
          this.unsaved.set(id, { record, attempt: flight.attempt, content, metadata, failure }); this.emit(record);
        }
      } finally { this.flights.delete(id); }
    })();
    return flight.record;
  }
  async dispose(sessionId?: string) {
    this.visible = false;
    for (const flight of this.flights.values()) if (!sessionId || flight.record.session_id === sessionId) { flight.active = false; flight.abort.abort(); }
    for (const [id, flight] of this.flights) {
      if (sessionId && flight.record.session_id !== sessionId) continue;
      flight.active = false; flight.abort.abort(); this.flights.delete(id);
      await this.db.call('explainFinish', id, flight.attempt, null, {}, 'request_cancelled').catch(() => undefined);
    }
    for (const [id, pending] of this.unsaved) if (!sessionId || pending.record.session_id === sessionId) this.unsaved.delete(id);
  }
}
