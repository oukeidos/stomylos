export interface DadouchosSnapshot {
  revision: number; sessionId: string | null; open: boolean;
  phase: 'idle' | 'waiting' | 'ready' | 'failed' | 'interrupted';
  text: string | null; error: string | null;
}
export const dadouchosCommands = ['dadouchosSnapshot', 'dadouchosOpen', 'dadouchosClose', 'dadouchosRetry', 'dadouchosDispose'] as const;
export interface DadouchosCommandArgs {
  dadouchosSnapshot: undefined;
  dadouchosOpen: { sessionId: string; operationId: string };
  dadouchosRetry: { sessionId: string; operationId: string };
  dadouchosClose: { sessionId: string };
  dadouchosDispose: { sessionId: string };
}
export interface DadouchosCommandResults {
  dadouchosSnapshot: DadouchosSnapshot; dadouchosOpen: DadouchosSnapshot;
  dadouchosRetry: DadouchosSnapshot; dadouchosClose: void; dadouchosDispose: void;
}
