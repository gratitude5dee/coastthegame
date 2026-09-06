import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  // Inline PostCSS config: stops Vite from walking up to a stray ~/postcss.config.js on dev machines.
  css: { postcss: {} },
  esbuild: { target: 'es2022' },
  build: {
    /** top-level await for RAPIER.init() and Spark's WASM bootstrap */
    target: 'es2022',
    sourcemap: true,
  },
  optimizeDeps: {
    // Spark ships a large pre-bundled ESM with inlined WASM; keep it out of the dep optimizer.
    exclude: ['@sparkjsdev/spark'],
  },
});
