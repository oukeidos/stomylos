import { expect, it } from 'vitest';
import { endProcessingState } from '../src/renderer/end-processing-state';
import type { SessionView } from '../src/shared/types';
const view = (state: string, modern = true) => ({ memory: modern ? { addJobs: [] } : {},
  endProcessing: { complete: false, stages: { update: state, cleanup: 'skipped' } } } as unknown as SessionView);

it('does not invent stages before loading', () => {
  expect(endProcessingState(null, true)).toEqual({ rows: [], failed: false, retryable: false });
});
it('keeps automatic Memory handoffs running without retry controls', () => {
  for (const state of ['running', 'pending', 'running']) {
    const result = endProcessingState(view(state), true);
    expect(result.rows).toEqual([{ id: 'update', label: 'Memory', state: 'running' }]);
    expect(result.retryable).toBe(false);
  }
});
it('preserves paused, restored, failed and legacy recovery', () => {
  expect(endProcessingState(view('pending'), false).retryable).toBe(true);
  expect(endProcessingState(view('pending', false), true).retryable).toBe(true);
  for (const state of ['failed', 'interrupted']) {
    expect(endProcessingState(view(state), true)).toMatchObject({ failed: true, retryable: true });
  }
});
it('does not turn finished work back into running', () => {
  const completed = view('completed'); completed.endProcessing!.complete = true;
  expect(endProcessingState(completed, true)).toMatchObject({ retryable: false, rows: [{ state: 'completed' }] });
});
