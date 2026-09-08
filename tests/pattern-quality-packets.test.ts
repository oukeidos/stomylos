import { expect, it } from 'vitest';
import { patternQualityCases } from './pattern-quality-fixtures';
it('prepares a near-budget history, misleading one/two-session clusters and sparse evidence without inference', () => {
  const rows = patternQualityCases();
  for (const row of rows) expect(row.preview.blocked).toBeNull();
  expect(rows[0].preview.scope.estimate).toBeGreaterThan(18000);
  expect(rows[0].preview.scope.estimate).toBeLessThanOrEqual(20000);
  expect(rows[0].sources.length).toBeLessThan(20);
});
