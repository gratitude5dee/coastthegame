import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  OPENPOSE_COLORS,
  OPENPOSE_KEYPOINTS,
  OPENPOSE_LIMBS,
  cameraFrame,
  cameraIntrinsics,
  cameraJson,
  controlFrameTime,
  decodeDepth,
  encodeDepth,
  planControl,
  projectPoint,
  skeletonFor,
} from '../../packages/studio/src/control';
import { planCut } from '../../packages/studio/src/export';

/** goal.md STU-2: control passes for a ≤ 5 s span at ≤ 720p — depth (linear, near white), pose (OpenPose), camera.json. */
describe('control passes (STU-2)', () => {
  it('plans a span: clipped to the cut, at most 5 s, the short side ≤ 720, even sizes, the cut’s fps', () => {
    const cut = planCut({ durationS: 20, fps: 30 }); // 1920×1080
    const p = planControl(cut, { startS: 3, endS: 12 });
    expect(p).toMatchObject({ fps: 30, width: 1280, height: 720, startS: 3, endS: 8, frameCount: 150, near: 0.25, far: 60 });
    expect(planControl(cut, { startS: 18, endS: 40 }).endS).toBe(20); // clipped to the cut
    expect(planControl(cut, { startS: 12, endS: 3 }).startS).toBe(3); // a backwards span is put right
    const portrait = planControl(planCut({ durationS: 10, fps: 24, width: 1080, height: 1920 }), { startS: 0, endS: 2 }, { far: 40 });
    expect(portrait).toMatchObject({ width: 720, height: 1280, frameCount: 48, far: 40 });
    const small = planControl(planCut({ durationS: 10, fps: 10, width: 640, height: 360 }), { startS: 0, endS: 1 });
    expect(small).toMatchObject({ width: 640, height: 360, frameCount: 10 }); // never upscaled
    expect(controlFrameTime(p, 30)).toBe(4);
    expect(planControl(cut, { startS: 5, endS: 5 }).frameCount).toBe(0);
  });

  it('depth is linear between near and far, near white; the camera file says so', () => {
    expect(encodeDepth(0.25, 0.25, 60)).toBe(1);
    expect(encodeDepth(60, 0.25, 60)).toBe(0);
    expect(encodeDepth(30.125, 0.25, 60)).toBeCloseTo(0.5, 9);
    expect(encodeDepth(-3, 0.25, 60)).toBe(1); // clamped
    expect(encodeDepth(500, 0.25, 60)).toBe(0);
    expect(decodeDepth(encodeDepth(12.5, 0.25, 60), 0.25, 60)).toBeCloseTo(12.5, 9);
    const plan = planControl(planCut({ durationS: 4, fps: 30 }), { startS: 0, endS: 2 }, { near: 0.5, far: 80 });
    const file = cameraJson(plan);
    expect(file).toMatchObject({
      v: 1,
      fps: 30,
      width: 1280,
      height: 720,
      depth: { encoding: 'linear-near-white', near: 0.5, far: 80 },
      frames: [],
    });
  });

  it('intrinsics come from the vertical field of view; a frame carries the pose and them', () => {
    const k = cameraIntrinsics(90, 1280, 720);
    expect(k.fy).toBeCloseTo(360, 6); // tan(45°) = 1
    expect(k.fx).toBe(k.fy);
    expect(k).toMatchObject({ cx: 640, cy: 360 });
    const plan = planControl(planCut({ durationS: 4, fps: 30 }), { startS: 1, endS: 2 });
    const f = cameraFrame(plan, 0.5, [1, 2, 3], [0, 0, 0, 1], 50);
    expect(f).toMatchObject({ t: 0.5, pos: [1, 2, 3], quat: [0, 0, 0, 1], fovDeg: 50, cx: 640, cy: 360 });
    expect(f.fy).toBeCloseTo(360 / Math.tan((25 * Math.PI) / 180), 6);
  });

  it('projects world points exactly like a three.js PerspectiveCamera (pixels, y down; behind the camera flagged)', () => {
    const plan = planControl(planCut({ durationS: 4, fps: 30 }), { startS: 0, endS: 1 });
    const cam = new THREE.PerspectiveCamera(50, plan.width / plan.height, 0.1, 100);
    cam.position.set(2, 1.6, 5);
    cam.rotation.set(-0.2, 0.7, 0.1, 'YXZ');
    cam.updateMatrixWorld();
    const q = cam.quaternion;
    const frame = cameraFrame(plan, 0, [2, 1.6, 5], [q.x, q.y, q.z, q.w], 50);
    for (const p of [
      [0, 0, 0],
      [-3, 1, -4],
      [4, 2.5, -1],
    ] as [number, number, number][]) {
      const ndc = new THREE.Vector3(...p).project(cam);
      const expectedX = ((ndc.x + 1) / 2) * plan.width;
      const expectedY = ((1 - ndc.y) / 2) * plan.height;
      const got = projectPoint(p, frame);
      expect(got.x).toBeCloseTo(expectedX, 3);
      expect(got.y).toBeCloseTo(expectedY, 3);
      expect(got.z).toBeGreaterThan(0);
    }
    const behind = projectPoint([2, 1.6, 20], frame); // roughly behind a camera looking down −Z-ish
    const ndc = new THREE.Vector3(2, 1.6, 20).applyMatrix4(cam.matrixWorldInverse);
    expect(behind.z).toBeCloseTo(-ndc.z, 6);
  });

  it('the skeleton is an 18-keypoint OpenPose figure: right limbs on the person’s right, standing tall, walking when it moves', () => {
    expect(OPENPOSE_LIMBS).toHaveLength(17);
    expect(OPENPOSE_COLORS).toHaveLength(18);
    for (const [a, b] of OPENPOSE_LIMBS) {
      expect(a).toBeLessThan(OPENPOSE_KEYPOINTS);
      expect(b).toBeLessThan(OPENPOSE_KEYPOINTS);
    }
    // Facing −Z (yaw 0): the person's right is +X.
    const s = skeletonFor({ feet: [0, 0, 0], yaw: 0, height: 1.75 });
    expect(s).toHaveLength(18);
    expect(s[0]![1]).toBeCloseTo(0.93 * 1.75, 6); // nose height
    expect(s[1]![1]).toBeCloseTo(0.82 * 1.75, 6); // neck
    expect(s[2]![0]).toBeGreaterThan(0); // right shoulder at +X
    expect(s[5]![0]).toBeLessThan(0); // left shoulder at −X
    expect(s[10]![1]).toBeCloseTo(0.53 * 1.75 - 0.26 * 1.75 - 0.25 * 1.75, 6); // ankle at hip − thigh − shin, standing
    expect(s[10]![1]).toBeGreaterThan(0);
    expect(s[0]![2]).toBeLessThan(0); // the nose points the way it faces (−Z)
    // Turned to face +X (yaw −π/2): the right shoulder is now at +Z.
    const t = skeletonFor({ feet: [5, 0, 5], yaw: -Math.PI / 2 });
    expect(t[2]![2]).toBeGreaterThan(5);
    expect(t[0]![0]).toBeGreaterThan(5);
    // Walking: the legs swing apart and the ankles lift; standing still they hang straight.
    const walk = skeletonFor({ feet: [0, 0, 0], yaw: 0, speed: 1.5, t: 0.2 });
    const rightAnkleZ = walk[10]![2];
    const leftAnkleZ = walk[13]![2];
    expect(Math.abs(rightAnkleZ - leftAnkleZ)).toBeGreaterThan(0.15);
    expect(Math.abs(s[10]![2] - s[13]![2])).toBeLessThan(1e-9);
    // A taller actor scales with its height.
    expect(skeletonFor({ feet: [0, 0, 0], yaw: 0, height: 2 })[1]![1]).toBeCloseTo(1.64, 6);
  });
});
