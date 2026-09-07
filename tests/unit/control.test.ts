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
  poseKeypointsFor,
  projectPoint,
  skeletonFor,
  type ActorPose,
  type PoseSources,
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

  it.each([
    { fps: NaN },
    { fps: Infinity },
    { fps: 0 },
    { fps: 61 },
    { width: NaN },
    { height: Infinity },
    { width: 0 },
    { height: 1.5 },
    { startS: NaN },
    { startS: -1 },
    { endS: Infinity },
    { endS: -1 },
    { frameCount: NaN },
    { cameraLayer: Infinity },
  ])('rejects malformed cut inputs: %j', (bad) => {
    const cut = { ...planCut({ durationS: 20 }), ...bad };
    expect(() => planControl(cut, { startS: 1, endS: 2 })).toThrow();
  });

  it.each([
    { startS: NaN, endS: 2 },
    { startS: 1, endS: Infinity },
    { startS: -Infinity, endS: 2 },
  ])('rejects nonfinite spans: %j', (span) => {
    expect(() => planControl(planCut({ durationS: 20 }), span)).toThrow();
  });

  it.each([
    { maxSeconds: NaN },
    { maxSeconds: Infinity },
    { maxSeconds: -1 },
    { maxShortSide: NaN },
    { maxShortSide: Infinity },
    { maxShortSide: -1 },
    { maxShortSide: 1 },
    { near: NaN },
    { near: Infinity },
    { near: -1 },
    { far: NaN },
    { far: Infinity },
    { near: 1, far: 1 },
    { near: 2, far: 1 },
    { far: 0 },
  ])('rejects invalid options before planning: %j', (options) => {
    expect(() => planControl(planCut({ durationS: 20 }), { startS: 1, endS: 2 }, options)).toThrow();
  });

  it.each([
    [3840, 2160, 1280, 720],
    [2160, 3840, 720, 1280],
  ])('caps both orientations despite oversized overrides: %s x %s', (width, height, expectedWidth, expectedHeight) => {
    const cut = planCut({ durationS: 20, width, height });
    const p = planControl(cut, { startS: 1, endS: 15 }, { maxSeconds: 60, maxShortSide: 4096, near: 0 });
    expect(p).toMatchObject({ width: expectedWidth, height: expectedHeight, startS: 1, endS: 6, frameCount: 150, near: 0 });
  });

  it.each([
    [1e12, 2],
    [2, 1e12],
    [Number.MAX_VALUE, 2],
    [1e12, 1e12],
    [1279, 719],
  ])('bounds pathological dimensions with even output sizes: %s x %s', (width, height) => {
    const p = planControl(planCut({ durationS: 20, width, height }), { startS: 0, endS: 1 });
    expect(Math.min(p.width, p.height)).toBeLessThanOrEqual(720);
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(1280);
    for (const size of [p.width, p.height]) {
      expect(size).toBeGreaterThanOrEqual(2);
      expect(size % 2).toBe(0);
    }
    expect(p.width).toBeLessThanOrEqual(width);
    expect(p.height).toBeLessThanOrEqual(height);
  });

  it.each([24, 30, 60])('floors nonaligned spans and smaller overrides without exceeding their end at %s fps', (fps) => {
    const cut = planCut({ durationS: 20, fps });
    const startS = 3;
    const endS = startS + 2.9 / fps;
    const p = planControl(cut, { startS, endS });
    expect(p.frameCount).toBe(2);
    expect(p.endS).toBeLessThanOrEqual(endS);
    expect(planControl(cut, { startS: endS, endS: startS })).toEqual(p);
    const shorter = planControl(cut, { startS, endS: 10 }, { maxSeconds: 2.9 / fps, maxShortSide: 359.5 });
    expect(shorter.frameCount).toBe(2);
    expect(shorter.endS).toBeLessThanOrEqual(endS);
    expect(Math.min(shorter.width, shorter.height)).toBeLessThanOrEqual(359.5);
    const clipped = planControl({ ...cut, endS }, { startS, endS: 10 });
    expect(clipped.frameCount).toBe(2);
    expect(clipped.endS).toBeLessThanOrEqual(endS);
  });

  it('preserves aligned fractional times and empty spans, including spans wholly before a cut', () => {
    const cut = planCut({ durationS: 20, fps: 30 });
    expect(planControl(cut, { startS: 0.1, endS: 0.3 }).frameCount).toBe(6);
    expect(planControl(cut, { startS: 1, endS: 1 }).frameCount).toBe(0);
    expect(planControl(cut, { startS: 0, endS: 0.01 }).frameCount).toBe(0);
    expect(planControl(cut, { startS: 0, endS: 1 }, { maxSeconds: 0 }).frameCount).toBe(0);
    expect(planControl({ ...cut, startS: 3 }, { startS: -2, endS: 1 })).toMatchObject({ startS: 3, endS: 3, frameCount: 0 });
    expect(planControl(planCut({ durationS: 0 }), { startS: 0, endS: 1 })).toMatchObject({ startS: 0, endS: 0, frameCount: 0 });
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

  it('uses actual canonical rig landmarks without reapplying the root pose or fabricating facial points', () => {
    const names = [
      'Neck',
      'RightArm',
      'RightForeArm',
      'RightHand',
      'LeftArm',
      'LeftForeArm',
      'LeftHand',
      'RightUpLeg',
      'RightLeg',
      'RightFoot',
      'LeftUpLeg',
      'LeftLeg',
      'LeftFoot',
      'RightEye',
      'LeftEye',
    ];
    const rigJoints: NonNullable<ActorPose['rigJoints']> = Object.fromEntries(
      names.map((name, i) => [`mixamorig${name}`, [i + 1, i + 2, -i - 3]]),
    );
    Object.assign(rigJoints, {
      mixamorigRightShoulder: [90, 91, 92],
      mixamorigLeftShoulder: [93, 94, 95],
      mixamorigHead: [96, 97, 98],
      mixamorigNose: [99, 100, 101],
      mixamorigRightEar: [102, 103, 104],
      mixamorigLeftEar: [105, 106, 107],
    });
    const actor: ActorPose = { feet: [50, 60, 70], yaw: 1.2, height: 3, speed: 6, t: 9, rigJoints };
    const result = poseKeypointsFor(actor);
    expect(result.source).toBe('rig');
    expect(result.points).toEqual([null, ...names.map((name) => rigJoints[`mixamorig${name}`]), null, null]);
    for (const [i, name] of names.entries()) expect(result.points[i + 1]).not.toBe(rigJoints[`mixamorig${name}`]);
    rigJoints.mixamorigRightForeArm = [20, 30, 40];
    rigJoints.mixamorigLeftHand = [-10, 3, -8];
    const changed = poseKeypointsFor(actor);
    expect(changed.points[3]).toEqual([20, 30, 40]);
    expect(changed.points[7]).toEqual([-10, 3, -8]);
    expect(changed.points[3]).not.toEqual(result.points[3]);
    expect(changed.points[7]).not.toEqual(result.points[7]);
    changed.points[3]![0] = 999;
    expect(rigJoints.mixamorigRightForeArm).toEqual([20, 30, 40]);
  });

  it('keeps absent neck and eyes null and draws only known joints in partial rigs', () => {
    const actor: ActorPose = {
      feet: [0, 0, 0],
      yaw: 0,
      rigJoints: { mixamorigRightForeArm: [1, 2, 3], mixamorigHead: [4, 5, 6], mixamorigSpine2: [7, 8, 9] },
    };
    const result = poseKeypointsFor(actor);
    expect(result.source).toBe('rig');
    expect(result.points).toEqual(Array.from({ length: 18 }, (_, i) => (i === 3 ? [1, 2, 3] : null)));
    actor.rigJoints!.mixamorigLeftEye = [4, 5, 6];
    expect(poseKeypointsFor(actor).points[14]).toBeNull();
    expect(poseKeypointsFor(actor).points[15]).toEqual([4, 5, 6]);
  });

  it.each<ActorPose['rigJoints']>([
    null,
    {},
    { arbitrary_joint: [1, 2, 3] },
    { mixamorigHips: [1, 2, 3], mixamorigHead: [4, 5, 6], mixamorigRightShoulder: [7, 8, 9] },
    { mixamorigRightEye: [1, 2, 3], mixamorigLeftEye: [4, 5, 6] },
    { RightHand: [1, 2, 3], 'mixamorig:LeftHand': [4, 5, 6] },
  ])('omits known unrigged or unrecognized body mappings: %j', (rigJoints) => {
    expect(poseKeypointsFor({ feet: [0, 0, 0], yaw: 0, speed: 3, t: 0.2, rigJoints })).toEqual({
      source: 'omitted',
      points: Array(18).fill(null),
    });
  });

  it.each(
    [
      NaN,
      Infinity,
      -Infinity,
      undefined,
      null,
      '3',
      [],
      [1, 2],
      [1, 2, 3, 4],
      new Array(3),
      [1, NaN, 3],
      [NaN, 2, 3],
      [1, 2, Infinity],
    ].map((entry) => ({ entry })),
  )('rejects malformed or nonfinite joint entries before projection: $entry', ({ entry }) => {
    for (const name of ['mixamorigRightHand', 'mixamorigRightEye', 'unknown']) {
      const rigJoints = { [name]: entry } as unknown as NonNullable<ActorPose['rigJoints']>;
      expect(() => poseKeypointsFor({ feet: [0, 0, 0], yaw: 0, rigJoints })).toThrow(/rig joint.*finite/i);
    }
  });

  it('preserves the exact legacy skeleton fallback and counts sources in actor-frame units', () => {
    const actors: ActorPose[] = [
      { feet: [0, 0, 0], yaw: 0 },
      { feet: [5, 2, -3], yaw: -Math.PI / 2, height: 2, speed: 1.5, t: 0.2 },
      { feet: [-7, 1, 4], yaw: 0.7, speed: 6, t: 2.4 },
    ];
    const sources: PoseSources = { unit: 'actor-frame', rig: 0, procedural: 0, omitted: 0 };
    for (const actor of actors) {
      const result = poseKeypointsFor(actor);
      expect(result).toEqual({ points: skeletonFor(actor), source: 'procedural' });
      sources[result.source]++;
      expect(skeletonFor({ ...actor, rigJoints: null })).toEqual(result.points);
      expect(skeletonFor({ ...actor, rigJoints: {} })).toEqual(result.points);
    }
    expect(sources).toEqual({ unit: 'actor-frame', rig: 0, procedural: 3, omitted: 0 });
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
