import { useEffect, useId, useState } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { IconButton } from './icon-button';

export type ReplyStyleOptions = { easier: boolean; shorter: boolean; conversational: boolean };

const options = [
  ['easier', 'Easier'],
  ['shorter', 'Shorter'],
  ['conversational', 'Conversational'],
] as const;

// Presentation only. The preview caller owns temporary state; no request or
// preference-storage code belongs here until the prompt contract is selected.
export function ReplyStyleControl({ value, onChange, disabled = false }: {
  value: ReplyStyleOptions; onChange: (value: ReplyStyleOptions) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const title = useId();
  const selected = options.filter(([key]) => value[key]);
  const summary = selected.map(([, label]) => label).join(', ') || 'Default';
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return <Menu.Root modal={false} open={open && !disabled} onOpenChange={setOpen}>
    <Menu.Trigger asChild>
      <IconButton label={`Reply style: ${summary}`} tooltip={`Reply style · ${summary}`} icon="replyStyle"
        className={`reply-style-trigger${selected.length ? ' is-active' : ''}`} disabled={disabled}>
        {selected.length > 0 && <span className="reply-style-count" aria-hidden="true">{selected.length}</span>}
      </IconButton>
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Content className="reply-style-menu" side="top" align="start" alignOffset={-80} sideOffset={12}
        collisionPadding={12} aria-labelledby={title} loop
        onCloseAutoFocus={event => { if (disabled) event.preventDefault(); }}>
        <div className="reply-style-heading">
          <Menu.Label id={title}>Reply style</Menu.Label>
          <IconButton label="Close reply style" icon="close" className="reply-style-close" onClick={() => setOpen(false)} />
        </div>
        {options.map(([key, label]) => <Menu.CheckboxItem key={key}
          className="reply-style-option" checked={value[key]}
          onCheckedChange={checked => onChange({ ...value, [key]: checked === true })}
          onSelect={event => event.preventDefault()}>
          <span>{label}</span><span className="reply-style-switch" aria-hidden="true" />
        </Menu.CheckboxItem>)}
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}
