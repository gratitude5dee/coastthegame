import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** App version + commit for the provenance manifest (STU-5): package.json and `git rev-parse` at build time. */
function appVersion(): { version: string; commit: string } {
  const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;
  let commit = process.env.COAST_COMMIT ?? '';
  if (!commit) {
    try {
      commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      commit = 'unknown';
    }
  }
  return { version, commit };
}
const APP = appVersion();

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
  // The post stack (`@coast/engine/post` → postprocessing) is loaded on demand: desktop live, every tier at export.
  if (/\/node_modules\/postprocessing\//.test(id)) return 'post';
  return undefined;
}

export default defineConfig({
  define: { __COAST_VERSION__: JSON.stringify(APP.version), __COAST_COMMIT__: JSON.stringify(APP.commit) },
  // `pnpm dev:https` — WebXR (Quest, Vision Pro) and the microphone need a secure context off localhost: a self-signed
  // cert on the LAN URL (accept the browser's warning once on the headset / phone).
  plugins: process.env.COAST_HTTPS === '1' ? [basicSsl()] : [],
  server: {
    port: 5173,
    // The Worker (`pnpm dev:api` → wrangler dev on :8787) serves the API, share pages and the perf dashboard; in
    // production the same Worker serves this app, so the client uses same-origin paths and this proxy is dev-only.
    proxy: { '/api': 'http://localhost:8787', '/c/': 'http://localhost:8787', '/perf': 'http://localhost:8787' },
  },
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
