import { AppFailure } from './errors';
export function validateGenieCommand(name: string, args: unknown) {
  const bad = () => { throw new AppFailure('invalid_command'); };
  if (name === 'genieSnapshot') { if (args !== undefined) bad(); return; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return bad();
  const a = args as Record<string, any>, fields: string[] = [];
  const id = (key: string) => { fields.push(key); if (typeof a[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(a[key])) bad(); };
  if (name === 'genieOpen') id('sessionId');
  else if (name === 'genieUndo') id('undoId');
  else id('episodeId');
  if (['genieOpen', 'genieSubmit', 'genieRetry', 'genieTarget', 'genieApply', 'genieUndo'].includes(name)) id('operationId');
  if (name === 'genieApply') id('candidateId');
  if (['genieOpen', 'genieDraft', 'genieSubmit', 'genieApply', 'genieUndo'].includes(name)) {
    fields.push('revision'); if (!Number.isSafeInteger(a.revision) || a.revision < 0) bad();
  }
  if (['genieOpen', 'genieDraft', 'genieSubmit'].includes(name)) {
    fields.push('text'); if (typeof a.text !== 'string' || Buffer.byteLength(a.text) > (name === 'genieOpen' ? 100_000 : 8_000)) bad();
  }
  if (['genieOpen', 'genieTarget'].includes(name)) {
    fields.push('range'); const r = a.range;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length !== 4 ||
        !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end < r.start || r.end > 100_000 ||
        !['forward', 'backward', 'none'].includes(r.direction) || !['draft', 'selection'].includes(r.scope)) bad();
  }
  if (Object.keys(a).length !== fields.length || fields.some(k => !Object.hasOwn(a, k))) bad();
}
