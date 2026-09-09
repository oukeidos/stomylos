import { forwardRef, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';

// Keep tooltips outside clipped toolbars, scrolling panes and transformed dialogs.
export const IconButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<'button'> & {
  label: string; icon: Parameters<typeof Icon>[0]['name']; tooltip?: string;
}>(function IconButton({ label, icon, tooltip = label, children, className = '', onKeyDown, onPointerEnter, onPointerLeave, onFocus, onBlur, ...props }, ref) {
  const id = useId(); const tip = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [hovered, setHovered] = useState(false); const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const visible = (hovered || focused) && !dismissed && !props.disabled;
  useLayoutEffect(() => {
    if (!visible || !anchor || !tip.current) return;
    const place = () => {
      const node = tip.current;
      if (!node) return;
      const bounds = anchor.getBoundingClientRect();
      const { width, height } = node.getBoundingClientRect();
      const margin = 8; const gap = 6;
      node.style.left = `${Math.max(margin, Math.min(bounds.left + (bounds.width - width) / 2, window.innerWidth - width - margin))}px`;
      const below = bounds.bottom + gap;
      node.style.top = `${Math.max(margin, Math.min(below + height <= window.innerHeight - margin ? below : bounds.top - gap - height, window.innerHeight - height - margin))}px`;
    };
    const dismiss = () => setDismissed(true);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    place();
    const observer = new ResizeObserver(place); observer.observe(anchor); observer.observe(tip.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', dismiss, true);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('pointerdown', dismiss, true);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', place);
      window.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('pointerdown', dismiss, true);
    };
  }, [visible, anchor, tooltip]);
  return <><button {...props} ref={ref} type="button" className={`icon-button labeled-icon ${className}`} aria-label={label} aria-describedby={id}
    onPointerEnter={event => { setAnchor(event.currentTarget); setHovered(true); setDismissed(false); onPointerEnter?.(event); }}
    onPointerLeave={event => { setHovered(false); onPointerLeave?.(event); }}
    onFocus={event => { setAnchor(event.currentTarget); setFocused(true); setDismissed(false); onFocus?.(event); }}
    onBlur={event => { setFocused(false); onBlur?.(event); }}
    onKeyDown={event => { if (event.key === 'Escape') setDismissed(true); onKeyDown?.(event); }}>
    <Icon name={icon} />{children}
  </button>{createPortal(<span ref={tip} id={id} role="tooltip" className="icon-tooltip" style={{ visibility: visible ? 'visible' : 'hidden' }}>{tooltip}</span>, document.body)}</>;
});
