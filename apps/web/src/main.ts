/**
 * Boot (M3): parse params, detect the platform tier, start the Game.
 *
 * Deterministic query params for the screenshot harness (AGENTS.md §2.4):
 *   /?scene=<id>&cam=<preset>&t=<seconds>&seed=<n>&shot=1&tier=<tier>&cell=<cellId>&physics=1&perf=1&xrsim=1
 * `shot=1` freezes time at `t` and skips physics; `tier` forces budgets (SwiftShader detects as 'fallback');
 * `physics=1` forces the physics/character path even on object scenes (used by the e2e smoke test).
 * Window hooks for Playwright: __coastReady, __coastLod, __coastFrame, __coastSteps, __coastPhysics.
 *
 * Playground keys: WASD move · Space jump · Shift sprint · drag/lock look · wheel zoom · Tab mode · T time ·
 * 1–4 scenes · E grab/drop · F throw · click prop → click ground = put that there · Z undo · C collider · R reset
 */
import { detectPlatform } from '@coast/engine';
import { Game } from './game';
import { registerServiceWorker } from './pwa';

const params = new URLSearchParams(location.search);
export const seed = Number(params.get('seed') ?? '1'); // consumed by procedural systems from M2 (fog, NPC loiter)

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

declare global {
  interface Window {
    /** IWER emulated headset when booted with `?xrsim=1` (desktop try-out + the e2e harness). */
    __coastXrDevice?: unknown;
  }
}

async function boot() {
  if (params.get('xrsim') === '1') {
    // Immersive Web Emulation Runtime: a fake Quest 3 with two Touch controllers behind navigator.xr, so the WebXR
    // path (frame rig, sticks, snap turn, teleport, diorama) runs on a desktop and in Playwright.
    const { XRDevice, metaQuest3 } = await import('iwer');
    const device = new XRDevice(metaQuest3, { stereoEnabled: params.get('stereo') === '1' });
    device.installRuntime({ forceInstall: true }); // desktop Chrome exposes navigator.xr with no device; take it over
    if (import.meta.env.DEV && params.get('devui') !== '0') {
      // On-screen headset/controller puppeteering (mouse + keyboard) for trying the VR path without a Quest. Dev server
      // only: the dev UI drags half of three's core into the shared chunk, and production has no business shipping it.
      const { DevUI } = await import('@iwer/devui');
      device.installDevUI(DevUI);
    }
    window.__coastXrDevice = device;
  }
  const game = new Game({ platform: detectPlatform(), params, hud: document.getElementById('hud')!, sessionId });
  registerServiceWorker();
  await game.start();
}
void boot();

export {};
