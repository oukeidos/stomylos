import { catalogCompatibility } from './catalog-compat-plugin';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [catalogCompatibility(), externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), 'backup-worker': resolve('src/main/backup-worker.ts'), 'db-worker': resolve('src/main/db-worker.ts'), 'asr-worker': resolve('src/main/asr-worker.ts') } } }
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] }
});
