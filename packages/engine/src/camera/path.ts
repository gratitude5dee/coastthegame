/**
 * Keyframed camera paths (goal.md CAM-7, CAM-2 "locked shot"): keys at set times, position through a centripetal
 * Catmull-Rom spline, orientation by slerp, field of view by lerp, with an easing per segment — our own
 * implementation (AF-7: no Theatre.js), parameterised by *time* rather than arc length so a key at 4.0 s is on
 * screen at 4.0 s. Scrubbable: `sample(t)` is pure, so a timeline, the export and the live rig all read the same
 * curve. Keys serialise as `CameraKey[]` inside a Shot (`packages/studio`).
 */
import * as THREE from 'three';

export interface CameraKey {
  /** Seconds from the start of the path. */
  t: number;
  pos: [number, number, number];
  quat: [number, number, number, number];
  fovDeg: number;
}

export type PathEasing = 'linear' | 'smooth';

export interface CameraSample {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  fovDeg: number;
}

const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const Q0 = new THREE.Quaternion();
const Q1 = new THREE.Quaternion();

/** Centripetal Catmull-Rom (Barry–Goldman): p0..p3 with knot spacing from the points' distances, u in [0, 1] between p1 and p2. */
function catmullRom(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  p3: THREE.Vector3,
  u: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const alpha = 0.5;
  const knot = (a: THREE.Vector3, b: THREE.Vector3, prev: number) => prev + Math.max(1e-4, Math.pow(a.distanceTo(b), alpha));
  const t0 = 0;
  const t1 = knot(p0, p1, t0);
  const t2 = knot(p1, p2, t1);
  const t3 = knot(p2, p3, t2);
  const t = t1 + (t2 - t1) * u;
  const lerp = (a: THREE.Vector3, b: THREE.Vector3, ta: number, tb: number, o: THREE.Vector3) => {
    const w = tb - ta === 0 ? 0 : (t - ta) / (tb - ta);
    return o.copy(a).lerp(b, w);
  };
  const a1 = lerp(p0, p1, t0, t1, tmpA1);
  const a2 = lerp(p1, p2, t1, t2, tmpA2);
  const a3 = lerp(p2, p3, t2, t3, tmpA3);
  const b1 = lerp(a1, a2, t0, t2, tmpB1);
  const b2 = lerp(a2, a3, t1, t3, tmpB2);
  return lerp(b1, b2, t1, t2, out);
}
const tmpA1 = new THREE.Vector3();
const tmpA2 = new THREE.Vector3();
const tmpA3 = new THREE.Vector3();
const tmpB1 = new THREE.Vector3();
const tmpB2 = new THREE.Vector3();

function ease(u: number, easing: PathEasing): number {
  return easing === 'smooth' ? u * u * (3 - 2 * u) : u;
}

export class CameraPath {
  readonly keys: CameraKey[] = [];
  easing: PathEasing;

  constructor(keys: CameraKey[] = [], easing: PathEasing = 'smooth') {
    this.easing = easing;
    for (const k of keys) this.add(k);
  }

  get size() {
    return this.keys.length;
  }

  /** Seconds from the first key to the last (0 with fewer than two keys). */
  get durationS() {
    return this.keys.length < 2 ? 0 : this.keys[this.keys.length - 1]!.t - this.keys[0]!.t;
  }

  get startS() {
    return this.keys[0]?.t ?? 0;
  }

  /** Insert a key (kept sorted by time; a key at an existing time replaces it). */
  add(key: CameraKey): this {
    const k: CameraKey = { t: key.t, pos: [...key.pos], quat: [...key.quat], fovDeg: key.fovDeg };
    const i = this.keys.findIndex((x) => x.t >= k.t);
    if (i < 0) this.keys.push(k);
    else if (this.keys[i]!.t === k.t) this.keys[i] = k;
    else this.keys.splice(i, 0, k);
    return this;
  }

  /** A key from a camera's current world pose, at `t` seconds. */
  addFromCamera(camera: THREE.PerspectiveCamera, t: number): this {
    const p = camera.getWorldPosition(tmpPos);
    const q = camera.getWorldQuaternion(tmpQuat);
    return this.add({ t, pos: [p.x, p.y, p.z], quat: [q.x, q.y, q.z, q.w], fovDeg: camera.fov });
  }

  removeLast(): CameraKey | undefined {
    return this.keys.pop();
  }

  clear() {
    this.keys.length = 0;
  }

  /** Re-time the keys so the path lasts `seconds` (keeps their relative spacing). */
  retime(seconds: number) {
    const d = this.durationS;
    if (d <= 0 || seconds <= 0) return;
    const s = this.startS;
    for (const k of this.keys) k.t = s + ((k.t - s) / d) * seconds;
  }

  /** The camera pose at path time `t` (clamped to the ends; a single key is a still). */
  sample(t: number, out: CameraSample = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fovDeg: 50 }): CameraSample {
    const keys = this.keys;
    const n = keys.length;
    if (n === 0) return out;
    if (n === 1 || t <= keys[0]!.t) return keyTo(keys[0]!, out);
    if (t >= keys[n - 1]!.t) return keyTo(keys[n - 1]!, out);
    let i = 0;
    while (i < n - 2 && keys[i + 1]!.t <= t) i++;
    const k1 = keys[i]!;
    const k2 = keys[i + 1]!;
    const u = ease((t - k1.t) / Math.max(1e-6, k2.t - k1.t), this.easing);
    const k0 = keys[Math.max(0, i - 1)]!;
    const k3 = keys[Math.min(n - 1, i + 2)]!;
    P[0]!.set(...k0.pos);
    P[1]!.set(...k1.pos);
    P[2]!.set(...k2.pos);
    P[3]!.set(...k3.pos);
    if (n === 2) out.pos.copy(P[1]!).lerp(P[2]!, u);
    else catmullRom(P[0]!, P[1]!, P[2]!, P[3]!, u, out.pos);
    Q0.set(...k1.quat);
    Q1.set(...k2.quat);
    out.quat.copy(Q0).slerp(Q1, u);
    out.fovDeg = k1.fovDeg + (k2.fovDeg - k1.fovDeg) * u;
    return out;
  }

  /** Put a camera on the path at `t`. */
  apply(camera: THREE.PerspectiveCamera, t: number) {
    const s = this.sample(t, tmpSample);
    camera.position.copy(s.pos);
    camera.quaternion.copy(s.quat);
    if (camera.fov !== s.fovDeg) {
      camera.fov = s.fovDeg;
      camera.updateProjectionMatrix();
    }
  }

  toJSON(): CameraKey[] {
    return this.keys.map((k) => ({
      t: k.t,
      pos: [...k.pos] as CameraKey['pos'],
      quat: [...k.quat] as CameraKey['quat'],
      fovDeg: k.fovDeg,
    }));
  }
}

function keyTo(k: CameraKey, out: CameraSample): CameraSample {
  out.pos.set(...k.pos);
  out.quat.set(...k.quat);
  out.fovDeg = k.fovDeg;
  return out;
}

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpSample: CameraSample = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fovDeg: 50 };
