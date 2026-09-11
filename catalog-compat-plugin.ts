import type { Plugin } from 'vite';

/** Preserve the frozen source/contract while making its v1 payload lazy and delta-backed. */
export function catalogCompatibility(): Plugin {
  return { name: 'catalog-v1-compatibility', enforce: 'pre', transform(code, id) {
    if (!id.replaceAll('\\', '/').endsWith('/src/main/migrations/019-data.ts')) return;
    const original = "import raw from '../assets/starter-catalog-v1.json?raw';";
    if (!code.includes(original) || !code.includes('payload = raw')) throw new Error('Frozen catalog adapter mismatch');
    return code.replace(original, "import { legacyCatalogRaw } from '../catalog-v1-compat';")
      .replace('payload = raw', 'payload = legacyCatalogRaw()');
  }, generateBundle() {
    const modules = [...this.getModuleIds()].map(id => id.replaceAll('\\', '/'));
    if (modules.some(id => id.endsWith('/assets/starter-catalog-v1.json?raw')) ||
        !modules.some(id => id.endsWith('/assets/starter-catalog-current.json?raw'))) {
      throw new Error('Expected one full current catalog and delta-only v1 compatibility');
    }
  }};
}
