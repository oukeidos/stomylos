import { expect, it } from 'vitest';
import { historySubtitle } from '../src/renderer/history-subtitle';

it('keeps lifecycle and actionable analysis statuses ahead of input previews', () => {
  const base = { state: 'ended' as const, analysis_state: 'none' as const, lastUserInput: 'Latest input' };
  expect(historySubtitle({ ...base, state: 'draft' })).toBe('New chat');
  expect(historySubtitle({ ...base, state: 'active' })).toBe('In progress');
  for (const [analysis_state, label] of [['pending', 'Analysis pending'], ['running', 'Analyzing'], ['failed', 'Analysis failed']] as const)
    expect(historySubtitle({ ...base, analysis_state })).toBe(label);
  for (const analysis_state of ['none', 'completed', 'skipped'] as const)
    expect(historySubtitle({ ...base, analysis_state })).toBe('Latest input');
});

it('normalizes display whitespace while preserving literal content and empty fallback', () => {
  const subtitle = (lastUserInput: string | null) => historySubtitle({ state: 'ended', analysis_state: 'completed', lastUserInput });
  expect(subtitle('  Hello\n\t안녕 👋  **text** <img>  ')).toBe('Hello 안녕 👋 **text** <img>');
  expect(subtitle('x'.repeat(2000))).toHaveLength(2000);
  expect(subtitle(null)).toBe('No messages');
  expect(subtitle(' \n\t ')).toBe('No messages');
});
