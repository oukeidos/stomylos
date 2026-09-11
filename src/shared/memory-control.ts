export interface MemoryPreference { enabled: boolean; revision: number }
export interface MemoryPolicy { firstEnabled: boolean | null; updatesDisabled: boolean }
export const memoryControlVersion = 'stomylos_memory_control_v1';
