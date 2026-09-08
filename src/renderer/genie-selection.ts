// Read-only textareas do not consistently expose caret navigation on Linux.
// Provide keyboard range selection without ever editing the original snapshot.
export function moveGenieSelection(text: string, start: number, end: number, direction: string,
  key: string, extend: boolean, control = false): { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null {
  if (control && key.toLowerCase() === 'a') return { start: 0, end: text.length, direction: 'forward' };
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key) || (control && key.startsWith('Arrow'))) return null;
  const anchor = direction === 'backward' ? end : start, focus = direction === 'backward' ? start : end;
  const boundaries = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map(s => s.index).concat(text.length);
  let next: number;
  if (key === 'Home') next = control || focus === 0 ? 0 : text.lastIndexOf('\n', focus - 1) + 1;
  else if (key === 'End') { const i = text.indexOf('\n', focus); next = control || i < 0 ? text.length : i; }
  else if (!extend && start !== end) next = key === 'ArrowLeft' ? start : end;
  else next = key === 'ArrowLeft' ? boundaries.findLast(i => i < focus) ?? 0 : boundaries.find(i => i > focus) ?? text.length;
  if (!extend) return { start: next, end: next, direction: 'none' };
  return { start: Math.min(anchor, next), end: Math.max(anchor, next), direction: next < anchor ? 'backward' : 'forward' };
}
export function sourceOffset(text: string, displayOffset: number): number {
  let source = 0, display = 0;
  while (source < text.length && display < displayOffset) {
    source += text[source] === '\r' && text[source + 1] === '\n' ? 2 : 1; display++;
  }
  return source;
}
export function displayOffset(text: string, source: number): number { return text.slice(0, source).replace(/\r\n?/g, '\n').length; }
