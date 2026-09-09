import { AppFailure } from './errors';
export function validatePatternCommand(name: string, args: unknown) {
  const fail = () => { throw new AppFailure('invalid_command'); };
  if (['patternState', 'patternClose', 'patternRetrySave'].includes(name)) { if (args !== undefined) fail(); return; }
  if (name === 'patternPreview') { if (args !== undefined) validateSelection(args); return; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail();
  const a = args as Record<string, unknown>;
  const keys = name === 'patternCreate' ? ['fingerprint', 'operationId', ...(Object.hasOwn(a, 'selection') ? ['selection'] : [])] : name === 'patternList' ? ['offset'] : name === 'patternRetry' ? ['id', 'operationId'] : ['id'];
  if (Object.keys(a).length !== keys.length || keys.some(k => !Object.hasOwn(a, k))) return fail();
  for (const key of keys) {
    if (key === 'selection') { validateSelection(a[key]); }
    else if (key === 'offset') { if (!Number.isSafeInteger(a[key]) || (a[key] as number) < 0 || (a[key] as number) > 1_000_000) fail(); }
    else if (key === 'fingerprint') { if (typeof a[key] !== 'string' || !/^[a-f0-9]{64}$/.test(a[key] as string)) fail(); }
    else if (typeof a[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(a[key] as string)) fail();
  }
}

function validateSelection(value: unknown) {
  const bad = () => { throw new AppFailure('invalid_command'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  const s = value as Record<string, unknown>;
  if (Object.keys(s).sort().join(',') !== 'excludeCovered,from,timezone,to' || typeof s.excludeCovered !== 'boolean' ||
      typeof s.from !== 'string' || typeof s.to !== 'string' || typeof s.timezone !== 'string' || s.timezone.length > 100 ||
      !Number.isFinite(Date.parse(s.from)) || !Number.isFinite(Date.parse(s.to)) || Date.parse(s.from) >= Date.parse(s.to)) bad();
}
