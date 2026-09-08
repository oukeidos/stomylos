import { defineConfig } from 'vitest/config';
// Only scripts/test.mjs --check <name> or an explicit driver uses this config.
export default defineConfig({ test: {
  include: ['tests/**/*.check.ts'], testTimeout: 10000, pool: 'forks'
} });
