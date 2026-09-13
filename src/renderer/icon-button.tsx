import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { Icon } from './icons';
import { TooltipButton } from './tooltip-button';

export const IconButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<'button'> & {
  label: string; icon: Parameters<typeof Icon>[0]['name']; tooltip?: string;
}>(function IconButton({ label, icon, tooltip = label, children, className = '', ...props }, ref) {
  return <TooltipButton {...props} ref={ref} type="button" className={`icon-button labeled-icon ${className}`} aria-label={label} tooltip={tooltip}>
    <Icon name={icon} />{children}
  </TooltipButton>;
});
