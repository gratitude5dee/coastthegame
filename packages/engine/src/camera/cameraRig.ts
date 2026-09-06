/**
 * CameraRig (goal.md CAM-1…CAM-7): one rig, three modes sharing a target, 250 ms tweened transitions, no scene swap.
 * actor    = first person at eye height, yaw/pitch from look input
 * director = over-the-shoulder follow with frame-rate-independent damping; drag to orbit
 * producer = overhead orbit (desktop/phone); the VR diorama variant lands in M5 (CAM-3)
 * In XR the rig must move the `localFrame` group instead of the camera (CAM-4) — the XR path is added in M3 (Quest).
 */
import * as THREE from 'three';
import { RIG_PRESETS, RIG_TRANSITION_MS, type RigMode, type RigParams } from './rig';

export interface RigTarget {
  /** Feet position of the possessed actor. */
  feet: THREE.Vector3;
  /** Actor facing (radians around Y). */
  yaw: number;
  /** Eye height above the feet (m). */
  eyeHeight: number;
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
    this.initialised = false; // re-seed the follow smoothing so the tween owns the motion
  }

  cycle(order: RigMode[] = ['actor', 'director', 'producer']) {
    const i = order.indexOf(this.mode);
    this.setMode(order[(i + 1) % order.length]!);
  }

  /** Camera forward on the XZ plane (for movement relative to the view). */
  forwardXZ(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** Apply look input and update the camera for this frame. */
  update(dt: number, camera: THREE.PerspectiveCamera, target: RigTarget, look: LookInput) {
    // Transition tween (CAM-1: ≤300 ms)
    if (this.t < 1) {
      this.t = Math.min(1, this.t + (dt * 1000) / RIG_TRANSITION_MS);
      const k = smoothstep(this.t);
      const keys: (keyof RigParams)[] = ['distance', 'height', 'shoulder', 'fovDeg', 'dampingTauS', 'dioramaScale'];
      for (const key of keys) this.params[key] = this.from[key] + (this.to[key] - this.from[key]) * k;
      if (this.t >= 1) performance.mark('coast:mode-end');
    }

    this.yaw -= look.yaw;
    const maxPitch = this.mode === 'actor' ? 1.45 : 1.2;
    const minPitch = this.mode === 'actor' ? -1.45 : -0.15;
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
    const dist = this.params.distance * this.zoom;
    const pitchLift = Math.sin(this.pitch) * dist;
    this.tmpDesired
      .copy(target.feet)
      .addScaledVector(UP, this.params.height + pitchLift)
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
  }
}
