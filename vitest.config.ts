import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  css: { postcss: {} }, // never load a postcss.config.js from outside the repo
  resolve: {
    alias: {
      '@coast/engine': path.resolve(__dirname, 'packages/engine/src/index.ts'),
      '@coast/director': path.resolve(__dirname, 'packages/director/src/index.ts'),
      '@coast/studio': path.resolve(__dirname, 'packages/studio/src/index.ts'),
      // Engine tests import three + Rapier from the web app's install (peer deps of the engine; root has neither).
      three: path.resolve(__dirname, 'apps/web/node_modules/three'),
      '@dimforge/rapier3d-compat': path.resolve(__dirname, 'apps/web/node_modules/@dimforge/rapier3d-compat'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'packages/**/*.test.ts', 'tests/api/**/*.test.ts'],
    // tests/api boots workerd (wrangler dev --local): ~20 s on a cold start.
    testTimeout: 30_000,
  },
});
