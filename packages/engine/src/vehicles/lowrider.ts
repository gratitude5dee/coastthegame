/**
 * The lowrider (goal.md PHY-3): Rapier's DynamicRayCastVehicleController (4 wheel rays) on a dynamic chassis with
 * arcade tuning, plus **hydraulics** — per-corner suspension rest-length offsets (hold a switch: the corner rises and
 * stays) and **hops** (an impulse at the corner + a short pump of the spring). Hops can be driven by input or by the
 * beat grid; the vehicle itself is beat-agnostic — the caller decides *when*, this class decides *how*.
 *
 * Conventions (verified against Rapier 0.12 in tests/unit/lowrider.test.ts): three.js forward is −Z, so wheel axles are
 * +X (positive engine force then drives toward −Z); positive steering turns LEFT (counter-clockwise from above), so the
 * caller's right-positive steer input is negated. Wheel order: 0 FL, 1 FR, 2 RL, 3 RR.
 *
 * Simulation is fixed-step (call `beforeStep()` + `step()` from PhysicsWorld.step's onStep); `sync(alpha)` writes the
 * interpolated pose into the visual group (STU-1 render interpolation, like props).
 */
import * as THREE from 'three';
import type * as RAPIER_NS from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/world';

export interface LowriderTuning {
  mass: number; // kg
  /** Chassis collider half extents (x: half width, y: half height, z: half length), metres. */
  halfExtents: [number, number, number];
  /** Centre of mass below the chassis centre (m, positive = lower) — keeps the car planted in corners. */
  comDrop: number;
  wheelRadius: number;
  wheelBase: number; // front↔rear axle distance
  track: number; // left↔right wheel distance
  /** Suspension attachment height relative to the chassis centre (m). */
  hardPointY: number;
  suspensionRest: number; // m
  suspensionStiffness: number; // Bullet/Rapier units: force = k · Δx · chassisMass
  suspensionCompression: number;
  suspensionRelaxation: number;
  maxSuspensionTravel: number;
  maxSuspensionForce: number;
  frictionSlip: number;
  sideFrictionStiffness: number;
  engineForce: number; // N per driven wheel at full throttle (all four are driven — arcade AWD)
  brakeForce: number; // N per wheel when reversing the throttle against motion
  handbrakeForce: number;
  maxSteerRad: number;
  steerRateRadPerS: number; // how fast the wheels reach the target angle
  maxSpeed: number; // m/s forward
  maxReverseSpeed: number; // m/s
  /** Extra rest length at full lift (m) — the "front up / three-wheel motion" stance. */
  hydraulicLift: number;
  /** Hop impulse per corner (N·s). */
  hopImpulse: number;
  /** Rest-length pump on a hop (m) and how long it lasts (s). */
  hopPump: number;
  hopPumpS: number;
}

/** '64-Impala-ish proportions; tuned for feel on Marble-scale blocks, not for realism. */
export const LOWRIDER_TUNING: LowriderTuning = {
  mass: 900,
  halfExtents: [0.95, 0.25, 2.3],
  comDrop: 0.2,
  wheelRadius: 0.33,
  wheelBase: 3.0,
  track: 1.6,
  hardPointY: -0.1,
  suspensionRest: 0.35,
  suspensionStiffness: 25,
  suspensionCompression: 4.5,
  suspensionRelaxation: 6.0,
  maxSuspensionTravel: 0.5,
  maxSuspensionForce: 30_000,
  frictionSlip: 10.5,
  sideFrictionStiffness: 1,
  engineForce: 1500,
  brakeForce: 2500,
  handbrakeForce: 4000,
  maxSteerRad: 0.55,
  steerRateRadPerS: 3.5,
  maxSpeed: 14,
  maxReverseSpeed: 5,
  hydraulicLift: 0.28,
  hopImpulse: 900,
  hopPump: 0.25,
  hopPumpS: 0.14,
};

export type HopPattern = 'front' | 'back' | 'left' | 'right' | 'all' | 'FL' | 'FR' | 'RL' | 'RR';

/** Which wheel indices a pattern lifts (0 FL, 1 FR, 2 RL, 3 RR). */
export const HOP_CORNERS: Record<HopPattern, number[]> = {
  front: [0, 1],
  back: [2, 3],
  left: [0, 2],
  right: [1, 3],
  all: [0, 1, 2, 3],
  FL: [0],
  FR: [1],
  RL: [2],
  RR: [3],
};

export interface VehicleInput {
  /** −1..1, + = forward. */
  throttle: number;
  /** −1..1, + = right. */
  steer: number;
  /** Handbrake held. */
  brake: boolean;
  /** Hydraulic lift per corner 0..1 (FL, FR, RL, RR) — held switches. */
  lift: [number, number, number, number];
  /** Hop this step (edge), or null. */
  hop: HopPattern | null;
}

export function zeroVehicleInput(): VehicleInput {
  return { throttle: 0, steer: 0, brake: false, lift: [0, 0, 0, 0], hop: null };
}

/** Map a two-axis switchbox (x: −1 left … +1 right side up; y: +1 front … −1 back up) to per-corner lifts. */
export function liftFromAxes(x: number, y: number): [number, number, number, number] {
  const front = Math.max(0, y);
  const back = Math.max(0, -y);
  const left = Math.max(0, -x);
  const right = Math.max(0, x);
  const c = (a: number, b: number) => Math.min(1, a + b);
  return [c(front, left), c(front, right), c(back, left), c(back, right)];
}

export interface LowriderOptions {
  position: THREE.Vector3; // chassis centre (drop it ~1 m above ground; it settles)
  yaw?: number;
  tuning?: Partial<LowriderTuning>;
  /** Build the placeholder meshes (false for headless tests). */
  visuals?: boolean;
}

const UP = { x: 0, y: -1, z: 0 };
const AXLE = { x: 1, y: 0, z: 0 };
const notKinematic = (c: RAPIER_NS.Collider) => {
  const b = c.parent();
  return !b || !b.isKinematic();
};

export class Lowrider {
  readonly tuning: LowriderTuning;
  readonly body: RAPIER_NS.RigidBody;
  readonly collider: RAPIER_NS.Collider;
  readonly controller: RAPIER_NS.DynamicRayCastVehicleController;
  /** Visual root: chassis meshes + wheels. Follows the body with interpolation. */
  readonly group = new THREE.Group();
  readonly wheelMeshes: THREE.Object3D[] = [];
  /** Signed forward speed of the last step (m/s, + = forward). */
  speed = 0;
  /** Wheels touching the ground after the last step. */
  wheelsOnGround = 0;
  /** Hops fired so far (any source). */
  hops = 0;
  private steerAngle = 0;
  private readonly restLength: number[] = [];
  private readonly pumpUntil = [0, 0, 0, 0]; // seconds of sim time
  private simTime = 0;
  private readonly prevPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly currPos = new THREE.Vector3();
  private readonly currQuat = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly hardPoints: THREE.Vector3[] = [];

  constructor(
    private readonly physics: PhysicsWorld,
    opts: LowriderOptions,
  ) {
    const R = physics.R;
    const t = (this.tuning = { ...LOWRIDER_TUNING, ...opts.tuning });
    const yaw = opts.yaw ?? 0;
    const [hx, hy, hz] = t.halfExtents;

    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(opts.position.x, opts.position.y, opts.position.z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setLinearDamping(0.05)
      .setAngularDamping(0.6)
      .setCcdEnabled(true)
      .setCanSleep(false); // a sleeping chassis ignores the wheel impulses (and freezes its reported velocity)
    this.body = physics.world.createRigidBody(bodyDesc);
    const w = hx * 2;
    const h = hy * 2;
    const l = hz * 2;
    const m = t.mass;
    const colliderDesc = R.ColliderDesc.cuboid(hx, hy, hz)
      .setFriction(0.6)
      .setRestitution(0.1)
      .setMassProperties(
        m,
        { x: 0, y: -t.comDrop, z: 0 },
        { x: (m / 12) * (h * h + l * l), y: (m / 12) * (w * w + l * l), z: (m / 12) * (w * w + h * h) },
        { x: 0, y: 0, z: 0, w: 1 },
      );
    this.collider = physics.world.createCollider(colliderDesc, this.body);

    const v = (this.controller = physics.world.createVehicleController(this.body));
    const corners = [
      [-t.track / 2, -t.wheelBase / 2],
      [t.track / 2, -t.wheelBase / 2],
      [-t.track / 2, t.wheelBase / 2],
      [t.track / 2, t.wheelBase / 2],
    ] as const;
    corners.forEach(([x, z], i) => {
      const p = new THREE.Vector3(x, t.hardPointY, z);
      this.hardPoints.push(p);
      v.addWheel({ x: p.x, y: p.y, z: p.z }, UP, AXLE, t.suspensionRest, t.wheelRadius);
      v.setWheelSuspensionStiffness(i, t.suspensionStiffness);
      v.setWheelSuspensionCompression(i, t.suspensionCompression);
      v.setWheelSuspensionRelaxation(i, t.suspensionRelaxation);
      v.setWheelMaxSuspensionTravel(i, t.maxSuspensionTravel);
      v.setWheelMaxSuspensionForce(i, t.maxSuspensionForce);
      v.setWheelFrictionSlip(i, t.frictionSlip);
      v.setWheelSideFrictionStiffness(i, t.sideFrictionStiffness);
      this.restLength.push(t.suspensionRest);
    });

    this.currPos.copy(opts.position);
    this.currQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.group.position.copy(this.currPos);
    this.group.quaternion.copy(this.currQuat);
    if (opts.visuals !== false) this.buildVisuals();
  }

  /** Capture the previous pose (call before each fixed step). */
  beforeStep() {
    const tr = this.body.translation();
    const r = this.body.rotation();
    this.prevPos.set(tr.x, tr.y, tr.z);
    this.prevQuat.set(r.x, r.y, r.z, r.w);
  }

  /** One fixed step (before `world.step()`): steering, engine/brakes, hydraulics, then the wheel rays. */
  step(dt: number, input: VehicleInput) {
    const t = this.tuning;
    const v = this.controller;
    this.simTime += dt;

    // Signed forward speed (three.js forward −Z in chassis space → world).
    const fwd = this.forward(this.tmpV);
    const lv = this.body.linvel();
    this.speed = fwd.x * lv.x + fwd.y * lv.y + fwd.z * lv.z;

    // Steering: rate-limited toward the target; less lock at speed (arcade stability). Positive Rapier steering = left.
    const speedK = 1 - 0.55 * Math.min(1, Math.abs(this.speed) / t.maxSpeed);
    const target = -THREE.MathUtils.clamp(input.steer, -1, 1) * t.maxSteerRad * speedK;
    const maxDelta = t.steerRateRadPerS * dt;
    this.steerAngle += THREE.MathUtils.clamp(target - this.steerAngle, -maxDelta, maxDelta);
    v.setWheelSteering(0, this.steerAngle);
    v.setWheelSteering(1, this.steerAngle);

    // Throttle / brakes.
    const throttle = THREE.MathUtils.clamp(input.throttle, -1, 1);
    let engine = 0;
    let brake = 0;
    if (input.brake) brake = t.handbrakeForce;
    else if (throttle > 0.02) {
      if (this.speed < -0.3)
        brake = t.brakeForce; // moving backwards: brake first
      else engine = throttle * t.engineForce * THREE.MathUtils.clamp(1 - this.speed / t.maxSpeed, 0, 1);
    } else if (throttle < -0.02) {
      if (this.speed > 0.3) brake = t.brakeForce;
      else engine = throttle * t.engineForce * 0.6 * THREE.MathUtils.clamp(1 + this.speed / t.maxReverseSpeed, 0, 1);
    } else if (Math.abs(this.speed) < 0.4) brake = t.brakeForce * 0.25; // creep stop
    for (let i = 0; i < 4; i++) {
      v.setWheelEngineForce(i, engine);
      v.setWheelBrake(i, brake);
    }

    // Hydraulics: held lifts + hop pumps → per-corner rest length.
    if (input.hop) this.hop(input.hop);
    for (let i = 0; i < 4; i++) {
      const lift = THREE.MathUtils.clamp(input.lift[i] ?? 0, 0, 1);
      const pump = this.simTime < this.pumpUntil[i]! ? t.hopPump : 0;
      const rest = t.suspensionRest + lift * t.hydraulicLift + pump;
      if (rest !== this.restLength[i]) {
        this.restLength[i] = rest;
        v.setWheelSuspensionRestLength(i, rest);
      }
    }

    // Wheel rays ignore sensors and kinematic bodies (the character capsule, grabbed props). Note: passing
    // QueryFilterFlags.EXCLUDE_KINEMATIC to updateVehicle makes every wheel ray miss in rapier3d-compat 0.12 (the
    // vehicle path mis-reads that bit), so kinematics are filtered by predicate instead — pinned by the unit test.
    v.updateVehicle(dt, this.physics.R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, notKinematic);
    let n = 0;
    for (let i = 0; i < 4; i++) if (v.wheelIsInContact(i)) n++;
    this.wheelsOnGround = n;
  }

  /** Fire a hop: an upward impulse at each corner in the pattern + a brief spring pump. */
  hop(pattern: HopPattern) {
    const t = this.tuning;
    const corners = HOP_CORNERS[pattern];
    const scale = corners.length === 1 ? 1.15 : corners.length === 4 ? 0.8 : 1;
    const tr = this.body.translation();
    const r = this.body.rotation();
    this.tmpQ.set(r.x, r.y, r.z, r.w);
    for (const i of corners) {
      const p = this.tmpV.copy(this.hardPoints[i]!).applyQuaternion(this.tmpQ);
      this.body.applyImpulseAtPoint({ x: 0, y: t.hopImpulse * scale, z: 0 }, { x: tr.x + p.x, y: tr.y + p.y, z: tr.z + p.z }, true);
      this.pumpUntil[i] = this.simTime + t.hopPumpS;
    }
    this.hops++;
  }

  /** Write the interpolated pose to the visual group and pose the wheels. */
  sync(alpha: number) {
    this.refreshCurrent();
    const a = THREE.MathUtils.clamp(alpha, 0, 1);
    this.group.position.copy(this.prevPos).lerp(this.currPos, a);
    this.group.quaternion.copy(this.prevQuat).slerp(this.currQuat, a);
    const v = this.controller;
    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const wm = this.wheelMeshes[i]!;
      const hp = this.hardPoints[i]!;
      const len = v.wheelSuspensionLength(i) ?? this.tuning.suspensionRest;
      wm.position.set(hp.x, hp.y - len, hp.z);
      wm.rotation.set(0, v.wheelSteering(i) ?? 0, 0);
      const spin = wm.children[0];
      if (spin) spin.rotation.x = -(v.wheelRotation(i) ?? 0);
    }
  }

  /** Chassis centre, interpolated. */
  position(out = new THREE.Vector3(), alpha = this.physics.alpha): THREE.Vector3 {
    this.refreshCurrent();
    return out.copy(this.prevPos).lerp(this.currPos, THREE.MathUtils.clamp(alpha, 0, 1));
  }

  private refreshCurrent() {
    const tr = this.body.translation();
    const r = this.body.rotation();
    this.currPos.set(tr.x, tr.y, tr.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
  }

  /** World forward (−Z of the chassis) from the physics pose. */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    const r = this.body.rotation();
    this.tmpQ.set(r.x, r.y, r.z, r.w);
    return out.set(0, 0, -1).applyQuaternion(this.tmpQ);
  }

  /** Heading around Y (radians, three.js convention: 0 = −Z, +π/2 = −X). */
  get yaw(): number {
    const f = this.forward(this.tmpV);
    return Math.atan2(-f.x, -f.z);
  }

  /** Where the driver steps out (left door), in world space. */
  exitPoint(out = new THREE.Vector3()): THREE.Vector3 {
    const r = this.body.rotation();
    this.tmpQ.set(r.x, r.y, r.z, r.w);
    const tr = this.body.translation();
    return out
      .set(-(this.tuning.halfExtents[0] + 0.7), -this.tuning.halfExtents[1], 0.3)
      .applyQuaternion(this.tmpQ)
      .add(this.tmpV.set(tr.x, tr.y, tr.z));
  }

  /** Driver eye position (world), roll ignored. */
  eye(out = new THREE.Vector3(), alpha = this.physics.alpha): THREE.Vector3 {
    return this.position(out, alpha).add(this.tmpV.set(0, 0.95, 0));
  }

  /** Bounding sphere for framing tests (subjectInFrame). */
  boundingSphere(out = new THREE.Sphere()): THREE.Sphere {
    this.position(out.center);
    out.radius = this.tuning.halfExtents[2] * 1.05;
    return out;
  }

  teleport(position: THREE.Vector3, yaw: number) {
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevPos.copy(position);
    this.currPos.copy(position);
    this.prevQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.currQuat.copy(this.prevQuat);
  }

  dispose() {
    this.physics.world.removeVehicleController(this.controller);
    this.physics.world.removeRigidBody(this.body);
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }

  // ── Placeholder visuals (the Tripo/Blender hero car replaces these in M4; the interface stays) ──────────────────

  private buildVisuals() {
    const t = this.tuning;
    const [hx, hy, hz] = t.halfExtents;
    const paint = new THREE.MeshStandardMaterial({ color: 0xa8143f, roughness: 0.28, metalness: 0.45 }); // candy apple
    const chrome = new THREE.MeshStandardMaterial({ color: 0xe8ecf2, roughness: 0.18, metalness: 0.9 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1a2430, roughness: 0.1, metalness: 0.6 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x14131a, roughness: 0.95 });

    const slab = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), paint);
    slab.name = 'lowrider-body';
    const hood = new THREE.Mesh(new THREE.BoxGeometry(hx * 1.7, hy * 0.5, hz * 0.62), paint);
    hood.position.set(0, hy + hy * 0.25, -hz * 0.55);
    const trunk = new THREE.Mesh(new THREE.BoxGeometry(hx * 1.7, hy * 0.5, hz * 0.5), paint);
    trunk.position.set(0, hy + hy * 0.25, hz * 0.62);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(hx * 1.6, hy * 1.5, hz * 0.78), glass);
    cabin.position.set(0, hy + hy * 0.95, hz * 0.05);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(hx * 1.55, hy * 0.18, hz * 0.7), paint);
    roof.position.set(0, hy + hy * 1.75, hz * 0.05);
    const bumperF = new THREE.Mesh(new THREE.BoxGeometry(hx * 2.1, hy * 0.35, 0.12), chrome);
    bumperF.position.set(0, -hy * 0.55, -hz - 0.04);
    const bumperR = bumperF.clone();
    bumperR.position.z = hz + 0.04;
    const trimL = new THREE.Mesh(new THREE.BoxGeometry(0.03, hy * 0.25, hz * 1.9), chrome);
    trimL.position.set(-hx - 0.01, -hy * 0.1, 0);
    const trimR = trimL.clone();
    trimR.position.x = hx + 0.01;
    this.group.add(slab, hood, trunk, cabin, roof, bumperF, bumperR, trimL, trimR);

    const tyreGeo = new THREE.CylinderGeometry(t.wheelRadius, t.wheelRadius, 0.24, 20);
    tyreGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(t.wheelRadius * 0.62, t.wheelRadius * 0.62, 0.26, 16);
    rimGeo.rotateZ(Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Group(); // steering
      const spin = new THREE.Group(); // rolling
      spin.add(new THREE.Mesh(tyreGeo, rubber), new THREE.Mesh(rimGeo, chrome));
      pivot.add(spin);
      this.group.add(pivot);
      this.wheelMeshes.push(pivot);
    }
  }
}
