import type Database from 'better-sqlite3';
import type { FlatMemoryDocument } from '../shared/memory';
import { AppFailure } from './errors';
/** FIFO position must match canonical JSON; metadata never enters prompts. */
export function validateMemoryMetadata(db:Database.Database,document:FlatMemoryDocument) {
  const ids=(db.prepare('SELECT id FROM memory_item_metadata ORDER BY source_order,item_index').all() as {id:string}[]).map(r=>r.id);
  if(JSON.stringify(ids)!==JSON.stringify(document.database_records.map(r=>r.id)))throw new AppFailure('memory_metadata_mismatch');
}
