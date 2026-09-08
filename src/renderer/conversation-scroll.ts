import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const tolerance = 2;

/** Reader intent survives content growth and delayed events from our own scrolls. */
export function useConversationScroll(sessionId: string | null) {
  const scroller = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const generation = useRef(0);
  const readerDown = useRef(false);
  const session = useRef(sessionId);
  const schedule = useRef(() => {});
  const [position, setPosition] = useState({ away: false, unread: false });
  const pause = useCallback(() => {
    generation.current++;
    readerDown.current = false;
    following.current = false;
    schedule.current();
  }, []);
  const resume = useCallback(() => {
    following.current = true;
    schedule.current();
  }, []);
  // Capture before IPC. A later reader gesture or session switch wins over its acknowledgement.
  const afterAcceptedAction = useCallback(() => {
    const requestedSession = session.current;
    const requestedGeneration = generation.current;
    return () => {
      if (session.current === requestedSession && generation.current === requestedGeneration) resume();
    };
  }, [resume]);

  useLayoutEffect(() => {
    session.current = sessionId;
    generation.current++;
    following.current = true;
    setPosition({ away: false, unread: false });
    const node = scroller.current, body = content.current;
    if (!node || !body || !sessionId) return;
    let frame = 0;
    let dragging = false;
    let lastTop = node.scrollTop;
    let lastMaximum = Math.max(0, node.scrollHeight - node.clientHeight);
    let seenReply = '';
    const maximum = () => Math.max(0, node.scrollHeight - node.clientHeight);
    const update = () => {
      frame = 0;
      const bottom = maximum();
      if (following.current && !dragging) {
        node.scrollTop = bottom;
        // Remember the actual clamped target before the browser dispatches scroll.
        lastTop = node.scrollTop;
        lastMaximum = bottom;
      }
      const replies = body.querySelectorAll<HTMLElement>('[data-message-origin="model"]');
      const reply = replies.item(replies.length - 1);
      const signature = reply ? `${reply.dataset.messageId}:${reply.querySelector('.assistant-markdown')?.textContent ?? ''}` : '';
      const away = !following.current && bottom - node.scrollTop > tolerance;
      if (!away) seenReply = signature;
      const unread = away && signature !== seenReply;
      setPosition(previous => previous.away === away && previous.unread === unread ? previous : { away, unread });
    };
    const queue = () => { if (!frame) frame = requestAnimationFrame(update); };
    schedule.current = queue;
    const scroll = () => {
      const top = node.scrollTop, bottom = maximum();
      const clamped = lastTop > bottom && top >= bottom - tolerance && bottom < lastMaximum;
      if (top < lastTop - 1 && !clamped) pause();
      else if (!dragging && readerDown.current && top > lastTop + 1 && bottom - top <= tolerance) resume();
      lastTop = top;
      lastMaximum = bottom;
      queue();
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && node.scrollTop > 0) pause();
      else if (event.deltaY > 0) readerDown.current = true;
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
      if ((event.target as Element).closest('input, textarea, select, button, [contenteditable="true"]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) pause();
      else if (['ArrowDown', 'PageDown', 'End'].includes(event.key) || event.key === ' ') readerDown.current = true;
    };
    const pointer = (event: PointerEvent) => {
      const rect = node.getBoundingClientRect();
      if (event.target === node && event.clientX >= rect.left + node.clientLeft + node.clientWidth) {
        dragging = true;
        pause();
      }
    };
    const release = () => {
      if (!dragging) return;
      dragging = false;
      if (maximum() - node.scrollTop <= tolerance) resume();
      else queue();
    };
    const scrollEnd = () => { readerDown.current = false; };
    node.addEventListener('scroll', scroll, { passive: true });
    node.addEventListener('scrollend', scrollEnd);
    node.addEventListener('wheel', wheel, { passive: true });
    node.addEventListener('keydown', key);
    node.addEventListener('pointerdown', pointer);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    const resize = new ResizeObserver(queue);
    resize.observe(body);
    resize.observe(node);
    // Text can arrive without changing height. It must still expose an unread reply.
    const mutation = new MutationObserver(queue);
    mutation.observe(body, { subtree: true, childList: true, characterData: true });
    update();
    return () => {
      schedule.current = () => {};
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      node.removeEventListener('scroll', scroll);
      node.removeEventListener('scrollend', scrollEnd);
      node.removeEventListener('wheel', wheel);
      node.removeEventListener('keydown', key);
      node.removeEventListener('pointerdown', pointer);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, [sessionId, pause, resume]);

  return { scroller, content, pause, resume, afterAcceptedAction, ...position };
}
