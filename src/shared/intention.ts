import type { Json } from './types';
export interface IntentionJob {
  id: string; item_id: string; epoch: number; text_hash: string; session_id: string | null;
  input_json: string; input_hash: string; config: string; config_hash: string;
  created_at: string; deadline: string; run: number;
  state: 'pending' | 'running' | 'received' | 'accepted' | 'duplicate' | 'failed' | 'interrupted' | 'superseded';
  question_id: string | null;
}
export interface IntentionAttempt {
  id: string; job_id: string; run: number; route: number;
  status: 'dispatched' | 'received' | 'succeeded' | 'failed' | 'interrupted';
  dispatched_at: string; finished_at: string | null; response_content: string | null;
  metadata: string; failure: string | null;
}
export interface StarterPreparation {
  session_id: string; created_at: string; deadline: string; source_hash: string;
  config: string; config_hash: string; state: 'waiting' | 'released'; reason: string | null;
}
export interface IntentionView {
  preparation: Pick<StarterPreparation, 'state' | 'reason' | 'deadline'> | null;
  jobs: { id: string; state: IntentionJob['state']; attempts: Omit<IntentionAttempt, 'response_content'>[] }[];
}
export interface IntentionRoute { parameters: Json; response_identity: Json }
