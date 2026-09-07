/**
 * Control passes (goal.md STU-2): what a faithful render (Wan VACE, GEN-6) is given besides the beauty clip — for a
 * span of ≤ 5 s at ≤ 720p, 8-bit, as short control videos: `depth` (linearised between a per-clip near/far, near
 * white), `pose` (a 2D OpenPose-style skeleton per actor) and `camera.json` (intrinsics + extrinsics per frame).
 * This module is the pure half: the span plan, the camera file, the depth encoding and the skeleton (the actors are
 * capsules until the rigs land — M4 — so the skeleton is a procedural figure on the actor's root pose, walking with its
 * speed; the bone tracks replace `skeletonFor` then). The exporter in `apps/web` renders and encodes.
 */
import type { CutPlan } from './export';
import type { PassName } from './index';

/** The passes a faithful render takes today (`normal` / `id` are optional compositing passes for later). */
export type ControlPass = Extract<PassName, 'depth' | 'pose'>;

export const CONTROL_MAX_SECONDS = 5;
export const CONTROL_MAX_SHORT_SIDE = 720;

export interface ControlSpan {
  startS: number;
  endS: number;
}

export interface ControlPlan {
  fps: number;
  width: number;
  height: number;
  startS: number;
  endS: number;
  frameCount: number;
  /** Depth linearisation range, metres from the camera. */
  near: number;
  far: number;
}

export interface ControlPlanOptions {
  near?: number;
  far?: number;
  maxSeconds?: number;
  maxShortSide?: number;
}

/** The span of a cut a faithful render gets: clipped to the cut, at most 5 s, the picture no taller/wider than 720 on its short side. */
export function planControl(cut: CutPlan, span: ControlSpan, o: ControlPlanOptions = {}): ControlPlan {
  const maxS = o.maxSeconds ?? CONTROL_MAX_SECONDS;
  const startS = Math.min(cut.endS, Math.max(cut.startS, Math.min(span.startS, span.endS)));
  const endS = Math.min(cut.endS, Math.max(span.startS, span.endS), startS + maxS);
  const frameCount = Math.max(0, Math.round((endS - startS) * cut.fps));
  const short = Math.min(cut.width, cut.height);
  const scale = Math.min(1, (o.maxShortSide ?? CONTROL_MAX_SHORT_SIDE) / short);
  const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
  return {
    fps: cut.fps,
    width: even(cut.width),
    height: even(cut.height),
    startS,
    endS: startS + frameCount / cut.fps,
    frameCount,
    near: o.near ?? 0.25,
    far: o.far ?? 60,
  };
}

export function controlFrameTime(plan: ControlPlan, i: number): number {
  return plan.startS + i / plan.fps;
}

// ── camera.json ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CameraIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

/** Pinhole intrinsics in pixels from a vertical field of view (square pixels, principal point at the centre). */
export function cameraIntrinsics(fovDeg: number, width: number, height: number): CameraIntrinsics {
  const fy = height / 2 / Math.tan((fovDeg * Math.PI) / 360);
  return { fx: fy, fy, cx: width / 2, cy: height / 2 };
}

export interface CameraFrame extends CameraIntrinsics {
  /** Seconds from the start of the span. */
  t: number;
  /** World position and orientation (three.js: the camera looks down its −Z). */
  pos: [number, number, number];
  quat: [number, number, number, number];
  fovDeg: number;
}

export interface CameraJson {
  v: 1;
  fps: number;
  width: number;
  height: number;
  /** Depth control video encoding: `value = 1 − (z − near) / (far − near)`, z = metres along the view axis — near is white. */
  depth: { encoding: 'linear-near-white'; near: number; far: number };
  frames: CameraFrame[];
}

export function cameraJson(plan: ControlPlan): CameraJson {
  return {
    v: 1,
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    depth: { encoding: 'linear-near-white', near: plan.near, far: plan.far },
    frames: [],
  };
}

export function cameraFrame(
  plan: ControlPlan,
  t: number,
  pos: [number, number, number],
  quat: [number, number, number, number],
  fovDeg: number,
): CameraFrame {
  return { t, pos, quat, fovDeg, ...cameraIntrinsics(fovDeg, plan.width, plan.height) };
}

// ── depth ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Metres along the view axis → the 0..1 depth value (near = 1, far = 0), what the depth video stores in 8 bits. */
export function encodeDepth(z: number, near: number, far: number): number {
  const v = 1 - (z - near) / Math.max(1e-6, far - near);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function decodeDepth(v: number, near: number, far: number): number {
  return near + (1 - v) * (far - near);
}

// ── pose (OpenPose COCO-18) ──────────────────────────────────────────────────────────────────────────────────────────

/** Keypoints: 0 nose · 1 neck · 2/3/4 right shoulder/elbow/wrist · 5/6/7 left · 8/9/10 right hip/knee/ankle · 11/12/13 left · 14/15 eyes · 16/17 ears. */
export const OPENPOSE_KEYPOINTS = 18;

/** Limbs as keypoint pairs, in OpenPose's order (so the colours below line up). */
export const OPENPOSE_LIMBS: readonly [number, number][] = [
  [1, 2],
  [1, 5],
  [2, 3],
  [3, 4],
  [5, 6],
  [6, 7],
  [1, 8],
  [8, 9],
  [9, 10],
  [1, 11],
  [11, 12],
  [12, 13],
  [1, 0],
  [0, 14],
  [14, 16],
  [0, 15],
  [15, 17],
];

/** The limb colours OpenPose renders with (what pose-control models were trained on). */
export const OPENPOSE_COLORS: readonly [number, number, number][] = [
  [255, 0, 0],
  [255, 85, 0],
  [255, 170, 0],
  [255, 255, 0],
  [170, 255, 0],
  [85, 255, 0],
  [0, 255, 0],
  [0, 255, 85],
  [0, 255, 170],
  [0, 255, 255],
  [0, 170, 255],
  [0, 85, 255],
  [0, 0, 255],
  [85, 0, 255],
  [170, 0, 255],
  [255, 0, 255],
  [255, 0, 170],
  [255, 0, 85],
];

export interface ActorPose {
  /** Where the actor stands (world), and the way it faces (radians, the game's yaw: forward = (−sin, 0, −cos)). */
  feet: [number, number, number];
  yaw: number;
  /** Standing height in metres (default 1.75) and walking speed for the gait (m/s). */
  height?: number;
  speed?: number;
  /** Set time, for the gait phase. */
  t?: number;
}

const STRIDE_M = 1.3;

/**
 * A figure on the actor's root pose: 18 world-space keypoints of a person `height` tall facing `yaw`, legs and arms
 * swinging with the walk when it moves (a phase from the distance walked). Right-hand keypoints are the person's right.
 */
export function skeletonFor(a: ActorPose): [number, number, number][] {
  const H = a.height ?? 1.75;
  const [x0, y0, z0] = a.feet;
  const fx = -Math.sin(a.yaw);
  const fz = -Math.cos(a.yaw);
  const rx = Math.cos(a.yaw);
  const rz = -Math.sin(a.yaw);
  const speed = a.speed ?? 0;
  const moving = speed > 0.2;
  const phase = moving ? (((a.t ?? 0) * speed) / STRIDE_M) * Math.PI * 2 : 0;
  const swing = moving ? Math.min(0.5, 0.25 + speed * 0.1) : 0;
  const legR = Math.sin(phase) * swing;
  const legL = -legR;
  const armR = -legR * 0.8;
  const armL = -legL * 0.8;
  const p = (up: number, side: number, fwd: number): [number, number, number] => [
    x0 + rx * side + fx * fwd,
    y0 + up,
    z0 + rz * side + fz * fwd,
  ];
  const hipY = 0.53 * H;
  const neckY = 0.82 * H;
  const shoulderHalf = 0.12 * H;
  const hipHalf = 0.08 * H;
  const upperArm = 0.19 * H;
  const foreArm = 0.17 * H;
  const thigh = 0.26 * H;
  const shin = 0.25 * H;
  // A limb hanging from a joint, swung forward/back by `ang` (radians about the side axis).
  const leg = (side: number, ang: number, bend: number) => {
    const knee = p(hipY - thigh * Math.cos(ang), side, thigh * Math.sin(ang));
    const a2 = ang - bend;
    const ankle: [number, number, number] = [
      knee[0] + fx * shin * Math.sin(a2),
      knee[1] - shin * Math.cos(a2),
      knee[2] + fz * shin * Math.sin(a2),
    ];
    return [knee, ankle] as const;
  };
  const arm = (side: number, ang: number) => {
    const elbow = p(neckY - upperArm * Math.cos(ang), side, upperArm * Math.sin(ang));
    const wrist: [number, number, number] = [
      elbow[0] + fx * foreArm * Math.sin(ang * 1.3),
      elbow[1] - foreArm * Math.cos(ang * 1.3),
      elbow[2] + fz * foreArm * Math.sin(ang * 1.3),
    ];
    return [elbow, wrist] as const;
  };
  const [rKnee, rAnkle] = leg(hipHalf, legR, Math.max(0, legR) * 0.8);
  const [lKnee, lAnkle] = leg(-hipHalf, legL, Math.max(0, legL) * 0.8);
  const [rElbow, rWrist] = arm(shoulderHalf, armR);
  const [lElbow, lWrist] = arm(-shoulderHalf, armL);
  return [
    p(0.93 * H, 0, 0.06 * H), // nose
    p(neckY, 0, 0), // neck
    p(neckY, shoulderHalf, 0),
    rElbow,
    rWrist,
    p(neckY, -shoulderHalf, 0),
    lElbow,
    lWrist,
    p(hipY, hipHalf, 0),
    rKnee,
    rAnkle,
    p(hipY, -hipHalf, 0),
    lKnee,
    lAnkle,
    p(0.95 * H, 0.03 * H, 0.05 * H), // eyes
    p(0.95 * H, -0.03 * H, 0.05 * H),
    p(0.94 * H, 0.07 * H, 0), // ears
    p(0.94 * H, -0.07 * H, 0),
  ];
}

export interface ProjectedPoint {
  x: number;
  y: number;
  /** Metres in front of the camera (≤ 0: behind it, not drawn). */
  z: number;
}

/** `v` rotated by the unit quaternion `q` (three's `Vector3.applyQuaternion`). */
function rotate(v: [number, number, number], q: [number, number, number, number]): [number, number, number] {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
}

/** A world point in the picture of a camera frame (pixels, y down) — three's convention: the camera looks down −Z. */
export function projectPoint(p: [number, number, number], cam: CameraFrame): ProjectedPoint {
  const [qx, qy, qz, qw] = cam.quat;
  const v = rotate([p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]], [-qx, -qy, -qz, qw]);
  const z = -v[2];
  if (z <= 1e-6) return { x: NaN, y: NaN, z };
  return { x: cam.cx + (cam.fx * v[0]) / z, y: cam.cy - (cam.fy * v[1]) / z, z };
}
