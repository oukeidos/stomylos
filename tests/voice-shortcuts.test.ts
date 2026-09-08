import { afterEach, describe, expect, it, vi } from 'vitest';
import { installVoiceShortcuts, VoiceKeyCycles } from '../src/renderer/voice-shortcuts';

const event = (key = 'F8', overrides = {}) => ({ key, repeat: false, isComposing: false, keyCode: 0, ...overrides });
describe('voice shortcut physical key ownership', () => {
  it('requires release before a second action even if repeat is incorrectly false', () => {
    const keys = new VoiceKeyCycles();
    expect(keys.press(event())).toBe(true);
    for (let n = 0; n < 30; n++) expect(keys.press(event('F8', { repeat: n % 2 === 0 }))).toBe(false);
    keys.release('F8'); expect(keys.press(event())).toBe(true);
  });
  it('does not reinterpret an IME-owned key when composition ends while it is held', () => {
    const keys = new VoiceKeyCycles(); keys.composing = true;
    expect(keys.press(event())).toBe(false);
    keys.composing = false;
    expect(keys.press(event())).toBe(false);
    keys.release('F8'); expect(keys.press(event())).toBe(true);
  });
  it.each([{ isComposing: true }, { keyCode: 229 }])('honors the native composition fallback %j', flags => {
    const keys = new VoiceKeyCycles();
    expect(keys.press(event('Escape', flags))).toBe(false);
    expect(keys.press(event('Escape'))).toBe(false);
    keys.release('Escape'); expect(keys.press(event('Escape'))).toBe(true);
  });
  it('prevents a held dialog Escape from cancelling capture on the next repeat', () => {
    const keys = new VoiceKeyCycles();
    expect(keys.press(event('Escape'))).toBe(true); // Dialog owns first press.
    expect(keys.press(event('Escape', { repeat: true }))).toBe(false);
    keys.release('Escape'); expect(keys.press(event('Escape'))).toBe(true);
  });
  it('clears a missing keyup on blur without accepting OS repeats on return', () => {
    const keys = new VoiceKeyCycles(); keys.press(event()); keys.composing = true; keys.blur();
    expect(keys.composing).toBe(false);
    expect(keys.press(event('F8', { repeat: true }))).toBe(false);
    keys.release('F8'); expect(keys.press(event())).toBe(true);
  });
});

// Drive the installed production listeners in capture/target/bubble order. The
// native driver separately exercises real DOM focus, Radix and Electron events.
function listeners() {
  class Field {
    constructor(readonly composer = false) {}
    closest() { return this; }
    matches() { return this.composer; }
  }
  const capture = new Map<string, Function[]>(), bubble = new Map<string, Function[]>();
  const doc = { hidden: false, focused: true, overlay: false, activeElement: new Field(true),
    hasFocus() { return this.focused; }, querySelector() { return this.overlay ? {} : null; },
    addEventListener(type: string, fn: Function, first = false) {
      const map = first ? capture : bubble; map.set(type, [...map.get(type) ?? [], fn]);
    } };
  vi.stubGlobal('Element', Field); vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  const actions = { toggle: vi.fn(), cancel: vi.fn(() => true) };
  installVoiceShortcuts(actions);
  return { doc, actions, field: () => new Field(),
    dispatch(key: string, options = {}, local?: (e: any) => void) {
      const e = { ...event(key), target: doc.activeElement, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...options };
      for (const fn of capture.get('keydown') ?? []) { fn(e); if (e.stopped) return e; }
      local?.(e);
      if (!e.stopped) for (const fn of bubble.get('keydown') ?? []) { fn(e); if (e.stopped) break; }
      for (const fn of capture.get('keyup') ?? []) fn({ key });
      return e;
    }
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('installed voice shortcut routing', () => {
  it('acts only in a focused visible conversation document', () => {
    const h = listeners(); h.doc.focused = false; h.dispatch('F8');
    h.doc.focused = true; h.doc.hidden = true; h.dispatch('F8');
    expect(h.actions.toggle).not.toHaveBeenCalled();
    h.doc.hidden = false; h.dispatch('F8'); expect(h.actions.toggle).toHaveBeenCalledOnce();
  });
  it('does not start in other text fields, Genie or a dialog', () => {
    const h = listeners(); h.dispatch('F8', { target: h.field() });
    h.doc.overlay = true; h.dispatch('F8');
    expect(h.actions.toggle).not.toHaveBeenCalled();
  });
  it('does not cancel capture when the dialog disappears during the same Esc event', () => {
    const h = listeners(); h.doc.overlay = true;
    h.dispatch('Escape', {}, () => { h.doc.overlay = false; });
    expect(h.actions.cancel).not.toHaveBeenCalled();
    h.dispatch('Escape'); expect(h.actions.cancel).toHaveBeenCalledOnce();
  });
  it('lets a local field claim Esc before the capture handler', () => {
    const h = listeners(); h.dispatch('Escape', {}, e => e.preventDefault());
    expect(h.actions.cancel).not.toHaveBeenCalled();
  });
  it('keeps IME Escape away from dialog handlers without preventing the native default', () => {
    const h = listeners(); h.doc.overlay = true; const dialog = vi.fn();
    const e = h.dispatch('Escape', { isComposing: true }, dialog);
    expect(dialog).not.toHaveBeenCalled(); expect(e.defaultPrevented).toBe(false);
    expect(h.actions.cancel).not.toHaveBeenCalled();
  });
});
