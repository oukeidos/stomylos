import type Database from 'better-sqlite3';
import type { Json } from '../shared/types';
import { readMessageTime } from './time-context';
import { memoryHash } from './memory-updater';
import { datedBlock, validDate, type ConversationDates } from './conversation-dates';
import { AppFailure } from './errors';

/** Read provenance only. Never change extraction inputs, notes or embedding text. */
export function memoryReportedOn(db: Database.Database, id: string): string {
  const meta = (db.prepare('SELECT * FROM memory_item_metadata WHERE id=?').get(id)
    ?? db.prepare('SELECT * FROM cold_memories WHERE id=?').get(id)) as Json | undefined;
  if (!meta || meta.origin !== 'add' || meta.edited_at) return 'unknown';
  let ids: string[];
  if (meta.source_message_id) ids = [meta.source_message_id];
  else {
    const job = db.prepare('SELECT j.session_id,c.projection,c.projection_hash FROM memory_add_jobs j JOIN memory_source_checkpoints c ON c.job_id=j.ordinal WHERE j.ordinal=? AND j.source_kind=\'session\'').get(meta.source_order) as Json | undefined;
    if (!job || job.session_id !== meta.source_session_id || !job.projection || memoryHash(job.projection) !== job.projection_hash) return 'unknown';
    const entry = (JSON.parse(job.projection) as Json[]).find(item => item.item_index === meta.item_index);
    if (!entry || !Array.isArray(entry.source_message_ids) || !entry.source_message_ids.length) return 'unknown';
    ids = entry.source_message_ids;
  }
  const dates: string[] = [];
  for (const messageId of ids) {
    const message = db.prepare('SELECT role,origin,session_id FROM messages WHERE id=?').get(messageId) as Json | undefined;
    if (!message || message.session_id !== meta.source_session_id) return 'unknown';
    if (message.role !== 'user' || message.origin !== 'learner') continue;
    const date = readMessageTime(db, messageId)?.local_date;
    if (!date) return 'unknown';
    dates.push(date);
  }
  dates.sort();
  return !dates.length ? 'unknown' : dates[0] === dates.at(-1) ? dates[0] : `${dates[0]}/${dates.at(-1)}`;
}

export function conversationDates(db: Database.Database, session: string, snapshot: Json): ConversationDates {
  const hot = snapshot.memory_context?.database_records ?? [], cold = snapshot.cold_recollections?.items ?? [];
  const saved = db.prepare('SELECT context,context_hash FROM session_date_contexts WHERE session_id=?').get(session) as {context:string;context_hash:string} | undefined;
  let frozen: { started_on: string; dates: Record<string, string> };
  if (saved) {
    if (memoryHash(saved.context) !== saved.context_hash) throw new AppFailure('conversation_dates_changed');
    frozen = JSON.parse(saved.context);
  } else {
    const started_on = snapshot.time_context.sources[0]?.sent_time?.local_date;
    if (!validDate(started_on)) throw new AppFailure('message_time_missing');
    frozen = { started_on, dates: Object.fromEntries([...hot, ...cold].map(item => [item.id, memoryReportedOn(db, item.id)])) };
    const json = JSON.stringify(frozen);
    // An unsent Memory-Off preparation must not freeze an empty memory snapshot.
    if (snapshot.memory_context) db.prepare('INSERT INTO session_date_contexts VALUES(?,?,?)').run(session, json, memoryHash(json));
  }
  const associative = snapshot.associative_recall?.items ?? [];
  const dates = Object.fromEntries(associative.map((item: {id:string}) => [item.id, frozen.dates[item.id] ?? memoryReportedOn(db, item.id)]));
  return { started_on: frozen.started_on, hot: datedBlock(hot, frozen.dates, 'hot'), cold: datedBlock(cold, frozen.dates, 'cold'), associative: datedBlock(associative, dates, 'associative') };
}
