import type Database from 'better-sqlite3';
import type { MemoryPolicy, MemoryPreference } from '../shared/memory-control';
export function memoryPreference(db: Database.Database): MemoryPreference {
  const row = db.prepare('SELECT enabled,revision FROM memory_preferences WHERE id=1').get() as {enabled:number;revision:number};
  return {enabled:!!row.enabled,revision:row.revision};
}
export function memoryPolicy(db: Database.Database, id: string): MemoryPolicy {
  const row = db.prepare('SELECT first_enabled,updates_disabled FROM session_memory_policy WHERE session_id=?').get(id) as {first_enabled:number;updates_disabled:number}|undefined;
  // Earlier associative admission could write this row before any chat dispatch.
  // Read actual dispatch evidence without rewriting historical requests or rows.
  const first = db.prepare(`SELECT config FROM model_requests WHERE session_id=? AND role='chat'
    AND dispatched_at IS NOT NULL ORDER BY rowid LIMIT 1`).get(id) as {config:string}|undefined;
  return {firstEnabled:first ? !!JSON.parse(first.config).memory_context : null,
    updatesDisabled:!!first && !!row?.updates_disabled};
}
export function memoryReadAllowed(db: Database.Database,id:string) { return memoryPreference(db).enabled && memoryPolicy(db,id).firstEnabled !== false; }
export function memoryWriteAllowed(db: Database.Database,id:string) { return memoryReadAllowed(db,id) && !memoryPolicy(db,id).updatesDisabled; }
