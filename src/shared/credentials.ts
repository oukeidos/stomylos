export type KeyMode = 'auto' | 'env' | 'disabled';
export type KeyAction = { action: 'save'; key: string } | { action: 'import' } | { action: 'delete' } | { action: 'mode'; mode: KeyMode };
export interface KeyStatus {
  mode: KeyMode;
  source: 'secure' | 'env' | 'none' | 'test';
  saved: boolean;
  secureAvailable: boolean;
  problem: string | null;
}

export function validApiKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value) && !/[$`]/.test(value);
}
