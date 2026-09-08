export class AppFailure extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'AppFailure'; }
}
export function failureCode(error: unknown): string {
  if (error instanceof AppFailure) return error.code;
  return 'operation_failed';
}
