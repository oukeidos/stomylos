export type ReplyMode = 'standard' | 'one_point';
export interface ReplyContextView {
  mode: ReplyMode;
  revision: number;
  canChange: boolean;
  lockReason: 'started' | 'ended' | null;
}
