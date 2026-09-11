export interface ColdMemory {
  id: string;
  text: string;
  text_hash: string;
  source_order: number;
  item_index: number;
  source_message_id: string | null;
  source_session_id: string | null;
  observed_at: string | null;
  edited_at: string | null;
  archived_at: string;
  origin: 'legacy' | 'add' | 'manual';
  time_basis: 'source_message' | 'manual_edit' | 'unknown';
  archive_revision: number;
}

export interface ColdPage {
  items: ColdMemory[];
  total: number;
  next: number | null;
  revision: number;
}

export interface ColdStatus {
  originals: number;
  pending: number;
  ready: number;
  failed: number;
  groups: number;
  excluded: number;
  oversized: number;
  storageWarning: boolean;
  indexingFailure: string | null;
}
