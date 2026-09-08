import type { VoiceId } from './voice';
import type { ExplainCommandArgs, ExplainCommandResults } from './explain';
import type { PatternCommandArgs, PatternCommandResults } from './pattern-report';
import type { GenieCommandArgs, GenieCommandResults } from './genie';
export type Role = 'router' | 'chat' | 'grammar';
export type Json = Record<string, any>;
export type OpeningKind = 'starter' | 'user';
export interface Message {
  id: string; session_id: string; sequence: number; role: 'user' | 'assistant';
  content: string; origin: 'learner' | 'starter' | 'model';
  delivery: 'complete' | 'streaming' | 'interrupted'; request_id: string | null;
}
export interface Session {
  id: string; state: 'draft' | 'active' | 'ended'; starter_id: string | null; starter_version: string | null;
  starter_text: string | null; created_at: string; ended_at: string | null; draft: string;
  opening_kind: OpeningKind; opening_revision: number; parked_starter: string | null; last_opening_operation: string | null;
  manual_character: string | null; character: string | null; model: string | null;
  chat_config: string; grammar_config: string | null; source_hash: string | null;
  analysis_state: 'none' | 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  selected_analysis_id: string | null;
  search_mode: import('./search').SearchMode;
}
export interface RequestRecord {
  id: string; session_id: string; role: Role; parent_id: string | null;
  status: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'interrupted';
  created_at: string; dispatched_at: string | null; finished_at: string | null;
  source_sequence: number; source_hash: string; config: string; config_hash: string;
  response_content: string | null; metadata: string; failure: string | null;
}
export interface GrammarUnit {
  source_message_id: string; ordinal: number; text: string; corrected_text: string;
  explanation: string; changed: number; warnings: string; evidence_status: 'unreviewed';
}
export interface PartnerView {
  revision: number; currentCharacter: string | null; currentModel: string | null;
  pending: { id: string; choice: string | null; state: string } | null;
  canRetryReply: boolean; canUseSelected: boolean; retryModel: string | null;
}
export interface RenewalAttempt {
  id: string; job_id: string; parent_id: string | null; status: RequestRecord['status']; created_at: string;
  dispatched_at: string | null; finished_at: string | null; response_content: string | null;
  metadata: string; failure: string | null; accepted_count: number;
}
export interface RenewalJob {
  id: string; session_id: string; created_at: string; source_sequence: number; source_hash: string;
  source_messages: string; input_json: string; input_hash: string; config: string; config_hash: string; model: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted'; selected_attempt_id: string | null;
}
export interface RenewalView {
  id: string; state: RenewalJob['state']; model: string; created_at: string; accepted_count: number;
  attempts: Omit<RenewalAttempt, 'response_content'>[];
}
export interface SessionView { endProcessing?: Json | null; partner: PartnerView; bookmarked: boolean; canBookmark: boolean; session: Session; messages: Message[]; requests: RequestRecord[]; units: GrammarUnit[]; renewal: RenewalView | null; intentions?: import('./intention').IntentionView; outdatedOpening?: boolean; memory: import('./memory').MemoryView; search?: import('./search').SearchView | null; searches?: import('./search').SearchView[] }
export type SessionSummary = Pick<Session, 'id' | 'state' | 'starter_text' | 'created_at' | 'analysis_state'> & { title: string; bookmarked: boolean; canBookmark: boolean };
export type HistoryFilter = 'all' | 'bookmarked';
export interface SessionPage { sessions: SessionSummary[]; hasMore: boolean; offset: number; filter: HistoryFilter }
export interface DeletionAssets { speechKeys: string[]; dictationIds: string[] }
export interface Starter { id: string; text: string; version: string }
export interface Character { id: string; label: string; description: string; model: string; reasoning?: Json }
export interface Settings { keyPresent: boolean; keyPath: string; dataPath: string; appVersion: string; development: boolean; simulation?: boolean; credentials?: import('./credentials').KeyStatus }
export interface Activity {
  sessionId: string | null; requestId: string | null; phase: 'idle' | 'preparing' | 'routing' | 'reply';
  streamingMessageId: string | null; streamingText: string;
  storageError: string | null; error: string | null; closing: boolean;
  deletionCleanupPending?: boolean;
}
export interface AppSnapshot { endBlockers?: { sessionId: string; title: string }[]; endBlocker?: string | null; revision: number; sessions: SessionSummary[]; historyHasMore: boolean; unfinished: SessionSummary | null; activity: Activity; settings: Settings; characters: Character[] }
export interface SpeechItem { assetKey?: string; attemptId?: string; voice?: VoiceId; messageId: string; sessionId: string; state: 'queued' | 'generating' | 'ready' | 'failed' | 'cancelled' | 'interrupted' | 'save_pending' | 'evicted'; error?: string; audioId?: string }
export interface SpeechRecovery { assetKey: string; attemptId: string; voice: VoiceId; sessionId?: string; messageId?: string }
export interface SpeechPreview { state: SpeechItem['state']; error?: string; audioId?: string; assetKey: string; attemptId?: string }
export interface SpeechSnapshot { voice: VoiceId; selectionRevision: number; preview: SpeechPreview | null; recoveries: SpeechRecovery[]; revision: number; mode: 'manual' | 'automatic'; warning: string | null; cacheBytes: number; items: SpeechItem[] }
export type AppEvent = { type: 'usage-changed' } | { type: 'explain'; record: import('./explain').ExplainRecord } | { type: 'pattern'; snapshot: import('./pattern-report').PatternState } | { type: 'genie'; snapshot: import('./genie').GenieSnapshot } | { type: 'dictation'; snapshot: import('./asr').DictationSnapshot } |
  { type: 'memory-changed'; characterId: string; revision: number } |
  { type: 'dictation-interrupt' } | { type: 'speech'; snapshot: SpeechSnapshot } |
  { type: 'speech-preview-play'; audioId: string; selectionRevision: number; token: number } |
  { type: 'speech-play'; selectionRevision?: number; audioId: string; sessionId: string; messageId: string; token: number; automatic: boolean } |
  { type: 'speech-preview-stop' } |
  { type: 'speech-stop'; automaticOnly: boolean } | { type: 'snapshot'; snapshot: AppSnapshot } |
  { type: 'stream'; revision: number; sessionId: string; requestId: string; messageId: string; text: string } |
  { type: 'session-changed'; revision: number; sessionId: string } |
  { type: 'session-deleted'; revision: number; sessionId: string } |
  { type: 'close-requested'; revision: number };
export interface CommandArgs extends ExplainCommandArgs, GenieCommandArgs, PatternCommandArgs {
  usageSnapshot: undefined;
  usageBudget: { amount: string | null };
  asrSnapshot: undefined;
  asrContext: { sessionId: string };
  asrBegin: { id: string; sessionId: string; text: string; revision: number };
  asrChunk: { id: string; sequence: number; pcm: Int16Array };
  asrFinish: { id: string; reason: 'manual' | 'time' | 'size' | 'interrupted' };
  asrTranscribe: { id: string };
  asrCancel: { id: string; discard: boolean };
  asrRetrySave: { id: string };
  asrInserted: { id: string; sessionId: string; revision: number; text: string };
  speechSnapshot: undefined;
  speechVoice: { voice: VoiceId };
  speechPreview: { token: number; retry: boolean };
  speechPreviewStop: undefined;
  speechRecover: { assetKey: string; attemptId: string };
  speechMode: { mode: 'manual' | 'automatic' };
  speechContext: { sessionId: string; token: number };
  speechListen: { sessionId: string; messageId: string; token: number; retry: boolean; assetKey?: string; attemptId?: string };
  speechRetrySave: { sessionId: string; messageId: string };
  speechStop: undefined;
  speechClear: undefined;
  currentMemory: undefined;
  snapshot: undefined;
  listSessions: { offset: number; filter?: HistoryFilter };
  setSessionBookmark: { sessionId: string; bookmarked: boolean };
  loadSession: { sessionId: string };
  saveDraft: { sessionId: string; text: string; revision: number; dictationIds?: string[] };
  replaceStarter: { sessionId: string; operationId: string; expectedQuestionId: string; expectedRevision?: number };
  setOpening: { sessionId: string; operationId: string; expectedRevision: number; kind: OpeningKind };
  changePartner: { sessionId: string; character: string | null; operationId: string; expectedRevision: number };
  useSelectedPartner: { sessionId: string };
  retryPartnerSelection: { sessionId: string };
  selectPartner: { sessionId: string; character: string | null };
  searchMode: { sessionId: string; mode: import('./search').SearchMode };
  sendMessage: { sessionId: string; text: string; revision: number; dictationIds?: string[] };
  retryReply: { sessionId: string };
  endSession: { sessionId: string; command?: boolean };
  deleteSession: { sessionId: string };
  retryDeletionCleanup: undefined;
  newSession: undefined;
  retryAnalysis: { sessionId: string };
  retryStarterRenewal: { sessionId: string };
  retryIntentionQuestions: { sessionId: string };
  retryMemory: { sessionId: string };
  continueEnd: { sessionId: string };
  cancelEnd: { sessionId: string };
  skipMemory: { sessionId: string };
  retrySaving: undefined;
  backupExport: undefined;
  backupRestore: undefined;
  refreshKey: undefined;
  manageKey: import('./credentials').KeyAction;
  close: undefined;
}
export interface CommandResults extends ExplainCommandResults, GenieCommandResults, PatternCommandResults {
  usageSnapshot: import('./usage').UsageSnapshot;
  usageBudget: import('./usage').UsageSnapshot;
  asrSnapshot: import('./asr').DictationSnapshot; asrContext: void; asrBegin: void;
  asrChunk: import('./asr').DictationProgress; asrFinish: void; asrTranscribe: void;
  asrCancel: void; asrRetrySave: void; asrInserted: void;
  speechSnapshot: SpeechSnapshot; speechVoice: void; speechPreview: void; speechPreviewStop: void; speechRecover: void; speechMode: void; speechContext: void; speechListen: void; speechRetrySave: void; speechStop: void; speechClear: void;
  currentMemory: import('./memory').MemoryDocument;
  snapshot: AppSnapshot; listSessions: SessionPage; loadSession: SessionView;
  changePartner: void; useSelectedPartner: void; retryPartnerSelection: void;
  saveDraft: { revision: number }; replaceStarter: void; selectPartner: void; searchMode: void;
  setOpening: { revision: number };
  sendMessage: void; retryReply: void; endSession: void; newSession: string;
  setSessionBookmark: { sessionId: string; bookmarked: boolean; revision: number };
  deleteSession: void; retryDeletionCleanup: void;
  retryAnalysis: void; retryStarterRenewal: void; retryIntentionQuestions: void; retrySaving: void; refreshKey: void; close: boolean;
  backupExport: import('./backup').BackupResult;
  backupRestore: import('./backup').BackupResult;
  manageKey: void;
  continueEnd: void; cancelEnd: void; retryMemory: void; skipMemory: void;
}
export interface DesktopApi {
  command<K extends keyof CommandArgs>(name: K, args: CommandArgs[K]): Promise<CommandResults[K]>;
  subscribe(listener: (event: AppEvent) => void): () => void;
}
declare global { interface Window { stomylos: DesktopApi } }
