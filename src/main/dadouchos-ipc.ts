import { AppFailure } from './errors';
export function validateDadouchosCommand(name: string, args: unknown) {
  const bad = () => { throw new AppFailure('invalid_command'); };
  if (name === 'dadouchosSnapshot') { if (args !== undefined) bad(); return; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return bad();
  const keys = ['sessionId', ...(['dadouchosOpen','dadouchosRetry'].includes(name) ? ['operationId'] : [])];
  const values = args as Record<string, unknown>;
  if (Object.keys(values).length !== keys.length || keys.some(k => typeof values[k] !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(values[k] as string))) bad();
}
