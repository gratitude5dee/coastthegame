import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  SnapTurn,
  TeleportArm,
  dioramaPlacement,
  frameOffsetXZ,
  framePositionForHead,
  snapTurnShift,
  tablePoint,
  yawOf,
} from '../../packages/engine/src/xr/locomotion';

/** goal.md CAM-3/CAM-4: the frame moves, the head stays put, the diorama lands on the table. */
describe('XR locomotion math', () => {
  it('rotates frame-local head offsets into world XZ with three.js yaw conventions', () => {
    const head = new THREE.Vector3(1, 1.6, 0); // 1 m to the right of the frame origin
    expect(frameOffsetXZ(0, head).toArray()).toEqual([1, 0]);
    const r = frameOffsetXZ(Math.PI / 2, head); // frame turned left: local +X now points toward world −Z
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y).toBeCloseTo(-1, 6);
    // Cross-check against three's own rotation.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
    const v = head.clone().applyQuaternion(q);
    const o = frameOffsetXZ(0.7, head);
    expect(o.x).toBeCloseTo(v.x, 6);
    expect(o.y).toBeCloseTo(v.z, 6);
  });

  it('snap-turn shift keeps the head in place: frame rotated + body shifted = same head world position', () => {
    const feet = new THREE.Vector3(3, 0, -2);
    const head = new THREE.Vector3(0.6, 1.6, -0.4);
    const yaw = 0.3;
    const delta = -Math.PI / 6;
    const before = new THREE.Vector3(feet.x + frameOffsetXZ(yaw, head).x, 0, feet.z + frameOffsetXZ(yaw, head).y);
    const shift = snapTurnShift(yaw, delta, head);
    const newFeet = feet.clone().add(new THREE.Vector3(shift.x, 0, shift.y));
    const after = new THREE.Vector3(newFeet.x + frameOffsetXZ(yaw + delta, head).x, 0, newFeet.z + frameOffsetXZ(yaw + delta, head).y);
    expect(after.distanceTo(before)).toBeLessThan(1e-9);
  });

  it('places the frame so the head stands over the feet (capsule follows head)', () => {
    const feet = new THREE.Vector3(5, 1.2, 7);
    const head = new THREE.Vector3(0.8, 1.7, 0.3);
    const p = framePositionForHead(feet, 1.1, head);
    const headWorld = frameOffsetXZ(1.1, head);
    expect(p.x + headWorld.x).toBeCloseTo(feet.x, 9);
    expect(p.z + headWorld.y).toBeCloseTo(feet.z, 9);
    expect(p.y).toBe(1.2);
  });

  it('reads yaw from a quaternion (−Z forward)', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.9);
    expect(yawOf(q)).toBeCloseTo(0.9, 6);
  });

  it('diorama placement maps the anchor onto the table at 1:12', () => {
    const feet = new THREE.Vector3(10, 2, -30);
    const head = new THREE.Vector3(10, 3.6, -30);
    const table = tablePoint(head, 0, 0.7, 0.55);
    expect(table.toArray()).toEqual([10, 3.05, -30.7]);
    const d = dioramaPlacement(feet, table, 1 / 12);
    const mapped = feet.clone().multiplyScalar(d.scale).add(d.position);
    expect(mapped.distanceTo(table)).toBeLessThan(1e-9);
  });

  it('snap turn fires once per flick and re-arms after the stick returns', () => {
    const s = new SnapTurn(Math.PI / 6);
    expect(s.update(0)).toBe(0);
    expect(s.update(0.9)).toBeCloseTo(-Math.PI / 6, 9); // right → clockwise → yaw decreases
    expect(s.update(1)).toBe(0); // held: no repeat
    expect(s.update(0.5)).toBe(0); // hysteresis band
    expect(s.update(0.1)).toBe(0); // re-armed
    expect(s.update(-0.8)).toBeCloseTo(Math.PI / 6, 9);
  });

  it('teleport arms on a forward push and fires on release', () => {
    const t = new TeleportArm();
    expect(t.update(0)).toBe('idle');
    expect(t.update(-0.2)).toBe('idle');
    expect(t.update(-0.9)).toBe('aim');
    expect(t.update(-0.5)).toBe('aim');
    expect(t.update(-0.1)).toBe('go');
    expect(t.update(-0.1)).toBe('idle');
    expect(t.update(-1)).toBe('aim');
    t.cancel();
    expect(t.update(-0.5)).toBe('idle');
  });
});
