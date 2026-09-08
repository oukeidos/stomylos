import Database from 'better-sqlite3';
// External converters are test-only JavaScript; never imported by the app.
// @ts-expect-error Standalone converter.
import { convertTime } from '../scripts/convert-time.mjs';
// @ts-expect-error Standalone converter.
import { convertPatterns } from '../scripts/convert-patterns.mjs';
// @ts-expect-error Standalone converter.
import { convertSearch } from '../scripts/convert-search.mjs';
// @ts-expect-error Standalone converter.
import { convertSharedMemory } from '../scripts/convert-shared-memory.mjs';
// @ts-expect-error Standalone converter.
import { convertIntentionStarters } from '../scripts/convert-intention-starters.mjs';
// @ts-expect-error Standalone converter.
import { convertBookmarks } from '../scripts/convert-bookmarks.mjs';
// @ts-expect-error Standalone converter.
import { convertModelSwitching } from '../scripts/convert-model-switching.mjs';

// @ts-expect-error Standalone converter.
import { convertExplain } from '../scripts/convert-explain.mjs';

// Update this one sequence when adding a schema. Each caller still verifies its
// fixed adjacent conversion and its distinct historical data/retry behavior.
const steps = [convertTime, convertPatterns, convertSearch, convertSharedMemory,
  convertIntentionStarters, convertBookmarks, convertModelSwitching, convertExplain];
export const currentTestSchema = 5 + steps.length;
function version(file: string): number {
  const db = new Database(file, { readonly: true });
  try { return Number(db.pragma('user_version', { simple: true })); }
  finally { db.close(); }
}
export function convertToCurrent(file: string, target = currentTestSchema): void {
  const source = version(file);
  if (source < 5 || source > target || target > currentTestSchema) throw new Error('Unsupported test conversion range');
  for (let from = source; from < target; from++) {
    const result = steps[from - 5](file);
    if (result.source_version !== from || result.target_version !== from + 1 || version(file) !== from + 1)
      throw new Error(`Conversion did not advance v${from} to v${from + 1}`);
  }
}
