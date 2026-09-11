export const memoryCategories = ['traits', 'relationships', 'experiences', 'intentions'] as const;
export type MemoryCategory = typeof memoryCategories[number];
export interface MemoryItem { id: string; text: string }
export type MemoryDocument = { character_id: string; revision: number } & Record<MemoryCategory, MemoryItem[]>;
export interface FlatMemoryDocument { character_id: string; revision: number; database_records: MemoryItem[] }
export type StoredMemoryDocument = MemoryDocument | FlatMemoryDocument;
export type FlatMemoryPacket = Omit<MemoryPacket, 'current_memory'> & { current_memory: FlatMemoryDocument };
export const isFlatMemory = (doc: StoredMemoryDocument): doc is FlatMemoryDocument => Object.hasOwn(doc, 'database_records');
export interface MemoryOperation { op: 'add' | 'update' | 'delete'; id: string | null; category: MemoryCategory | null; text: string | null; source_message_ids: string[] }
export interface MemoryPacket {
  current_memory: MemoryDocument;
  session: { id: string; character_id: string; ended_at: string; timezone: string;
    messages: { id: string; role: string; origin: string; delivery: string; content: string; sent_time?: import('./time').RecordedTime | null }[] };
  limits: { max_items: number; max_item_chars: number; max_bytes: number };
}
export interface MemoryJob {
  ordinal: number; session_id: string; character_id: string; source: string; source_hash: string;
  config: string; config_hash: string; created_at: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'skipped';
  selected_attempt_id: string | null;
}
export interface MemoryAttempt {
  id: string; job_id: number; parent_id: string | null; input_json: string; input_hash: string;
  status: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'interrupted';
  created_at: string; dispatched_at: string | null; finished_at: string | null;
  response_content: string | null; result: string | null; metadata: string; failure: string | null;
}
export interface MemoryAddAttemptView {
  id: string; job_id: number; message_id: string;
  status: 'queued' | 'dispatched' | 'received' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
  created_at: string; model: string; reasoning: string | null; metadata: string; failure: string | null;
}
export interface MemoryView {
  addAttempts?: MemoryAddAttemptView[];
  addJobs?: import('./types').Json[];
  cleanup?: { state: string; before: StoredMemoryDocument; after: StoredMemoryDocument | null; beforeChars: number; afterChars: number | null; attempts: import('./types').Json[] } | null;
  changes: MemoryChanges | null;
  current: StoredMemoryDocument | null; snapshot: StoredMemoryDocument | null;
  job: Pick<MemoryJob, 'state' | 'created_at' | 'character_id'> | null;
  blockedBy: string | null;
  attempts: Omit<MemoryAttempt, 'input_json' | 'response_content' | 'result'>[];
}
export interface MemoryChangeValue { category?: MemoryCategory; text: string }
export type MemoryChange =
  | { id: string; kind: 'added'; before: null; after: MemoryChangeValue }
  | { id: string; kind: 'updated'; before: MemoryChangeValue; after: MemoryChangeValue }
  | { id: string; kind: 'deleted'; before: MemoryChangeValue; after: null };
export type MemoryChanges = { status: 'unavailable' } | {
  status: 'ready'; scope: 'shared' | 'character'; appliedAt: string;
  beforeRevision: number; afterRevision: number; items: MemoryChange[];
};
