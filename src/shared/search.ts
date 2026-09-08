import type { Json, RequestRecord } from './types';

export type SearchMode = 'auto' | 'off';
export type SearchDecision = 'off' | 'primary' | 'fallback' | 'router_unavailable';
export interface SearchTurn {
  user_message_id: string; session_id: string; mode: SearchMode; input: string; input_hash: string;
  config: string; config_hash: string; created_at: string;
  decision: SearchDecision | null; permitted: number | null;
}
export interface SearchAttempt {
  id: string; user_message_id: string; ordinal: number; status: RequestRecord['status'];
  config: string; config_hash: string; created_at: string; dispatched_at: string | null;
  finished_at: string | null; response_content: string | null; metadata: string; failure: string | null;
}
export interface SearchView { turn: SearchTurn; attempts: SearchAttempt[] }
export interface SearchSource { url: string; title: string }
export interface SearchStreamOptions {
  search?: boolean;
  timeoutMs?: number;
  gate?: boolean;
  evidence?: (metadata: Json) => void;
}
