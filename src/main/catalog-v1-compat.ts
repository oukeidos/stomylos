import current from './assets/starter-catalog-current.json?raw';
import delta from './assets/starter-catalog-v1-delta.json';

// Called only by the frozen migration adapter. Never cache a complete old corpus.
export function legacyCatalogRaw(): string {
  const overrides: Record<string, string> = delta;
  return JSON.stringify(JSON.parse(current).map((r: { id: string; en: string }) =>
    ({ ...r, en: overrides[r.id] ?? r.en }))) + '\n';
}
