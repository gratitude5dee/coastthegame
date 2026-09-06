import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { loadRapier, PhysicsWorld, type GroundGrid, type Rapier } from '../../packages/engine/src/physics/world';
import { Lowrider, liftFromAxes, zeroVehicleInput, type VehicleInput } from '../../packages/engine/src/vehicles/lowrider';

/**
 * goal.md PHY-3: the lowrider is a Rapier raycast vehicle with hydraulics. These tests run the real Rapier WASM in Node
 * and pin the conventions the game relies on — forward is −Z, steer +1 turns right, the chassis rests on its
 * suspension (its own collider is excluded from the wheel rays), a front hop lifts the nose, a held switch raises a
 * corner and it settles again — so a tuning change that flips a sign or floats the car fails here, not on a phone.
 */
let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
}, 30_000);

function rig(opts: { yaw?: number } = {}) {
  const physics = new PhysicsWorld(R);
  const ground = physics.world.createRigidBody(R.RigidBodyDesc.fixed());
  physics.world.createCollider(R.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0), ground);
  const car = new Lowrider(physics, { position: new THREE.Vector3(0, 1.2, 0), yaw: opts.yaw ?? 0, visuals: false });
  const run = (seconds: number, input: Partial<VehicleInput> = {}, each?: (t: number) => void) => {
    const inp = { ...zeroVehicleInput(), ...input };
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i++) {
      car.beforeStep();
      car.step(physics.fixedDt, inp);
      physics.world.step();
      inp.hop = null; // edge
      each?.(i / 60);
    }
  };
  const pos = () => {
    const t = car.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  };
  return { physics, car, run, pos };
}

describe('Lowrider (PHY-3)', () => {
  it('settles on its suspension with all four wheels down', () => {
    const { car, run, pos } = rig();
    run(2);
    const p = pos();
    expect(car.wheelsOnGround).toBe(4);
    // hard point (−0.1) + rest 0.35 − static compression ≈ g/(4k) ≈ 0.1 → wheel centre ≈ −0.36; + radius 0.33 ≈ 0.69 m
    expect(p.y).toBeGreaterThan(0.55);
    expect(p.y).toBeLessThan(0.85);
    run(1);
    expect(Math.abs(pos().y - p.y)).toBeLessThan(0.005); // no bounce, no sink (a stale sleeping velocity would show here)
    const v = car.body.linvel();
    expect(Math.hypot(v.x, v.z)).toBeLessThan(0.05);
    expect(car.body.isSleeping()).toBe(false);
  });

  it('drives forward along −Z under throttle and reports a positive signed speed', () => {
    const { car, run, pos } = rig();
    run(1.5);
    const p0 = pos();
    run(2, { throttle: 1 });
    const p1 = pos();
    expect(p1.z - p0.z).toBeLessThan(-6);
    expect(Math.abs(p1.x - p0.x)).toBeLessThan(0.5);
    expect(car.speed).toBeGreaterThan(5);
    expect(car.speed).toBeLessThanOrEqual(car.tuning.maxSpeed + 0.5);
  });

  it('respects the heading it was spawned with', () => {
    const { run, pos } = rig({ yaw: Math.PI / 2 }); // facing −X
    run(1.5);
    const p0 = pos();
    run(1.5, { throttle: 1 });
    const p1 = pos();
    expect(p1.x - p0.x).toBeLessThan(-4);
    expect(Math.abs(p1.z - p0.z)).toBeLessThan(0.5);
  });

  it('steer +1 turns right (yaw decreases) and −1 turns left', () => {
    for (const [steer, sign] of [
      [1, -1],
      [-1, 1],
    ] as const) {
      const { car, run } = rig();
      run(1.5);
      const yaw0 = car.yaw;
      run(1.2, { throttle: 1, steer });
      const dyaw = Math.atan2(Math.sin(car.yaw - yaw0), Math.cos(car.yaw - yaw0));
      expect(Math.sign(dyaw)).toBe(sign);
      expect(Math.abs(dyaw)).toBeGreaterThan(0.15);
      expect(car.wheelsOnGround).toBeGreaterThanOrEqual(3); // no rollover at full lock
    }
  });

  it('brakes to a stop from speed and reverses under negative throttle', () => {
    const { car, run } = rig();
    run(1.5);
    run(2, { throttle: 1 });
    run(2, { throttle: 0, brake: true });
    expect(Math.abs(car.speed)).toBeLessThan(0.5);
    run(2, { throttle: -1 });
    expect(car.speed).toBeLessThan(-1.5);
    expect(car.speed).toBeGreaterThanOrEqual(-car.tuning.maxReverseSpeed - 0.5);
  });

  it('a front hop lifts the nose well above rest and comes back down', () => {
    const { car, run, pos } = rig();
    run(2);
    const restY = pos().y;
    // Pitch lifts the front: measure the front hard-point height in world space.
    const nose = () => {
      const t = car.body.translation();
      const r = car.body.rotation();
      const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
      const p = new THREE.Vector3(0, car.tuning.hardPointY, -car.tuning.wheelBase / 2).applyQuaternion(q);
      return t.y + p.y;
    };
    const noseRest = nose();
    let peak = -Infinity;
    run(0.9, { hop: 'front' }, () => (peak = Math.max(peak, nose())));
    expect(peak - noseRest).toBeGreaterThan(0.4);
    expect(peak - noseRest).toBeLessThan(1.4);
    expect(car.hops).toBe(1);
    run(2.5);
    expect(Math.abs(pos().y - restY)).toBeLessThan(0.08);
    expect(car.wheelsOnGround).toBe(4);
  });

  it('holding a switch raises that side and it settles; releasing drops it', () => {
    const { car, run } = rig();
    run(2);
    const rearRest = car.controller.wheelSuspensionLength(2)!;
    const frontRest = car.controller.wheelSuspensionLength(0)!;
    run(2, { lift: liftFromAxes(0, 1) }); // front up
    expect(car.controller.wheelSuspensionLength(0)! - frontRest).toBeGreaterThan(0.15);
    expect(Math.abs(car.controller.wheelSuspensionLength(2)! - rearRest)).toBeLessThan(0.08);
    run(2, { lift: [0, 0, 0, 0] });
    expect(Math.abs(car.controller.wheelSuspensionLength(0)! - frontRest)).toBeLessThan(0.05);
  });

  it('maps the switchbox axes to corners', () => {
    expect(liftFromAxes(0, 1)).toEqual([1, 1, 0, 0]);
    expect(liftFromAxes(0, -1)).toEqual([0, 0, 1, 1]);
    expect(liftFromAxes(-1, 0)).toEqual([1, 0, 1, 0]);
    expect(liftFromAxes(1, 0)).toEqual([0, 1, 0, 1]);
    expect(liftFromAxes(1, 1)).toEqual([1, 1, 0, 1]); // front-right corner highest, right side + front
  });

  it('exit point is beside the left door at chassis-bottom height', () => {
    const { car, run } = rig();
    run(2);
    const e = car.exitPoint();
    const p = car.body.translation();
    expect(e.x).toBeLessThan(p.x - car.tuning.halfExtents[0]);
    expect(Math.abs(e.z - p.z)).toBeLessThan(0.6);
    expect(e.y).toBeLessThan(p.y);
  });

  it('stays on the block: the ground-grid fence stops a full-throttle run at the edge', () => {
    const physics = new PhysicsWorld(R);
    const cols = 41; // 30 m × 30 m flat grid centred on the origin
    const grid: GroundGrid = { heights: new Float32Array(cols * cols), cols, rows: cols, minX: -15, minZ: -15, cellSize: 0.75 };
    physics.addGroundGrid(grid);
    expect(physics.addFence(grid, 4)).toHaveLength(4);
    const car = new Lowrider(physics, { position: new THREE.Vector3(0, 1.2, 0), visuals: false });
    const inp = { ...zeroVehicleInput(), throttle: 1 };
    for (let i = 0; i < 6 * 60; i++) {
      car.beforeStep();
      car.step(physics.fixedDt, inp);
      physics.world.step();
    }
    const t = car.body.translation();
    expect(t.z).toBeGreaterThan(-15 - 0.5); // pinned against the −Z wall, not through it
    expect(t.z).toBeLessThan(-9);
    expect(t.y).toBeGreaterThan(0); // did not fall off
    expect(Math.abs(car.speed)).toBeLessThan(1);
  });
});
