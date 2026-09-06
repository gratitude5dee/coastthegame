/**
 * Frame-level intent aggregation (goal.md INP-1/INP-2, PLT-2). Providers write into a shared `FrameInput`
 * each frame; gameplay reads only this — never raw devices.
 */
import * as THREE from 'three';

export interface FrameInput {
  /** Local move axes: x = right, y = forward, each -1..1 (pre-normalised by the consumer). */
  move: THREE.Vector2;
  /** Look delta in radians this frame. */
  look: THREE.Vector2;
  /** Distance zoom multiplier this frame (1 = none). */
  zoom: number;
  jump: boolean; // edge
  sprint: boolean; // held
  interact: boolean; // edge — grab/release
  throwEdge: boolean; // edge
  select: boolean; // edge — click/tap at `pointer`
  cancel: boolean; // edge — Escape / back
  undo: boolean; // edge
  modeCycle: boolean; // edge
  timeCycle: boolean; // edge
  debugToggle: boolean; // edge
  resetEdge: boolean; // edge
  action: boolean; // edge — Enter / ACTION button: roll or cut a take
  playback: boolean; // edge — P: replay the last take
  /** Hydraulic switchbox, held: x = −1 left side up … +1 right side up; y = +1 front up … −1 back up (I/J/K/L, d-pad). */
  hydro: THREE.Vector2;
  beatToggle: boolean; // edge — H / BEAT: hop on the beat grid (auto-hydraulics + metronome)
  sceneKey: number | null; // 1-based scene slot
  /** Normalised device coords of the pointer (-1..1), when known. */
  pointer: THREE.Vector2 | null;
  /** True while the pointer is locked (actor mode look). */
  pointerLocked: boolean;
  /** World-space pointing ray (XR controller / hand / head) — preferred over `pointer` when set. */
  pointerRay: THREE.Ray | null;
  /** Snap-turn to apply to the XR frame this frame (radians, + = left). */
  snapTurn: number;
  /** Teleport state from the XR stick: aiming (show the marker) or go. */
  teleport: 'idle' | 'aim' | 'go';
  /** An XR session is presenting this frame. */
  xrPresenting: boolean;
}

export function newFrameInput(): FrameInput {
  return {
    move: new THREE.Vector2(),
    look: new THREE.Vector2(),
    zoom: 1,
    jump: false,
    sprint: false,
    interact: false,
    throwEdge: false,
    select: false,
    cancel: false,
    undo: false,
    modeCycle: false,
    timeCycle: false,
    debugToggle: false,
    resetEdge: false,
    action: false,
    playback: false,
    hydro: new THREE.Vector2(),
    beatToggle: false,
    sceneKey: null,
    pointer: null,
    pointerLocked: false,
    pointerRay: null,
    snapTurn: 0,
    teleport: 'idle',
    xrPresenting: false,
  };
}

/** Reset the per-frame edges/deltas; held axes are re-written by providers each frame. */
export function resetFrameInput(f: FrameInput) {
  f.move.set(0, 0);
  f.look.set(0, 0);
  f.hydro.set(0, 0);
  f.zoom = 1;
  f.jump =
    f.interact =
    f.throwEdge =
    f.select =
    f.cancel =
    f.undo =
    f.modeCycle =
    f.timeCycle =
    f.debugToggle =
    f.resetEdge =
    f.action =
    f.playback =
    f.beatToggle =
      false;
  f.sceneKey = null;
  f.sprint = false;
  f.pointerRay = null;
  f.snapTurn = 0;
  f.teleport = 'idle';
  f.xrPresenting = false;
}

export interface InputProvider {
  readonly id: string;
  /** Contribute to the frame input (called once per rendered frame). */
  poll(dtSeconds: number, out: FrameInput): void;
  dispose(): void;
}
