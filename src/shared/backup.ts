export interface BackupSummary { createdAt: string; appVersion: string; schemaVersion: number; conversations: number }
export interface BackupResult { path?: string; restored?: boolean }
