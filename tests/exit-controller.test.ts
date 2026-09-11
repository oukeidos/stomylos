import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExitController, type ExitHooks, type ExitChoice } from '../src/main/exit-controller';
import { validateCommand } from '../src/main/ipc';
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
let hooks: ExitHooks;
beforeEach(() => {
  vi.useFakeTimers();
  hooks = { prepare: vi.fn(), cancel: vi.fn(), finishPreparation: vi.fn(async () => true),
    failed: () => false, choose: vi.fn(async () => 'stay' as ExitChoice),
    copy: vi.fn(async () => 'Copied available text.'), teardown: vi.fn(async () => undefined), exit: vi.fn() };
});
afterEach(() => vi.useRealTimers());
it('closes normally once without a recovery dialog', async () => {
  const exits = new ExitController(hooks); exits.request(); exits.request();
  expect(hooks.prepare).toHaveBeenCalledExactlyOnceWith(1, false);
  await exits.prepared(1, 'ready'); await vi.advanceTimersByTimeAsync(10_000);
  expect(hooks.choose).not.toHaveBeenCalled(); expect(hooks.exit).toHaveBeenCalledTimes(1);
});
it('offers an immediate exit for failed storage and bounds hung teardown', async () => {
  hooks.failed = () => true; hooks.choose = vi.fn(async () => 'exit' as ExitChoice);
  hooks.teardown = vi.fn(() => new Promise<void>(() => {}));
  const exits = new ExitController(hooks); exits.request(); await vi.advanceTimersByTimeAsync(0);
  expect(hooks.prepare).not.toHaveBeenCalled(); expect(exits.exiting).toBe(true);
  await vi.advanceTimersByTimeAsync(1999); expect(hooks.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(hooks.exit).toHaveBeenCalledTimes(1);
});
it('never exits automatically when a renderer is missing and deduplicates close clicks', async () => {
  const choice = deferred<ExitChoice>(); hooks.choose = vi.fn(() => choice.promise);
  const exits = new ExitController(hooks); exits.request(); await vi.advanceTimersByTimeAsync(5000);
  exits.request(); exits.request(true); expect(hooks.choose).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(50_000); expect(hooks.exit).not.toHaveBeenCalled();
  choice.resolve('stay'); await vi.advanceTimersByTimeAsync(0);
  await exits.prepared(1, 'ready'); expect(hooks.finishPreparation).not.toHaveBeenCalled();
});
it('ignores late save completion after Stay and permits another close', async () => {
  const save = deferred<boolean>(); hooks.finishPreparation = vi.fn(() => save.promise);
  const exits = new ExitController(hooks); exits.request(); void exits.prepared(1, 'ready');
  await vi.advanceTimersByTimeAsync(5000); save.resolve(true); await vi.advanceTimersByTimeAsync(0);
  expect(hooks.exit).not.toHaveBeenCalled();
  hooks.finishPreparation = vi.fn(async () => true); exits.request();
  const id = vi.mocked(hooks.prepare).mock.calls.at(-1)![0]; await exits.prepared(id, 'ready');
  expect(hooks.exit).toHaveBeenCalledTimes(1);
});
it('ordinary leave cancellation clears the timeout', async () => {
  const exits = new ExitController(hooks); exits.request(); await exits.prepared(1, 'cancelled');
  await vi.advanceTimersByTimeAsync(9000); expect(hooks.choose).not.toHaveBeenCalled(); expect(hooks.exit).not.toHaveBeenCalled();
});
it('copy failure updates the same dialog without preventing exit', async () => {
  hooks.copy = vi.fn(async () => { throw new Error('clipboard failed'); });
  hooks.choose = vi.fn(async copy => { expect(await copy()).toBe('Copy could not be confirmed'); return 'exit' as ExitChoice; });
  const exits = new ExitController(hooks); exits.request(true); await vi.advanceTimersByTimeAsync(0);
  expect(hooks.choose).toHaveBeenCalledTimes(1); expect(hooks.exit).toHaveBeenCalledTimes(1);
});
it('validates recovery IPC and rejects extra or oversized text fields', () => {
  expect(() => validateCommand('exitOptions', undefined)).not.toThrow();
  expect(() => validateCommand('exitPrepared', { id: 1, outcome: 'blocked' })).not.toThrow();
  expect(() => validateCommand('exitCopyText', { id: 1, text: 'Draft' })).not.toThrow();
  for (const [name, value] of [ ['exitOptions', {}], ['exitPrepared', { id: 1, outcome: 'exit' }],
    ['exitPrepared', { id: 0, outcome: 'ready' }], ['exitCopyText', { id: 1, text: 'x', secret: 'x' }],
    ['exitCopyText', { id: 1, text: 'x'.repeat(4_000_001) }] ]) expect(() => validateCommand(name, value)).toThrow('invalid_command');
});

it('a hanging copy does not require reopening the dialog', async () => {
  hooks.copy = vi.fn(() => new Promise<string>(() => {}));
  hooks.choose = vi.fn(async copy => { expect(await copy()).toBe('Copy could not be confirmed'); return 'exit' as ExitChoice; });
  const exits = new ExitController(hooks); exits.request(true);
  await vi.advanceTimersByTimeAsync(3000);
  expect(hooks.choose).toHaveBeenCalledTimes(1); expect(hooks.exit).toHaveBeenCalledTimes(1);
});
