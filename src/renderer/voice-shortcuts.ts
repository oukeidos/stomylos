/** One key cycle has one owner, including keys consumed by IME or a dialog. */
export class VoiceKeyCycles {
  private held = new Set<string>();
  composing = false;
  release(key: string) { this.held.delete(key); }
  blur() { this.held.clear(); this.composing = false; }
  press(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'isComposing' | 'keyCode'>) {
    const repeated = event.repeat || this.held.has(event.key);
    this.held.add(event.key);
    return !repeated && !this.composing && !event.isComposing && event.keyCode !== 229;
  }
}

export const voiceOverlay = '[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"][data-state="open"]';
export const voiceComposer = 'textarea[data-voice-composer]';

export function installVoiceShortcuts(actions: { toggle: () => void; cancel: () => boolean }) {
  const keys = new VoiceKeyCycles();
  const captureEscapes = new WeakSet<KeyboardEvent>();
  document.addEventListener('compositionstart', () => { keys.composing = true; }, true);
  document.addEventListener('compositionend', () => { keys.composing = false; }, true);
  window.addEventListener('blur', () => keys.blur());
  document.addEventListener('keyup', event => keys.release(event.key), true);
  document.addEventListener('keydown', event => {
    if (!['F8', 'Escape'].includes(event.key) || !document.hasFocus() || document.hidden) return;
    if (!keys.press(event)) {
      // Preserve native IME defaults, but don't let the same Esc dismiss a dialog.
      event.stopImmediatePropagation(); return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (document.querySelector(voiceOverlay)) return;
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      // Run after field handlers so local Escape ownership takes precedence.
      captureEscapes.add(event);
      return;
    }
    const target = event.target instanceof Element ? event.target : document.activeElement;
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') && !target.matches(voiceComposer)) return;
    event.preventDefault(); event.stopImmediatePropagation(); actions.toggle();
  }, true);
  document.addEventListener('keydown', event => {
    if (!captureEscapes.has(event) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      !document.hasFocus() || document.hidden || document.querySelector(voiceOverlay)) return;
    if (actions.cancel()) { event.preventDefault(); event.stopImmediatePropagation(); }
  });
}
