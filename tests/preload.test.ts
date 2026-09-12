import { expect, it, vi } from 'vitest';
import type { DesktopApi } from '../src/shared/types';
import { validateCommand } from '../src/main/ipc';

const bridge = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: bridge.exposeInMainWorld },
  ipcRenderer: { invoke: bridge.invoke, on: bridge.on, removeListener: bridge.removeListener }
}));

it('forwards grammar cancellation through the exposed bridge and preserves failures', async () => {
  await import('../src/preload/index');
  expect(bridge.exposeInMainWorld).toHaveBeenCalledWith('stomylos', expect.any(Object));
  const api = bridge.exposeInMainWorld.mock.calls[0][1] as DesktopApi;
  const args = { sessionId: 'grammar-session' };
  bridge.invoke.mockImplementation(async (channel, name, value) => {
    expect(channel).toBe('stomylos:command');
    validateCommand(name, value);
    return { ok: true };
  });
  await expect(api.command('cancelAnalysis', args)).resolves.toBeUndefined();
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith('stomylos:command', 'cancelAnalysis', args);
  bridge.invoke.mockResolvedValueOnce({ ok: false, error: 'database_worker_stopped' });
  await expect(api.command('cancelAnalysis', args)).rejects.toThrow('database_worker_stopped');
  bridge.invoke.mockClear();
  await expect((api.command as Function)('unsupportedTestOperation', undefined)).rejects.toThrow('invalid_command');
  expect(bridge.invoke).not.toHaveBeenCalled();
});
