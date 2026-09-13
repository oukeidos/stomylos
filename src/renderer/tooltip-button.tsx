import { forwardRef, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { createPortal } from 'react-dom';

// One tooltip owns discovery at a time. Only navigation keys authorize focus
// discovery; clicks, activation and dialog/menu focus restoration never do.
let dismissActive: (() => void) | undefined;
let navigating = false;
let users = 0;
function listen() {
  if (++users > 1) return;
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('pointerdown', dismiss, true);
  window.addEventListener('click', dismiss, true);
  window.addEventListener('blur', dismiss);
  window.addEventListener('scroll', dismiss, true);
  window.addEventListener('focusin', focusin, true);
}
function unlisten() {
  if (--users) return;
  window.removeEventListener('keydown', keydown, true);
  window.removeEventListener('pointerdown', dismiss, true);
  window.removeEventListener('click', dismiss, true);
  window.removeEventListener('blur', dismiss);
  window.removeEventListener('scroll', dismiss, true);
  window.removeEventListener('focusin', focusin, true);
  dismiss();
}
function dismiss() { navigating = false; dismissActive?.(); dismissActive = undefined; }
function focusin() { dismissActive?.(); dismissActive = undefined; }
function keydown(event: KeyboardEvent) {
  dismiss();
  navigating = ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key);
  // Native focus traversal happens within this event's task. Later focus returns
  // (including animated dialog closure) must not inherit the navigation intent.
  if (navigating) setTimeout(() => { navigating = false; }, 0);
}

export const TooltipButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<'button'> & {
  tooltip?: string;
}>(function TooltipButton({ tooltip, title, children, onPointerEnter, onPointerLeave, onFocus, onBlur, ...props }, ref) {
  const id = useId();
  const tip = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const origin = useRef<'hover' | 'focus' | null>(null);
  const hide = useRef(() => { origin.current = null; setAnchor(null); }).current;
  const text = tooltip ?? title;
  const show = (node: HTMLButtonElement, source: 'hover' | 'focus') => {
    if (!text || node.disabled || node.closest('[inert]')) return;
    dismissActive?.(); dismissActive = hide;
    origin.current = source; setAnchor(node);
  };
  useLayoutEffect(() => { listen(); return () => { if (dismissActive === hide) dismiss(); unlisten(); }; }, [hide]);
  useLayoutEffect(() => { if (props.disabled || !text) { if (dismissActive === hide) dismiss(); else hide(); } }, [props.disabled, text, hide]);
  useLayoutEffect(() => {
    if (!anchor || !tip.current) return;
    let frame: number;
    const place = () => {
      if (!anchor.isConnected || anchor.disabled || anchor.closest('[hidden], [inert], [aria-hidden="true"]') || !anchor.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        if (dismissActive === hide) dismiss(); else hide();
        return;
      }
      const node = tip.current;
      if (!node) return;
      const bounds = anchor.getBoundingClientRect();
      const { width, height } = node.getBoundingClientRect();
      const margin = 8, gap = 6;
      node.style.left = `${Math.max(margin, Math.min(bounds.left + (bounds.width - width) / 2, window.innerWidth - width - margin))}px`;
      const below = bounds.bottom + gap;
      node.style.top = `${Math.max(margin, Math.min(below + height <= window.innerHeight - margin ? below : bounds.top - gap - height, window.innerHeight - height - margin))}px`;
      // Also observe CSS/ancestor changes and moving dialogs without keeping
      // observers on every inactive button in a long history list.
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [anchor, text, hide]);
  return <><button {...props} ref={ref} aria-describedby={[props['aria-describedby'], text ? id : undefined].filter(Boolean).join(' ') || undefined}
    onPointerEnter={event => { if (event.pointerType !== 'touch') show(event.currentTarget, 'hover'); onPointerEnter?.(event); }}
    onPointerLeave={event => { if (origin.current === 'hover') { if (dismissActive === hide) dismiss(); else hide(); } onPointerLeave?.(event); }}
    onFocus={event => { if (navigating) show(event.currentTarget, 'focus'); onFocus?.(event); }}
    onBlur={event => { if (dismissActive === hide) dismissActive = undefined; hide(); onBlur?.(event); }}>
    {children}
  </button>{text && createPortal(<span ref={tip} id={id} role="tooltip" className="icon-tooltip" style={{ visibility: anchor && !props.disabled ? 'visible' : 'hidden' }}>{text}</span>, document.body)}</>;
});
