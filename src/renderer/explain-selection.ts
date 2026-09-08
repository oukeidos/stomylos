// Keep rendered Markdown selectable while carrying original UTF-16 source positions.
export function explainPositions() {
  return (tree: any) => {
    const walk = (node: any, parentPosition?: any) => {
      const position = node.position ?? parentPosition;
      if (!node.children) return;
      node.children = node.children.map((child: any) => {
        if ((child.type === 'text' || child.type === 'raw') && (child.position || node.tagName === 'code')) {
          const p = child.position ?? position;
          if (typeof p.start?.offset === 'number' && typeof p.end?.offset === 'number') return {
            type: 'element', tagName: 'span', properties: { 'data-source-start': p.start.offset, 'data-source-end': p.end.offset }, children: [{ ...child, type: 'text' }]
          };
        }
        walk(child, position); return child;
      });
    };
    walk(tree);
  };
}
function offsets(source: string, text: string, base: number): { starts: number[]; ends: number[] } | null {
  const at = source.indexOf(text);
  if (at >= 0) return { starts: Array.from({ length: text.length }, (_, i) => base + at + i), ends: Array.from({ length: text.length }, (_, i) => base + at + i + 1) };
  let decoded = ''; const starts: number[] = [], ends: number[] = [];
  for (let i = 0; i < source.length;) {
    const start = i; let value = source[i++];
    if (value === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/u.test(source[i] ?? '')) value = source[i++];
    else if (value === '&') {
      const entity = source.slice(start).match(/^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z]+);/u)?.[0];
      if (entity) { const decoder = document.createElement('textarea'); decoder.innerHTML = entity; value = decoder.value; i = start + entity.length; }
    } else if (value === '\r') { if (source[i] === '\n') i++; value = '\n'; }
    decoded += value; for (let j = 0; j < value.length; j++) { starts.push(base + start); ends.push(base + i); }
  }
  const index = decoded.indexOf(text);
  return index < 0 ? null : { starts: starts.slice(index, index + text.length), ends: ends.slice(index, index + text.length) };
}
export function captureExplainSelection(root: HTMLElement, source: string, selection = window.getSelection()) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const prefix = range.cloneRange(); prefix.selectNodeContents(root); prefix.setEnd(range.startContainer, range.startOffset);
  const from = prefix.toString().length; prefix.setEnd(range.endContainer, range.endOffset); const to = prefix.toString().length;
  let count = 0, start: number | null = null, end: number | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '', next = count + text.length;
    if (next > from && count < to) {
      const span = node.parentElement?.closest<HTMLElement>('[data-source-start]');
      if (!span) { if (!text.trim()) { count = next; continue; } return null; }
      const base = Number(span.dataset.sourceStart), stop = Number(span.dataset.sourceEnd);
      const mapping = offsets(source.slice(base, stop), text, base); if (!mapping) return null;
      const a = Math.max(0, from - count), b = Math.min(text.length, to - count);
      if (start === null) start = mapping.starts[a]; end = mapping.ends[b - 1];
    }
    count = next;
  }
  if (start === null || end === null || end <= start || !source.slice(start, end).trim()) return null;
  return { start, end, rect: range.getBoundingClientRect() };
}
