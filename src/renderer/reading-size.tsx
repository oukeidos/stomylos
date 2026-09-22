import { useSyncExternalStore } from 'react';

// Presentation-only, device-local preference, alongside library-open in the
// isolated Electron profile; never part of chat, report or inference records.
const key = 'reading-size.v1';
const sizes = [14, 16, 18, 20, 22];
export const readingWillChange = 'stomylos-reading-will-change';
export const readingDidChange = 'stomylos-reading-did-change';
let state = { size: 16, error: false };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function initializeReadingSize() {
  try {
    const saved = localStorage.getItem(key);
    const size = saved === null ? 16 : Number(saved);
    state = { size: sizes.includes(size) ? size : 16, error: false };
  } catch { state = { size: 16, error: true }; }
  document.documentElement.style.setProperty('--reading-scale', String(state.size / 16));
}

function changeSize(size: number) {
  if (!sizes.includes(size)) return;
  window.dispatchEvent(new Event(readingWillChange));
  document.documentElement.style.setProperty('--reading-scale', String(size / 16));
  let error = false;
  try { localStorage.setItem(key, String(size)); } catch { error = true; }
  state = { size, error };
  // Composer reflow and scroll restoration happen synchronously before paint.
  window.dispatchEvent(new Event(readingDidChange));
  listeners.forEach(listener => listener());
}

export function ReadingSizeSetting() {
  const { size, error } = useSyncExternalStore(subscribe, () => state);
  return <section className="setting reading-setting" aria-label="Text size">
    <strong>Text size</strong>
    <p className="note">Adjust conversation, writing and learning text. Menus and separate HTML reports keep their size.</p>
    <div className="reading-size-controls">
      <button aria-label="Decrease text size" disabled={size === 14} onClick={() => changeSize(size - 2)}>−</button>
      <output aria-live="polite" aria-label="Conversation text size">{size}px{size === 16 ? ' · Default' : ''}</output>
      <button aria-label="Increase text size" disabled={size === 22} onClick={() => changeSize(size + 2)}>+</button>
      <button disabled={size === 16 && !error} onClick={() => changeSize(16)}>Reset to default</button>
    </div>
    <p className="reading-preview">A little space to read, think and write.</p>
    {error && <p role="alert" className="note">This size could not be saved on this computer. <button onClick={() => changeSize(size)}>Retry saving text size</button></p>}
  </section>;
}
