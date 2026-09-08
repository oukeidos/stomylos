export interface GenieRange { start: number; end: number; direction: 'forward' | 'backward' | 'none'; scope: 'draft' | 'selection' }
export interface GenieSource {
  sessionId: string; text: string; revision: number; contextHash: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}
export interface GenieReply { reply: string; suggested_text: string | null }
export interface GenieTurn {
  id: string; user: string | null; reply: GenieReply | null;
  status: 'waiting' | 'ready' | 'failed' | 'interrupted'; error: string | null;
}
export interface GenieDraftResult { sessionId: string; text: string; revision: number; range: GenieRange }
export interface GenieUndo { id: string; sessionId: string; text: string; revision: number }
export interface GenieEpisode {
  id: string; sessionId: string; open: boolean; source: GenieSource; range: GenieRange;
  phase: 'waiting' | 'ready' | 'failed' | 'interrupted' | 'saving';
  turns: GenieTurn[]; candidateId: string | null; followup: string; followupRevision: number;
  attempts: { id: string; status: string; error: string | null; cost: number | null }[];
}
export interface GenieSnapshot { revision: number; episode: GenieEpisode | null; undo: GenieUndo | null; draftResult: GenieDraftResult | null }
export const genieCommands = ['genieSnapshot', 'genieOpen', 'genieDraft', 'genieSubmit', 'genieRetry', 'genieCancel', 'genieClose', 'genieTarget', 'genieApply', 'genieUndo'] as const;
export interface GenieCommandArgs {
  genieSnapshot: undefined;
  genieOpen: { sessionId: string; text: string; revision: number; range: GenieRange; operationId: string };
  genieDraft: { episodeId: string; text: string; revision: number };
  genieSubmit: { episodeId: string; text: string; revision: number; operationId: string };
  genieRetry: { episodeId: string; operationId: string };
  genieCancel: { episodeId: string };
  genieClose: { episodeId: string };
  genieTarget: { episodeId: string; range: GenieRange; operationId: string };
  genieApply: { episodeId: string; candidateId: string; revision: number; operationId: string };
  genieUndo: { undoId: string; revision: number; operationId: string };
}
export interface GenieCommandResults {
  genieSnapshot: GenieSnapshot; genieOpen: GenieSnapshot; genieDraft: void;
  genieSubmit: void; genieRetry: void; genieCancel: void; genieClose: void;
  genieTarget: GenieSnapshot; genieApply: GenieDraftResult; genieUndo: GenieDraftResult;
}
