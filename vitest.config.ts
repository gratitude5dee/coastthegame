import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  css: { postcss: {} }, // never load a postcss.config.js from outside the repo
  resolve: {
    alias: {
      '@coast/engine': path.resolve(__dirname, 'packages/engine/src/index.ts'),
      '@coast/director': path.resolve(__dirname, 'packages/director/src/index.ts'),
      '@coast/studio': path.resolve(__dirname, 'packages/studio/src/index.ts'),
    },
  },
  test: { include: ['tests/unit/**/*.test.ts', 'packages/**/*.test.ts'] },
});
