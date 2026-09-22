/** Keep a text position, not a pixel scrollTop, across a font reflow. No selection mutation. */
export function readingAnchor(viewport: HTMLElement, content: HTMLElement) {
  const top = viewport.getBoundingClientRect().top, bottom = top + viewport.clientHeight;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    const bounds = range.getBoundingClientRect();
    if (!bounds.height || bounds.bottom <= top || bounds.top >= bottom) continue;
    // Anchor a fully visible line: a clipped line can change which character
    // counts as visible on every step, accumulating drift during repeated clicks.
    let lo = 0, hi = node.textContent.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      range.setStart(node, mid); range.setEnd(node, mid + 1);
      if (range.getBoundingClientRect().top < top) lo = mid + 1; else hi = mid;
    }
    range.setStart(node, lo); range.setEnd(node, lo + 1);
    const y = range.getBoundingClientRect().top;
    if (y < top || y >= bottom) continue;
    return () => { if (node.isConnected) viewport.scrollTop += range.getBoundingClientRect().top - y; };
  }
  return () => {};
}
