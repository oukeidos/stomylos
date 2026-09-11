import { catalogCompatibility } from './catalog-compat-plugin';
import { defineConfig } from 'vitest/config';
export default defineConfig({ plugins: [catalogCompatibility()], test: {
  include: ['tests/**/*.test.ts'],
  testTimeout: 10000, pool: 'forks'
} });
