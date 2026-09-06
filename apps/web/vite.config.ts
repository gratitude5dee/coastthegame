import { defineConfig } from 'vite';

/**
 * Code-splitting (goal.md QB-3 / W-1): three and Spark each get their own long-lived, hash-named chunk so the app
 * chunk stays small and rebuilds don't invalidate the two big vendor files. Rapier and MediaPipe are loaded with
 * dynamic `import()` at the call site (on demand) — Rollup gives those their own chunks without any config here.
 */
function manualChunks(id: string): string | undefined {
  // pnpm resolves to node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/..., so match the trailing package dir.
  // Only the three core: addons (GLTFLoader for the app, OrbitControls & co. for the XR dev UI) stay with their importer,
  // so an optional tool cannot fatten the chunk every player downloads.
  if (/\/node_modules\/three\/build\//.test(id)) return 'three';
  if (/\/node_modules\/@sparkjsdev\/spark\//.test(id)) return 'spark';
  return undefined;
}

export default defineConfig({
  server: { port: 5173 },
  // One three, ever: @iwer/devui (the ?xrsim=1 puppeteering panel, dev only) declares its own newer three, which
  // would load a second copy next to ours ("Multiple instances of Three.js" + instanceof checks failing across them).
  resolve: { dedupe: ['three'] },
  // Inline PostCSS config: stops Vite from walking up to a stray ~/postcss.config.js on dev machines.
  css: { postcss: {} },
  esbuild: { target: 'es2022' },
  build: {
    /** top-level await for RAPIER.init() and Spark's WASM bootstrap */
    target: 'es2022',
    sourcemap: true,
    // Spark ships one pre-bundled ESM file with its WASM (splat sorter / LoD worker) inlined as base64, so the `spark`
    // chunk is 4.93 MB minified (1.75 MB gzip) by construction and cannot be split further. Warn only above that, so a
    // real regression (e.g. Spark or Rapier leaking into the app chunk) still surfaces. Default limit is 500 kB.
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: { manualChunks },
    },
  },
  optimizeDeps: {
    // Spark ships a large pre-bundled ESM with inlined WASM; keep it out of the dep optimizer.
    exclude: ['@sparkjsdev/spark'],
  },
});
