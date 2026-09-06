import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraRig, fovForLens } from '../../packages/engine/src/camera/cameraRig';
import { RIG_PRESETS, SHOT_PRESETS } from '../../packages/engine/src/camera/rig';

/** goal.md CAM-6: the director's camera acts — shot presets, moves and lenses tween the rig without a mode change. */
function step(rig: CameraRig, seconds: number, camera = new THREE.PerspectiveCamera()) {
  const target = { feet: new THREE.Vector3(), yaw: 0, eyeHeight: 1.6 };
  const look = { yaw: 0, pitch: 0, zoom: 1 };
  for (let i = 0; i < Math.round(seconds * 60); i++) rig.update(1 / 60, camera, target, look);
  return camera;
}

describe('CameraRig director acts', () => {
  it('"camera low" tweens distance / height / fov to the shot preset over its own duration and keeps the mode', () => {
    const rig = new CameraRig('director');
    step(rig, 0.5);
    expect(rig.applyShot('low', 600)).toBe(true);
    step(rig, 0.3);
    const low = SHOT_PRESETS.find((s) => s.name === 'low')!;
    expect(rig.params.height).toBeGreaterThan(low.height); // mid-tween
    expect(rig.params.height).toBeLessThan(RIG_PRESETS.director.height);
    step(rig, 0.4);
    expect(rig.params.height).toBeCloseTo(low.height, 3);
    expect(rig.params.distance).toBeCloseTo(low.distance, 3);
    expect(rig.params.fovDeg).toBeCloseTo(low.fovDeg, 3);
    expect(rig.mode).toBe('director');
  });

  it('the dutch rolls the camera; the next shot rolls it back', () => {
    const rig = new CameraRig('director');
    step(rig, 0.5);
    rig.applyShot('dutch', 100);
    const cam = step(rig, 0.5);
    expect(rig.rollRad).toBeCloseTo((12 * Math.PI) / 180, 4);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    expect(Math.abs(up.x) + Math.abs(up.z)).toBeGreaterThan(0.1); // no longer level
    rig.applyShot('medium', 100);
    step(rig, 0.5);
    expect(rig.rollRad).toBeCloseTo(0, 4);
  });

  it('moves: push in halves the distance, crane up lifts, orbit sweeps a quarter turn over the duration', () => {
    const rig = new CameraRig('director');
    step(rig, 0.5);
    const d0 = rig.params.distance;
    rig.move('push_in', 200);
    step(rig, 0.5);
    expect(rig.params.distance).toBeCloseTo(d0 * 0.55, 3);
    const h0 = rig.params.height;
    rig.move('crane_up', 200);
    step(rig, 0.5);
    expect(rig.params.height).toBeCloseTo(h0 + 2.5, 3);
    const yaw0 = rig.yaw;
    rig.move('orbit', 1000);
    step(rig, 0.5);
    expect(rig.yaw - yaw0).toBeGreaterThan(0.3);
    expect(rig.yaw - yaw0).toBeLessThan(Math.PI / 2);
    step(rig, 0.6);
    expect(rig.yaw - yaw0).toBeCloseTo(Math.PI / 2, 3);
  });

  it('lenses map focal length to vertical fov (full frame) and none of it applies in first person', () => {
    expect(fovForLens(24)).toBeCloseTo(53.1, 0);
    expect(fovForLens(50)).toBeCloseTo(27, 0);
    expect(fovForLens(85)).toBeCloseTo(16.1, 0);
    const rig = new CameraRig('director');
    rig.lens(85, 100);
    step(rig, 0.3);
    expect(rig.params.fovDeg).toBeCloseTo(fovForLens(85), 3);
    const actor = new CameraRig('actor');
    expect(actor.applyShot('low')).toBe(false);
    expect(actor.move('orbit')).toBe(false);
    expect(actor.lens(35)).toBe(false);
  });
});
