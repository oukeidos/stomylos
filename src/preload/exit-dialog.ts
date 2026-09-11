import { ipcRenderer } from 'electron';
window.addEventListener('DOMContentLoaded', () => {
  const copy = document.getElementById('copy') as HTMLButtonElement;
  const status = document.getElementById('status')!;
  for (const id of ['stay', 'exit']) document.getElementById(id)!.addEventListener('click', () => ipcRenderer.send('stomylos:exit-dialog', id));
  copy.addEventListener('click', () => { copy.disabled = true; status.textContent = 'Copying…'; ipcRenderer.send('stomylos:exit-dialog', 'copy'); });
  ipcRenderer.on('stomylos:exit-copy-status', (_event, text: string) => { status.textContent = text; copy.disabled = false; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') ipcRenderer.send('stomylos:exit-dialog', 'stay'); });
  document.getElementById('stay')!.focus();
});
