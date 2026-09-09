export interface PatternUnit {
  source_id: string; original: string; corrected: string; explanation: string;
  message_id: string; ordinal: number;
}
export interface PatternSource {
  session_id: string; analysis_id: string | null; evidence_kind?: 'grammar' | 'learner'; ended_at: string; source_hash: string;
  units: PatternUnit[];
}
export interface PatternSelection {
  from: string; to: string; timezone: string; excludeCovered: boolean;
}
export interface PatternScope {
  selection?: PatternSelection; covered?: number; inputCost?: number; longContext?: boolean;
  asOf: string; cutoff: string; count: number; records: number; from: string | null; to: string | null;
  eligible: number; excluded: { unavailable: number; older: number; overCount: number; overBudget: number };
  estimate: number; estimator: string; limit: number;
}
export interface PatternPreview {
  fingerprint: string; scope: PatternScope; blocked: 'insufficient' | 'input_limit' | null;
  existingId: string | null;
  unavailableSessions: { id: string; ended_at: string; state: string }[];
}
export type PatternStatus = 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface PatternAttempt {
  id: string; report_id: string; parent_id: string | null; status: PatternStatus;
  request: string; request_hash: string; created_at: string; dispatched_at: string | null;
  finished_at: string | null; html: string | null; html_hash: string | null; metadata: string; failure: string | null;
}
export interface PatternCard {
  cost?: number | null;
  id: string; created_at: string; scope: PatternScope; status: PatternStatus;
  selected_attempt_id: string | null; last_attempt_id: string; failure: string | null;
}
export interface PatternDetail extends PatternCard {
  sources: (PatternSource & { deleted: boolean })[];
  attempts: Omit<PatternAttempt, 'html' | 'request'>[];
  model: string; canRetry: boolean;
}
export interface PatternState {
  revision: number; reportId: string | null; phase: 'idle' | 'generating' | 'saving';
  startedAt: string | null; error: string | null;
}
export const patternCommands = ['patternPreview', 'patternCreate', 'patternList', 'patternDetail', 'patternOpen', 'patternClose',
  'patternCancel', 'patternRetry', 'patternRetrySave', 'patternDelete', 'patternState', 'patternRelated'] as const;
export interface PatternCommandArgs {
  patternRelated: { id: string };
  patternPreview: PatternSelection | undefined; patternState: undefined; patternClose: undefined; patternRetrySave: undefined;
  patternCreate: { fingerprint: string; operationId: string; selection?: PatternSelection };
  patternList: { offset: number }; patternDetail: { id: string }; patternOpen: { id: string };
  patternCancel: { id: string }; patternRetry: { id: string; operationId: string }; patternDelete: { id: string };
}
export interface PatternCommandResults {
  patternRelated: { reports: PatternCard[]; total: number };
  patternPreview: PatternPreview; patternState: PatternState; patternClose: void; patternRetrySave: void;
  patternCreate: { id: string; reused: boolean }; patternList: { reports: PatternCard[]; hasMore: boolean };
  patternDetail: PatternDetail; patternOpen: void; patternCancel: void; patternRetry: void; patternDelete: void;
}
