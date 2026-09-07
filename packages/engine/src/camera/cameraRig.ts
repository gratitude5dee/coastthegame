/**
 * CameraRig (goal.md CAM-1…CAM-7): one rig, three modes sharing a target, 250 ms tweened transitions, no scene swap.
 * actor    = first person at eye height, yaw/pitch from look input
 * director = over-the-shoulder follow with frame-rate-independent damping; drag to orbit
 * producer = overhead orbit (desktop/phone); the VR diorama variant lands in M5 (CAM-3)
 * In XR the rig must move the `localFrame` group instead of the camera (CAM-4) — the XR path is added in M3 (Quest).
 */
import * as THREE from 'three';
import type { CameraPath } from './path';
import { RIG_PRESETS, RIG_TRANSITION_MS, SHOT_PRESETS, type RigMode, type RigParams, type ShotPreset } from './rig';

export type CameraMoveName = 'push_in' | 'pull_out' | 'orbit' | 'crane_up' | 'crane_down' | 'dolly_left' | 'dolly_right';

/** Vertical field of view of a full-frame lens (24 mm sensor height), degrees. */
export function fovForLens(mm: number): number {
  return (2 * Math.atan(12 / Math.max(4, mm)) * 180) / Math.PI;
}

export interface RigTarget {
  /** Feet position of the possessed actor. */
  feet: THREE.Vector3;
  /** Actor facing (radians around Y). */
  yaw: number;
  /** Eye height above the feet (m). */
  eyeHeight: number;
  /** Follow-mode multipliers for a bigger subject (the lowrider): distance and height (default 1). */
  followScale?: { distance: number; height: number };
}

export interface LookInput {
  /** Radians to add this frame (from mouse/touch/stick), already scaled by sensitivity. */
  yaw: number;
  pitch: number;
  /** Multiplicative zoom on distance (director/producer), 1 = no change. */
  zoom: number;
}

const UP = new THREE.Vector3(0, 1, 0);

function smoothstep(t: number) {
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential smoothing factor for a time constant tau (s). */
export function damp(tauS: number, dt: number) {
  return tauS <= 0 ? 1 : 1 - Math.exp(-dt / tauS);
}

export class CameraRig {
  mode: RigMode;
  /** Current (possibly mid-transition) parameters. */
  readonly params: RigParams;
  private from: RigParams;
  private to: RigParams;
  private t = 1; // transition progress 0..1
  private transitionMs = RIG_TRANSITION_MS;
  /** Camera roll (radians) for dutch angles, tweened with the shot. */
  private roll = 0;
  private rollFrom = 0;
  private rollTo = 0;
  /** An orbit move in flight: yaw sweeps `by` radians over `ms`. */
  private orbit: { from: number; by: number; t: number; ms: number } | null = null;
  /** A locked shot (CAM-2 / CAM-7): the camera rides a keyframed path instead of following the target. */
  private lockedPath: { path: CameraPath; t: number; speed: number; loop: boolean; paused: boolean } | null = null;
  /** Look angles: yaw around Y, pitch around X (radians). Shared across modes so switching keeps the direction. */
  yaw = 0;
  pitch = 0;
  /** Distance multiplier from the user's zoom (director/producer). */
  zoom = 1;
  /** Smoothed camera position for follow modes. */
  private smoothed = new THREE.Vector3();
  private initialised = false;
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpDesired = new THREE.Vector3();
  private readonly tmpLook = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(mode: RigMode = 'director') {
    this.mode = mode;
    this.params = { ...RIG_PRESETS[mode] };
    this.from = { ...this.params };
    this.to = { ...this.params };
  }

  setMode(mode: RigMode) {
    if (mode === this.mode) return;
    performance.mark('coast:mode-start');
    this.mode = mode;
    this.from = { ...this.params };
    this.to = { ...RIG_PRESETS[mode] };
    this.t = 0;
    this.transitionMs = RIG_TRANSITION_MS;
    this.rollFrom = this.roll;
    this.rollTo = 0;
    this.orbit = null;
    this.initialised = false; // re-seed the follow smoothing so the tween owns the motion
  }

  /** Tween some parameters over `ms` without changing mode (shot presets, camera moves, lenses — CAM-6). */
  tween(partial: Partial<RigParams>, ms = RIG_TRANSITION_MS, rollDeg?: number) {
    this.from = { ...this.params };
    this.to = { ...this.params, ...partial };
    this.t = 0;
    this.transitionMs = Math.max(1, ms);
    this.rollFrom = this.roll;
    if (rollDeg !== undefined) this.rollTo = (rollDeg * Math.PI) / 180;
  }

  /** A named shot ("camera low", "go wide"): distance / height / fov from SHOT_PRESETS, roll for the dutch. */
  applyShot(name: ShotPreset['name'], ms = 600): boolean {
    const shot = SHOT_PRESETS.find((s) => s.name === name);
    if (!shot || this.mode === 'actor') return false;
    this.zoom = 1;
    this.tween({ distance: shot.distance, height: shot.height, fovDeg: shot.fovDeg }, ms, shot.rollDeg ?? 0);
    return true;
  }

  /** A camera move over `ms`: push in / pull out / crane / dolly change the orbit, orbit sweeps the yaw. */
  move(move: CameraMoveName, ms = 1500): boolean {
    if (this.mode === 'actor') return false;
    const p = this.params;
    switch (move) {
      case 'push_in':
        this.tween({ distance: Math.max(0.6, p.distance * 0.55) }, ms);
        break;
      case 'pull_out':
        this.tween({ distance: Math.min(40, p.distance * 1.8) }, ms);
        break;
      case 'crane_up':
        this.tween({ height: p.height + 2.5 }, ms);
        break;
      case 'crane_down':
        this.tween({ height: Math.max(0.3, p.height - 1.2) }, ms);
        break;
      case 'dolly_left':
        this.tween({ shoulder: p.shoulder - 1.5 }, ms);
        break;
      case 'dolly_right':
        this.tween({ shoulder: p.shoulder + 1.5 }, ms);
        break;
      case 'orbit':
        this.orbit = { from: this.yaw, by: Math.PI / 2, t: 0, ms: Math.max(1, ms) };
        break;
    }
    return true;
  }

  /** A lens by focal length (full-frame): 24 mm wide … 85 mm tight. */
  lens(mm: number, ms = 400): boolean {
    if (this.mode === 'actor') return false;
    this.tween({ fovDeg: THREE.MathUtils.clamp(fovForLens(mm), 10, 100) }, ms);
    return true;
  }

  get rollRad() {
    return this.roll;
  }

  cycle(order: RigMode[] = ['actor', 'director', 'producer']) {
    const i = order.indexOf(this.mode);
    this.setMode(order[(i + 1) % order.length]!);
  }

  /**
   * Lock the camera to a keyframed path (CAM-7). Plays from the path's first key at `speed`× until the last key, then
   * hands the camera back to the follow modes (unless `loop`). Director / producer only.
   */
  lock(path: CameraPath, opts: { speed?: number; loop?: boolean; startS?: number; paused?: boolean } = {}): boolean {
    if (this.mode === 'actor' || path.size === 0) return false;
    this.lockedPath = {
      path,
      t: opts.startS ?? path.startS,
      speed: opts.speed ?? 1,
      loop: opts.loop ?? false,
      paused: opts.paused ?? false,
    };
    return true;
  }

  /** Free the camera (the follow smoothing re-seeds from wherever the path left it). */
  unlock() {
    if (!this.lockedPath) return;
    this.lockedPath = null;
    this.initialised = false;
  }

  get locked() {
    return this.lockedPath !== null;
  }

  /** Path time (s) while locked. */
  get pathTime(): number | null {
    return this.lockedPath?.t ?? null;
  }

  /** Scrub a locked path to `t` seconds and hold there (a timeline drag); `play()` resumes. */
  scrub(t: number) {
    const l = this.lockedPath;
    if (!l) return;
    l.t = t;
    l.paused = true;
  }

  play(speed?: number) {
    const l = this.lockedPath;
    if (!l) return;
    l.paused = false;
    if (speed !== undefined) l.speed = speed;
  }

  /** Camera forward on the XZ plane (for movement relative to the view). */
  forwardXZ(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** Apply look input and update the camera for this frame. */
  update(dt: number, camera: THREE.PerspectiveCamera, target: RigTarget, look: LookInput) {
    // Transition tween (CAM-1: ≤300 ms for modes; shots and moves pick their own duration)
    if (this.t < 1) {
      this.t = Math.min(1, this.t + (dt * 1000) / this.transitionMs);
      const k = smoothstep(this.t);
      const keys: (keyof RigParams)[] = ['distance', 'height', 'shoulder', 'fovDeg', 'dampingTauS', 'dioramaScale'];
      for (const key of keys) this.params[key] = this.from[key] + (this.to[key] - this.from[key]) * k;
      this.roll = this.rollFrom + (this.rollTo - this.rollFrom) * k;
      if (this.t >= 1) performance.mark('coast:mode-end');
    }
    if (this.orbit) {
      const o = this.orbit;
      o.t = Math.min(1, o.t + (dt * 1000) / o.ms);
      this.yaw = o.from + o.by * smoothstep(o.t);
      if (o.t >= 1) this.orbit = null;
    }

    // Locked shot: the path owns the camera; look input still steers the free camera underneath for the hand-back.
    const lock = this.lockedPath;
    if (lock && this.mode !== 'actor') {
      if (!lock.paused) {
        lock.t += dt * lock.speed;
        const end = lock.path.startS + lock.path.durationS;
        if (lock.t > end) {
          if (lock.loop && lock.path.durationS > 0) lock.t = lock.path.startS + ((lock.t - lock.path.startS) % lock.path.durationS);
          else {
            lock.path.apply(camera, end);
            this.unlock();
            this.yaw = yawFromCamera(camera);
            return;
          }
        }
      }
      lock.path.apply(camera, lock.t);
      this.yaw = yawFromCamera(camera);
      this.smoothed.copy(camera.position);
      return;
    }

    this.yaw -= look.yaw;
    const maxPitch = this.mode === 'actor' ? 1.45 : 1.2;
    const minPitch = this.mode === 'actor' ? -1.45 : -0.55; // director/producer may dip low for low-angle shots (the game clamps above ground)
    this.pitch = THREE.MathUtils.clamp(this.pitch - look.pitch, minPitch, maxPitch);
    if (look.zoom !== 1) this.zoom = THREE.MathUtils.clamp(this.zoom * look.zoom, 0.4, 3);

    if (camera.fov !== this.params.fovDeg) {
      camera.fov = this.params.fovDeg;
      camera.updateProjectionMatrix();
    }

    const forward = this.tmpForward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = this.tmpRight.crossVectors(forward, UP).normalize();

    if (this.mode === 'actor' || this.params.distance < 0.05) {
      // First person: eye at the head, orientation straight from yaw/pitch.
      this.tmpDesired.copy(target.feet).addScaledVector(UP, target.eyeHeight);
      camera.position.copy(this.tmpDesired);
      this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
      camera.quaternion.setFromEuler(this.euler);
      this.smoothed.copy(camera.position);
      this.initialised = true;
      return;
    }

    // Follow modes: desired position on an orbit around the target, then damped.
    const fs = target.followScale;
    const dist = this.params.distance * this.zoom * (fs?.distance ?? 1);
    const pitchLift = Math.sin(this.pitch) * dist;
    this.tmpDesired
      .copy(target.feet)
      .addScaledVector(UP, this.params.height * (fs?.height ?? 1) + pitchLift)
      .addScaledVector(forward, -dist * Math.cos(this.pitch))
      .addScaledVector(right, this.params.shoulder);
    if (!this.initialised) {
      this.smoothed.copy(this.tmpDesired);
      this.initialised = true;
    } else {
      this.smoothed.lerp(this.tmpDesired, damp(this.params.dampingTauS, dt));
    }
    camera.position.copy(this.smoothed);
    this.tmpLook
      .copy(target.feet)
      .addScaledVector(UP, this.mode === 'producer' ? 0.5 : target.eyeHeight * 0.85)
      .addScaledVector(forward, this.mode === 'producer' ? 0 : 1.2);
    camera.lookAt(this.tmpLook);
    if (this.roll !== 0) camera.rotateZ(this.roll);
  }
}

/** Rig yaw (Y rotation of the view direction) from a camera's orientation — so a hand-back from a path faces the same way. */
function yawFromCamera(camera: THREE.Camera): number {
  const d = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  return Math.atan2(-d.x, -d.z);
}
