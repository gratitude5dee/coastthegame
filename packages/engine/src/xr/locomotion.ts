/**
 * XR locomotion math (goal.md CAM-3, CAM-4): in XR the rig moves the `localFrame` (the camera's parent) and never the
 * camera. The player's body is still the kinematic capsule; the headset adds a physical offset on top. These are the
 * pure pieces — the game applies them to the frame, the character and the world group.
 *
 * Conventions: three.js, yaw around +Y, forward = −Z at yaw 0. "Head local" = the camera's position in frame space
 * (what WebXR reports for a `local-floor` reference space: x/z where the user stands in the room, y = eye height).
 */
import * as THREE from 'three';

/** World-space XZ displacement of a point at frame-local `local` when the frame sits at `yaw`. */
export function frameOffsetXZ(yaw: number, local: THREE.Vector3, out = new THREE.Vector2()): THREE.Vector2 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // R_y(yaw) · (x, z): x' = c·x + s·z, z' = −s·x + c·z
  return out.set(c * local.x + s * local.z, -s * local.x + c * local.z);
}

/**
 * Snap turn without the world sliding: rotating the frame by `delta` around its origin moves the head (which stands at
 * `headLocal`) in the world. Returns the XZ shift the body must be teleported by so the head stays where it was.
 */
export function snapTurnShift(yaw: number, delta: number, headLocal: THREE.Vector3, out = new THREE.Vector2()): THREE.Vector2 {
  const before = frameOffsetXZ(yaw, headLocal);
  const after = frameOffsetXZ(yaw + delta, headLocal, out);
  return out.set(before.x - after.x, before.y - after.y);
}

/**
 * Capsule-follows-head: where the frame origin must sit (XZ) so the head, at `headLocal` in frame space, stands over
 * `feet`. y is the feet height (local-floor puts the floor at frame y = 0).
 */
export function framePositionForHead(feet: THREE.Vector3, yaw: number, headLocal: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const off = frameOffsetXZ(yaw, headLocal);
  return out.set(feet.x - off.x, feet.y, feet.z - off.y);
}

/** Heading of a world-space quaternion (yaw of its −Z axis). */
export function yawOf(q: THREE.Quaternion, tmp = new THREE.Vector3()): number {
  const f = tmp.set(0, 0, -1).applyQuaternion(q);
  return Math.atan2(-f.x, -f.z);
}

export interface DioramaPlacement {
  position: THREE.Vector3;
  scale: number;
}

/**
 * Diorama (CAM-3): scale the whole world group by `scale` so that the world point `anchor` (the player's feet) lands on
 * `table` (a world point in front of the standing user). Uniform scale about the origin, then translate.
 */
export function dioramaPlacement(
  anchor: THREE.Vector3,
  table: THREE.Vector3,
  scale: number,
  out: DioramaPlacement = { position: new THREE.Vector3(), scale },
): DioramaPlacement {
  out.scale = scale;
  out.position.set(table.x - anchor.x * scale, table.y - anchor.y * scale, table.z - anchor.z * scale);
  return out;
}

/** The table point for the diorama: `distance` ahead of the head on XZ and `drop` below eye level. */
export function tablePoint(
  headWorld: THREE.Vector3,
  headYaw: number,
  distance = 0.7,
  drop = 0.55,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  return out.set(headWorld.x - Math.sin(headYaw) * distance, headWorld.y - drop, headWorld.z - Math.cos(headYaw) * distance);
}

/** Snap-turn helper: edge-triggered on a stick axis with hysteresis, so one flick = one turn. */
export class SnapTurn {
  private armed = true;
  constructor(
    readonly stepRad = Math.PI / 6,
    private readonly on = 0.7,
    private readonly off = 0.3,
  ) {}

  /** Feed the stick's x each frame; returns the signed turn (radians) to apply, or 0. */
  update(x: number): number {
    if (this.armed && Math.abs(x) >= this.on) {
      this.armed = false;
      return -Math.sign(x) * this.stepRad; // stick right → turn right → yaw decreases
    }
    if (!this.armed && Math.abs(x) <= this.off) this.armed = true;
    return 0;
  }
}

/** Teleport arming: push the stick forward to aim, release to go. */
export class TeleportArm {
  private armed = false;
  /** Feed the stick's y (−1 = pushed forward). Returns 'aim' while held, 'go' on release, else 'idle'. */
  update(y: number): 'idle' | 'aim' | 'go' {
    if (!this.armed && y <= -0.7) this.armed = true;
    if (this.armed) {
      if (y >= -0.3) {
        this.armed = false;
        return 'go';
      }
      return 'aim';
    }
    return 'idle';
  }
  cancel() {
    this.armed = false;
  }
}
