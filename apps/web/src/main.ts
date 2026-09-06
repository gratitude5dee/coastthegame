/**
 * M0 seed / playground: three 0.180 + Spark 2.1 render Gaussian-splat worlds with tier-aware budgets.
 *
 * Deterministic query params for the screenshot harness (AGENTS.md §2.4):
 *   /?scene=<id>&cam=<preset>&t=<seconds>&seed=<n>&shot=1&tier=<tier>
 * `shot=1` freezes time at `t`, `seed` drives any procedural randomness (M2+), `tier` forces budgets (SwiftShader would
 * otherwise detect as 'fallback'). Exposes `window.__coastReady`, `window.__coastLod`, `window.__coastFrame` for Playwright.
 *
 * Playground keys (until the real input → intents layer lands in M3):
 *   WASD move · Q/E down/up · Shift fast · drag to look · 1–4 switch scene · T time-of-day · Tab rig mode · R reset camera
 */
import * as THREE from 'three';
import { SparkRenderer, SplatMesh, SparkControls, SplatFileType } from '@sparkjsdev/spark';
import { detectPlatform, budgetsFor, RIG_PRESETS, type RigMode } from '@coast/engine';
import { initPerf } from './perf';
import { registerServiceWorker } from './pwa';

const params = new URLSearchParams(location.search);
const isShot = params.has('shot');
const freezeT = isShot ? Number(params.get('t') ?? '0') : null;
export const seed = Number(params.get('seed') ?? '1'); // consumed by procedural systems from M2 (fog, NPC loiter)

const platform = detectPlatform();
const budgets = budgetsFor(platform.tier);

const hud = document.getElementById('hud')!;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 2000);
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
scene.add(spark);
performance.mark('coast:boot');

// Session id until auth lands (the Worker only requires a non-empty x-coast-session header).
const sessionId = (() => {
  try {
    const k = 'coast:session';
    const v = sessionStorage.getItem(k) ?? crypto.randomUUID();
    sessionStorage.setItem(k, v);
    return v;
  } catch {
    return crypto.randomUUID();
  }
})();
const perf = initPerf({ tier: platform.tier, cell: 'valley', sessionId, apiBase: '', splatCount: () => spark.display?.numSplats ?? 0 });
registerServiceWorker();

// ── Scenes. Cells (goal.md W-2) replace this table with cell.json manifests from R2. ──
// Spark sample assets are stored Y-down: rotate 180° about X (quaternion (1,0,0,0)) — rotate, never mirror (W-2).
interface SceneDef {
  title: string;
  url: string;
  fileType?: SplatFileType;
  position: [number, number, number];
  scale: number;
  camera: { pos: [number, number, number]; lookAt: [number, number, number] };
  world: boolean; // walkable world vs. object on a table
}
const LOCAL_BUTTERFLY: SceneDef = {
  title: 'Butterfly (local sample)',
  url: '/samples/butterfly.spz',
  position: [0, 0, -3],
  scale: 1,
  camera: { pos: [0, 0.2, 0.5], lookAt: [0, 0, -3] },
  world: false,
};
const SCENES: Record<string, SceneDef> = {
  valley: {
    title: 'Valley (Spark sample world)',
    url: 'https://sparkjs.dev/assets/splats/valley.spz',
    position: [0, 0, 0],
    scale: 0.5, // as in Spark's webxr example
    camera: { pos: [0, 2.2, -0.5], lookAt: [0, 1.6, -8] },
    world: true,
  },
  street: {
    title: 'Snow street (Spark sample world)',
    url: 'https://sparkjs.dev/assets/splats/snow-street.spz',
    position: [0, 0, 0],
    scale: 1,
    camera: { pos: [0, 1.6, 2], lookAt: [0, 1.4, -5] },
    world: true,
  },
  sutro: {
    title: 'Sutro Tower, SF (SOGS)',
    url: 'https://sparkjs.dev/assets/splats/sutro.zip',
    fileType: SplatFileType.PCSOGSZIP,
    position: [0, 0, 0],
    scale: 1,
    camera: { pos: [0, 1.5, 4], lookAt: [0, 1.5, 0] },
    world: true,
  },
  butterfly: LOCAL_BUTTERFLY,
};
const SCENE_ORDER = ['valley', 'street', 'sutro', 'butterfly'] as const;
const sceneId = params.get('scene') ?? (isShot ? 'butterfly' : 'valley');
let currentSceneId: string = sceneId in SCENES ? sceneId : 'valley';

// ── Time-of-day grade (goal.md W-5 preview): a global recolor until the dyno/LUT pipeline lands in M2 ──
const TIME_PRESETS = {
  noon: new THREE.Color(1, 1, 1),
  golden: new THREE.Color(1.1, 0.94, 0.8),
  blue: new THREE.Color(0.8, 0.9, 1.12),
  night: new THREE.Color(0.5, 0.56, 0.82),
} as const;
type TimePreset = keyof typeof TIME_PRESETS;
const TIME_ORDER: TimePreset[] = ['noon', 'golden', 'blue', 'night'];
let timePreset: TimePreset = 'noon';

// ── Rig mode preview (goal.md CAM-1): only the FOV changes until the CameraRig lands in M3.5 ──
const RIG_ORDER: RigMode[] = ['actor', 'director', 'producer'];
const camParam = params.get('cam') ?? 'director';
let rigMode: RigMode = (camParam in RIG_PRESETS ? camParam : 'director') as RigMode;
camera.fov = RIG_PRESETS[rigMode].fovDeg;
camera.updateProjectionMatrix();

const controls = new SparkControls({ canvas: renderer.domElement });

let splat: SplatMesh | null = null;
let ready = false;
let loading = '';
let usingFallback = false;

async function reachable(url: string): Promise<boolean> {
  if (url.startsWith('/')) return true;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

function placeCamera(def: SceneDef) {
  camera.position.set(...def.camera.pos);
  camera.lookAt(...def.camera.lookAt);
}

async function loadScene(id: string) {
  let def = SCENES[id] ?? LOCAL_BUTTERFLY;
  usingFallback = false;
  if (!(await reachable(def.url))) {
    def = LOCAL_BUTTERFLY;
    usingFallback = true;
  }
  if (splat) {
    scene.remove(splat);
    splat.dispose();
    splat = null;
  }
  ready = false;
  loading = def.title;
  const w = window as unknown as { __coastReady?: boolean; __coastLod?: boolean };
  w.__coastReady = false;
  w.__coastLod = false;
  const mesh = new SplatMesh({
    url: def.url,
    ...(def.fileType ? { fileType: def.fileType } : {}),
    lod: true,
    onLoad: () => {
      ready = true;
      loading = '';
      if (!performance.getEntriesByName('coast:interactive').length) performance.mark('coast:interactive'); // QB-3
      w.__coastReady = true;
    },
  });
  mesh.quaternion.set(1, 0, 0, 0);
  mesh.position.set(...def.position);
  mesh.scale.setScalar(def.scale);
  mesh.recolor.copy(TIME_PRESETS[timePreset]);
  scene.add(mesh);
  splat = mesh;
  placeCamera(def);
  currentSceneId = id;
  perf.setCell(id);
}

void loadScene(currentSceneId);

// ── Keys (playground only) ──
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.repeat) return;
  const idx = Number(e.key) - 1;
  if (idx >= 0 && idx < SCENE_ORDER.length) void loadScene(SCENE_ORDER[idx]!);
  else if (e.code === 'KeyT') {
    timePreset = TIME_ORDER[(TIME_ORDER.indexOf(timePreset) + 1) % TIME_ORDER.length]!;
    splat?.recolor.copy(TIME_PRESETS[timePreset]);
  } else if (e.code === 'Tab') {
    e.preventDefault();
    performance.mark('coast:mode-start');
    rigMode = RIG_ORDER[(RIG_ORDER.indexOf(rigMode) + 1) % RIG_ORDER.length]!;
    camera.fov = RIG_PRESETS[rigMode].fovDeg;
    camera.updateProjectionMatrix();
    performance.mark('coast:mode-end');
  } else if (e.code === 'KeyR') {
    placeCamera(SCENES[currentSceneId] ?? LOCAL_BUTTERFLY);
  }
});

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
  w.__coastLod = !!(splat as unknown as { packedSplats?: { lodSplats?: unknown } } | null)?.packedSplats?.lodSplats;

  if (freezeT === null) controls.update(camera);
  else if (splat) splat.rotation.y = freezeT * 0.5; // deterministic pose for screenshots

  renderer.render(scene, camera);
  perf.tick(dt);

  if (frame++ % 10 === 0) {
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const fps = frameTimes.length ? 1000 / (frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length) : 0;
    const title = (SCENES[currentSceneId] ?? LOCAL_BUTTERFLY).title;
    hud.innerHTML =
      `<b>$COAST</b> M0 playground · <b>${usingFallback ? 'offline → local butterfly' : title}</b>${loading ? ' · loading…' : ''}<br>` +
      `tier <b>${platform.tier}</b> · xr:${platform.webxr} · ${fps.toFixed(0)} fps · p95 ${p95.toFixed(1)} ms (target ${budgets.frameBudgetMs}) · ` +
      `splats ${(spark.display?.numSplats ?? 0).toLocaleString()} / ${budgets.lodSplatCount.toLocaleString()}<br>` +
      `mode <b>${rigMode}</b> (Tab) · time <b>${timePreset}</b> (T) · scenes 1–4 · WASD/QE move · Shift fast · drag look · R reset`;
  }
});

export {};
