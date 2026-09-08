import { AppFailure } from './errors';
export function validateExplainCommand(name: string, args: unknown) {
  const bad = () => { throw new AppFailure('invalid_command'); };
  if (name === 'explainClose') { if (args !== undefined) bad(); return; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return bad();
  const a = args as Record<string, any>;
  const fields = name === 'explainRetry' ? ['id'] : name === 'explainList' ? ['sessionId'] : name === 'explainHistory' ? ['sessionId', 'messageId'] : ['sessionId', 'messageId', 'source', 'start', 'end'];
  if (Object.keys(a).length !== fields.length || fields.some(k => !Object.hasOwn(a, k))) bad();
  for (const k of fields.filter(k => ['id','sessionId','messageId'].includes(k))) if (typeof a[k] !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(a[k])) bad();
  if (name === 'explainOpen' && (typeof a.source !== 'string' || Buffer.byteLength(a.source) > 256_000 || !Number.isSafeInteger(a.start) || !Number.isSafeInteger(a.end) || a.start < 0 || a.end <= a.start || a.end > a.source.length)) bad();
}
