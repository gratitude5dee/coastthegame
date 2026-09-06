/**
 * Kinematic character controller (goal.md PHY-1, ACT-1): capsule + Rapier KinematicCharacterController with
 * autostep, snap-to-ground and slope limits (the `third-person-controller-splat` pattern). Simulation is fixed-step;
 * `interpolated()` returns the render position between the last two steps (STU-1 render interpolation).
 */
import * as THREE from 'three';
import type * as RAPIER_NS from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/world';

export interface CharacterInput {
  /** Desired horizontal move in WORLD space, length ≤ 1 (already rotated by the camera yaw). */
  move: THREE.Vector2;
  jump: boolean;
  sprint: boolean;
}

export interface CharacterOptions {
  radius?: number;
  halfHeight?: number;
  walkSpeed?: number;
  sprintSpeed?: number;
  jumpSpeed?: number;
  gravity?: number;
  start: THREE.Vector3; // feet position
  yaw?: number;
}

export class CharacterController {
  readonly body: RAPIER_NS.RigidBody;
  readonly collider: RAPIER_NS.Collider;
  readonly controller: RAPIER_NS.KinematicCharacterController;
  readonly radius: number;
  readonly halfHeight: number;
  readonly walkSpeed: number;
  readonly sprintSpeed: number;
  readonly jumpSpeed: number;
  readonly gravity: number;

  /** Capsule centre positions for interpolation (previous / current fixed step). */
  private prev = new THREE.Vector3();
  private curr = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  velocityY = 0;
  grounded = false;
  /** Facing (radians, around Y). In actor mode this follows the camera; in director mode it follows movement. */
  yaw: number;
  /** Planar speed of the last step (m/s) — drives animation state later (CHR-2). */
  speed = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    opts: CharacterOptions,
  ) {
    const R = physics.R;
    this.radius = opts.radius ?? 0.35;
    this.halfHeight = opts.halfHeight ?? 0.55;
    this.walkSpeed = opts.walkSpeed ?? 3.2;
    this.sprintSpeed = opts.sprintSpeed ?? 6.0;
    this.jumpSpeed = opts.jumpSpeed ?? 5.2;
    this.gravity = opts.gravity ?? -18; // game gravity: snappier than 9.81 (arcade feel)
    this.yaw = opts.yaw ?? 0;

    const centre = opts.start.clone().add(new THREE.Vector3(0, this.halfHeight + this.radius, 0));
    this.body = physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(centre.x, centre.y, centre.z));
    this.collider = physics.world.createCollider(R.ColliderDesc.capsule(this.halfHeight, this.radius), this.body);
    this.controller = physics.world.createCharacterController(0.02);
    this.controller.enableAutostep(0.45, 0.2, true);
    this.controller.enableSnapToGround(0.5);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(70);
    this.prev.copy(centre);
    this.curr.copy(centre);
  }

  /** Feet position (interpolated). */
  feet(out = new THREE.Vector3(), alpha = this.physics.alpha): THREE.Vector3 {
    return this.interpolated(out, alpha).sub(this.tmp.set(0, this.halfHeight + this.radius, 0));
  }

  /** Capsule centre, interpolated between the last two fixed steps. */
  interpolated(out = new THREE.Vector3(), alpha = this.physics.alpha): THREE.Vector3 {
    return out.copy(this.prev).lerp(this.curr, THREE.MathUtils.clamp(alpha, 0, 1));
  }

  /** One fixed step. Call from PhysicsWorld.step's onStep. */
  step(dt: number, input: CharacterInput) {
    this.prev.copy(this.curr);
    const speed = input.sprint ? this.sprintSpeed : this.walkSpeed;
    const move = input.move.length() > 1 ? input.move.clone().normalize() : input.move;

    if (this.grounded && input.jump) this.velocityY = this.jumpSpeed;
    this.velocityY += this.gravity * dt;
    if (this.velocityY < -25) this.velocityY = -25;

    const desired = { x: move.x * speed * dt, y: this.velocityY * dt, z: move.y * speed * dt };
    this.controller.computeColliderMovement(this.collider, desired, this.physics.R.QueryFilterFlags.EXCLUDE_SENSORS);
    const m = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this.velocityY < 0) this.velocityY = -0.5; // keep pressing into the ground for snap

    const t = this.body.translation();
    this.curr.set(t.x + m.x, t.y + m.y, t.z + m.z);
    this.body.setNextKinematicTranslation({ x: this.curr.x, y: this.curr.y, z: this.curr.z });

    this.speed = Math.hypot(m.x, m.z) / dt;
    if (this.speed > 0.2) this.yaw = Math.atan2(-m.x, -m.z); // three.js forward is -Z
  }

  /** Teleport (respawn, cell change). */
  teleport(feet: THREE.Vector3) {
    const c = feet.clone().add(new THREE.Vector3(0, this.halfHeight + this.radius, 0));
    this.body.setTranslation({ x: c.x, y: c.y, z: c.z }, true);
    this.body.setNextKinematicTranslation({ x: c.x, y: c.y, z: c.z });
    this.prev.copy(c);
    this.curr.copy(c);
    this.velocityY = 0;
  }
}
