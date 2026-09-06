/**
 * CameraRig contract (goal.md CAM-1…CAM-7). Implementation lands in M3/M5; this fixes the API surface.
 * In XR the rig moves the `localFrame` group (the camera's parent), never the camera itself (CAM-4).
 */
export type RigMode = 'actor' | 'director' | 'producer';
export type DirectorSubMode = 'shoulderL' | 'shoulderR' | 'orbit' | 'locked';

export interface RigParams {
  distance: number; // m from target (0 in actor mode)
  height: number; // m above target feet
  shoulder: number; // lateral offset, +right
  fovDeg: number;
  dampingTauS: number; // time constant in seconds (frame-rate independent: alpha = 1 - exp(-dt / tau))
  dioramaScale: number; // producer-in-VR world scale (1 = life size, 1/12 tabletop); scales the SCENE ROOT, physics paused, positions written back at 1:1 on exit (CAM-3)
}

export const RIG_PRESETS: Record<RigMode, RigParams> = {
  actor: { distance: 0, height: 1.65, shoulder: 0, fovDeg: 75, dampingTauS: 0, dioramaScale: 1 },
  director: { distance: 3.2, height: 1.8, shoulder: 0.6, fovDeg: 50, dampingTauS: 0.12, dioramaScale: 1 },
  producer: { distance: 18, height: 14, shoulder: 0, fovDeg: 45, dampingTauS: 0.2, dioramaScale: 1 / 12 },
};

export const RIG_TRANSITION_MS = 250; // CAM-1: ≤300 ms, no frame > 50 ms

export interface ShotPreset {
  name: 'wide' | 'medium' | 'close' | 'low' | 'high' | 'dutch';
  distance: number;
  height: number;
  fovDeg: number;
  rollDeg?: number;
}

export const SHOT_PRESETS: ShotPreset[] = [
  { name: 'wide', distance: 8, height: 1.6, fovDeg: 60 },
  { name: 'medium', distance: 3, height: 1.5, fovDeg: 45 },
  { name: 'close', distance: 1.2, height: 1.6, fovDeg: 35 },
  { name: 'low', distance: 3, height: 0.4, fovDeg: 40 },
  { name: 'high', distance: 5, height: 4, fovDeg: 50 },
  { name: 'dutch', distance: 3, height: 1.5, fovDeg: 45, rollDeg: 12 },
];
