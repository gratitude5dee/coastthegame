/**
 * M0 seed: three 0.180 + Spark 2.1 render a sample splat with tier-aware budgets.
 * Deterministic query params for the screenshot harness (AGENTS.md §2.4):
 *   /?scene=<id>&cam=<preset>&t=<seconds>&seed=<n>&shot=1&tier=<tier>
 * `shot=1` freezes time at `t`, `seed` drives any procedural randomness (M2+), `tier` forces budgets (SwiftShader would
 * otherwise detect as 'fallback'). Exposes `window.__coastReady` and `window.__coastFrame` for Playwright.
 */
import * as THREE from 'three';
import { SparkRenderer, SplatMesh, SparkControls } from '@sparkjsdev/spark';
import { detectPlatform, budgetsFor, RIG_PRESETS } from '@coast/engine';

const params = new URLSearchParams(location.search);
const sceneId = params.get('scene') ?? 'butterfly';
const camPreset = (params.get('cam') ?? 'director') as keyof typeof RIG_PRESETS;
const freezeT = params.has('shot') ? Number(params.get('t') ?? '0') : null;
export const seed = Number(params.get('seed') ?? '1'); // consumed by procedural systems from M2 (fog, NPC loiter)

const platform = detectPlatform();
const budgets = budgetsFor(platform.tier);

const hud = document.getElementById('hud')!;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(RIG_PRESETS[camPreset]?.fovDeg ?? 60, innerWidth / innerHeight, 0.05, 2000);
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, budgets.maxPixelRatio));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const spark = new SparkRenderer({
  renderer,
  enableLod: true,
  lodSplatCount: budgets.lodSplatCount,
  maxStdDev: budgets.maxStdDev,
  lodRenderScale: budgets.lodRenderScale,
});
performance.mark('coast:boot');
scene.add(spark);

// Sample scenes. Cells (goal.md W-2) will replace this table with cell.json manifests from R2.
const SCENES: Record<string, { url: string; position: [number, number, number]; flipX?: boolean }> = {
  butterfly: { url: '/samples/butterfly.spz', position: [0, 0, -3], flipX: true },
  valley: { url: 'https://sparkjs.dev/assets/splats/valley.spz', position: [0, 0, -3], flipX: true },
};
const def = SCENES[sceneId] ?? SCENES.butterfly!;
let ready = false;
const splat = new SplatMesh({
  url: def.url,
  lod: true,
  onLoad: () => {
    ready = true;
    performance.mark('coast:interactive'); // QB-3: first splats + input live
    (window as unknown as { __coastReady: boolean }).__coastReady = true;
  },
});
if (def.flipX) splat.quaternion.set(1, 0, 0, 0); // Spark sample assets are stored Y-down
splat.position.set(...def.position);
scene.add(splat);

const controls = new SparkControls({ canvas: renderer.domElement });
camera.position.set(0, 0.2, 0.5);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Minimal frame-time stats for /perf (goal.md BE-3). Real reports are posted from real devices.
const frameTimes: number[] = [];
let last = performance.now();
let frame = 0;

renderer.setAnimationLoop((time) => {
  const dt = time - last;
  last = time;
  frameTimes.push(dt);
  if (frameTimes.length > 240) frameTimes.shift();
  const w = window as unknown as { __coastFrame: number; __coastLod: boolean };
  w.__coastFrame = frame;
  // LoD tree ready = Spark attached lodSplats to the packed splats (worker "Tiny LoD" build finished).
  w.__coastLod = !!(splat as unknown as { packedSplats?: { lodSplats?: unknown } }).packedSplats?.lodSplats;

  if (freezeT === null) controls.update(camera);
  else splat.rotation.y = freezeT * 0.5; // deterministic pose for screenshots

  renderer.render(scene, camera);

  if (frame++ % 10 === 0) {
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    hud.innerHTML = `<b>$COAST</b> M0 seed${ready ? '' : ' · loading…'} · tier <b>${platform.tier}</b> · xr:${platform.webxr} · gpu:${platform.webgpu}<br>` +
      `splats ${(spark.display?.numSplats ?? splat.numSplats).toLocaleString()} / budget ${budgets.lodSplatCount.toLocaleString()} · frame p95 ${p95.toFixed(1)} ms · target ${budgets.frameBudgetMs} ms`;
  }
});

export {};
