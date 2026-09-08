export interface ExplainTarget { sessionId: string; messageId: string; source: string; start: number; end: number }
export interface ExplainSource { preceding_message: string | null; full_passage: string; selected_text: string; selection: { start: number; end: number; offset_unit: 'utf16' } }
export interface ExplainRecord {
  revision: number; id: string; session_id: string; message_id: string; target_key: string; source: ExplainSource;
  state: 'pending' | 'ready' | 'failed' | 'interrupted' | 'unsaved'; content: string | null; failure: string | null; created_at: string;
}
export const explainCommands = ['explainOpen', 'explainHistory', 'explainList', 'explainRetry', 'explainClose'] as const;
export interface ExplainCommandArgs {
  explainOpen: ExplainTarget;
  explainHistory: { sessionId: string; messageId: string };
  explainList: { sessionId: string };
  explainRetry: { id: string };
  explainClose: undefined;
}
export interface ExplainCommandResults {
  explainOpen: ExplainRecord; explainHistory: ExplainRecord[]; explainList: ExplainRecord[]; explainRetry: ExplainRecord; explainClose: void;
}
