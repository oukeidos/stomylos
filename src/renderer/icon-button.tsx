import { forwardRef, useId, useState, type ComponentPropsWithoutRef } from 'react';
import { Icon } from './icons';

// The label is available to keyboard users without expanding the toolbar.
export const IconButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<'button'> & {
  label: string; icon: Parameters<typeof Icon>[0]['name']; tooltip?: string;
}>(function IconButton({ label, icon, tooltip = label, children, className = '', onKeyDown, onPointerEnter, onFocus, ...props }, ref) {
  const id = useId(); const [dismissed, setDismissed] = useState(false);
  return <button {...props} ref={ref} type="button" className={`icon-button labeled-icon ${className}`} aria-label={label} aria-describedby={id}
    data-tooltip-dismissed={dismissed || undefined}
    onPointerEnter={event => { setDismissed(false); onPointerEnter?.(event); }}
    onFocus={event => { setDismissed(false); onFocus?.(event); }}
    onKeyDown={event => { if (event.key === 'Escape') setDismissed(true); onKeyDown?.(event); }}>
    <Icon name={icon} />{children}<span id={id} role="tooltip" className="icon-tooltip">{tooltip}</span>
  </button>;
});
