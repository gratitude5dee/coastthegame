/**
 * Takes — record / replay of an actor (goal.md ACT-2, ACT-4; §7.7 STU-1; §7.16 SCH-4 v0).
 *
 * v0 records the actor's *root* pose (position + yaw + speed + grounded) and the camera at a fixed sample rate (30 Hz by
 * default), plus a world-edit log so a replay repaints the wall and re-throws the can. Bone quats and intents (the rest
 * of ACT-2) arrive with the skinned characters in M4; the on-disk header carries `v: 1` so the encoding can grow without
 * invalidating stored takes.
 *
 * Poses are authoritative: `TakePlayer` interpolates between stored samples and never re-simulates (AGENTS.md §6). Every
 * numeric sample field is stored at float32 precision (the on-disk precision, ACT-2 "f32 pos"), so what replays live is
 * bit-for-bit what replays from disk — `encodeTake`/`decodeTake` are lossless for recorder output.
 *
 * Pure TypeScript: no three.js, no DOM. The only global touched is `indexedDB`, guarded (`takeStore` falls back to memory).
 */

export type Vec3 = [number, number, number];
/** xyzw — three.js order. */
export type Quat = [number, number, number, number];

export interface TakeSample {
  /** Seconds from take start. */
  t: number;
  /** Actor root position (world space, metres). */
  pos: Vec3;
  /** Actor heading, radians. */
  yaw: number;
  /** Horizontal speed, m/s (drives the locomotion blend on replay). */
  speed: number;
  grounded: boolean;
  /** The actor was at the wheel of the lowrider (the pose is the car's; replay shows a car, not a body). */
  driving: boolean;
  camPos: Vec3;
  camQuat: Quat;
}

/** World-edit log entries (ACT-2): replayed kinematically so the replay repaints the wall and re-throws the can. */
export type WorldEdit =
  | { t: number; kind: 'propPlace'; propId: string; pos: Vec3 }
  | { t: number; kind: 'propThrow'; propId: string; velocity: Vec3 }
  | { t: number; kind: 'propGrab' | 'propRelease'; propId: string }
  | { t: number; kind: 'sdfPaint'; shape: 'sphere'; pos: Vec3; r: number; rgba: [number, number, number, number] };

/**
 * `Omit` is not distributive over unions (it would collapse `WorldEdit` to `{ kind }`), so the recorder's input type is
 * spelled with a distributive omit: each edit variant minus `t`, plus an optional `t` override.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type WorldEditInput = DistributiveOmit<WorldEdit, 't'> & { t?: number };

export interface TakeV1 {
  v: 1;
  id: string;
  actorId: string;
  /** `cell.json.version` the take was recorded against — replays are only valid against it (ACT-4). */
  cellVersion: string;
  /** Nominal sample rate. Sample times are stored explicitly, so the grid is not assumed on replay. */
  hz: number;
  /** ISO-8601 wall-clock time of `start()`. */
  startedAt: string;
  /** Seconds from `start()` to `stop()`. */
  durationS: number;
  /** Sorted by `t`, ascending. */
  samples: TakeSample[];
  /** Sorted by `t`, ascending. */
  worldEdits: WorldEdit[];
}

/** The interpolated pose `TakePlayer.poseAt` returns (the caller's `out` object when given). */
export interface TakePose {
  pos: Vec3;
  /** Radians, wrapped to [-π, π]. */
  yaw: number;
  speed: number;
  /** From the sample at or before the time (never interpolated). */
  driving: boolean;
  camPos: Vec3;
  camQuat: Quat;
}

// ── Small pure math (no three.js) ────────────────────────────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/** Wrap an angle to [-π, π] (±π are preserved as given). */
function wrapAngle(a: number): number {
  return a >= -Math.PI && a <= Math.PI ? a : Math.atan2(Math.sin(a), Math.cos(a));
}

/** Shortest-arc interpolation between two angles (handles the ±π wrap); the result is wrapped to [-π, π]. */
function lerpAngle(a: number, b: number, u: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return wrapAngle(a + d * u);
}

/** Spherical linear interpolation along the shortest path (double-cover aware); writes a unit quaternion into `out`. */
function slerp(a: Quat, b: Quat, u: number, out: Quat): Quat {
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    // q and -q are the same rotation: flip to take the short arc.
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0: number;
  let s1: number;
  if (dot > 0.9995) {
    // Nearly parallel: sin(θ) → 0, so fall back to a normalised lerp (indistinguishable at this angle).
    s0 = 1 - u;
    s1 = u;
  } else {
    const theta = Math.acos(Math.min(1, dot));
    const sinTheta = Math.sin(theta);
    s0 = Math.sin((1 - u) * theta) / sinTheta;
    s1 = Math.sin(u * theta) / sinTheta;
  }
  const x = s0 * a[0] + s1 * bx;
  const y = s0 * a[1] + s1 * by;
  const z = s0 * a[2] + s1 * bz;
  const w = s0 * a[3] + s1 * bw;
  const len = Math.hypot(x, y, z, w) || 1;
  out[0] = x / len;
  out[1] = y / len;
  out[2] = z / len;
  out[3] = w / len;
  return out;
}

// ── Recorder ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TakeRecorderOptions {
  actorId: string;
  cellVersion: string;
  /** Sample rate, default 30. Samples are rate-limited to this; the engine can feed it at any frame rate. */
  hz?: number;
  /** Take id factory, default `crypto.randomUUID()` (with a timestamp+random fallback). */
  idFactory?: () => string;
}

const f32 = Math.fround;

function defaultId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `take-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Copy a sample into `dst` at time `t`, quantised to float32 (see the module doc). */
function copySample(dst: TakeSample, t: number, s: Omit<TakeSample, 't'>): TakeSample {
  dst.t = f32(t);
  dst.pos[0] = f32(s.pos[0]);
  dst.pos[1] = f32(s.pos[1]);
  dst.pos[2] = f32(s.pos[2]);
  dst.yaw = f32(s.yaw);
  dst.speed = f32(s.speed);
  dst.grounded = !!s.grounded;
  dst.driving = !!s.driving;
  dst.camPos[0] = f32(s.camPos[0]);
  dst.camPos[1] = f32(s.camPos[1]);
  dst.camPos[2] = f32(s.camPos[2]);
  dst.camQuat[0] = f32(s.camQuat[0]);
  dst.camQuat[1] = f32(s.camQuat[1]);
  dst.camQuat[2] = f32(s.camQuat[2]);
  dst.camQuat[3] = f32(s.camQuat[3]);
  return dst;
}

function emptySample(): TakeSample {
  return { t: 0, pos: [0, 0, 0], yaw: 0, speed: 0, grounded: false, driving: false, camPos: [0, 0, 0], camQuat: [0, 0, 0, 1] };
}

function cloneEdit(t: number, e: WorldEditInput): WorldEdit {
  switch (e.kind) {
    case 'propPlace':
      return { t, kind: e.kind, propId: e.propId, pos: [e.pos[0], e.pos[1], e.pos[2]] };
    case 'propThrow':
      return { t, kind: e.kind, propId: e.propId, velocity: [e.velocity[0], e.velocity[1], e.velocity[2]] };
    case 'propGrab':
    case 'propRelease':
      return { t, kind: e.kind, propId: e.propId };
    case 'sdfPaint':
      return {
        t,
        kind: e.kind,
        shape: e.shape,
        pos: [e.pos[0], e.pos[1], e.pos[2]],
        r: e.r,
        rgba: [e.rgba[0], e.rgba[1], e.rgba[2], e.rgba[3]],
      };
  }
}

/**
 * Records a take from per-frame pose samples and world edits. Feed `sample()` every frame at any rate — it keeps one
 * sample per period (≥ 1/hz − 1 ms since the last stored one, so 60/72/90/120 Hz input all settle on the hz grid) and
 * always keeps the first. Inputs are copied, so callers may reuse their arrays.
 */
export class TakeRecorder {
  readonly hz: number;
  /** Who is performing; `start()` can set it per take (possession, ACT-3). */
  actorId: string;
  private readonly cellVersion: string;
  private readonly idFactory: () => string;
  private readonly periodMs: number;
  private isRecording = false;
  private id = '';
  private startMs = 0;
  private startedAt = '';
  private lastStoredMs = -Infinity;
  private samples: TakeSample[] = [];
  private worldEdits: WorldEdit[] = [];
  /** Freshest input the rate limiter dropped since the last stored sample (reused buffer — allocation-free at 120 Hz). */
  private readonly pending = emptySample();
  private hasPending = false;

  constructor(opts: TakeRecorderOptions) {
    const hz = opts.hz ?? 30;
    if (!(hz > 0) || !Number.isFinite(hz)) throw new Error(`TakeRecorder: hz must be a positive number (got ${hz})`);
    this.hz = hz;
    this.periodMs = 1000 / hz;
    this.actorId = opts.actorId;
    this.cellVersion = opts.cellVersion;
    this.idFactory = opts.idFactory ?? defaultId;
  }

  get recording(): boolean {
    return this.isRecording;
  }

  /** Begin a new take at `nowMs` (any monotonic clock, e.g. `performance.now()`); resets the buffers. */
  start(nowMs: number, actorId?: string): void {
    if (actorId !== undefined) this.actorId = actorId;
    this.isRecording = true;
    this.id = this.idFactory();
    this.startMs = nowMs;
    this.startedAt = new Date().toISOString();
    this.lastStoredMs = -Infinity;
    this.samples = [];
    this.worldEdits = [];
    this.hasPending = false;
  }

  /** Offer a pose sample; returns true when it was stored (rate-limited to `hz`). False when not recording. */
  sample(nowMs: number, s: Omit<TakeSample, 't'>): boolean {
    if (!this.isRecording) return false;
    const t = this.elapsedS(nowMs);
    if (nowMs - this.lastStoredMs >= this.periodMs - 1) {
      this.samples.push(copySample(emptySample(), t, s));
      this.lastStoredMs = nowMs;
      this.hasPending = false;
      return true;
    }
    copySample(this.pending, t, s);
    this.hasPending = true;
    return false;
  }

  /** Log a world edit at `nowMs` (or at the explicit `e.t`, seconds from take start). Ignored when not recording. */
  edit(nowMs: number, e: WorldEditInput): void {
    if (!this.isRecording) return;
    this.worldEdits.push(cloneEdit(e.t ?? this.elapsedS(nowMs), e));
  }

  /** Seconds since `start()` (0 when not recording). */
  elapsedS(nowMs: number): number {
    return this.isRecording ? Math.max(0, (nowMs - this.startMs) / 1000) : 0;
  }

  /**
   * Finalise the take. `durationS` is start→stop; if the last stored sample is older than half a period a final sample is
   * appended at `durationS` from the freshest pose seen (the last rate-limited input, else a hold of the last sample).
   */
  stop(nowMs: number): TakeV1 {
    if (!this.isRecording) throw new Error('TakeRecorder.stop(): not recording');
    const durationS = this.elapsedS(nowMs);
    const last = this.samples[this.samples.length - 1];
    if (last && durationS - last.t > this.periodMs / 2000) {
      this.samples.push(copySample(emptySample(), durationS, this.hasPending ? this.pending : last));
    }
    this.isRecording = false;
    this.hasPending = false;
    const worldEdits = this.worldEdits.slice().sort((a, b) => a.t - b.t);
    return {
      v: 1,
      id: this.id,
      actorId: this.actorId,
      cellVersion: this.cellVersion,
      hz: this.hz,
      startedAt: this.startedAt,
      durationS,
      samples: this.samples,
      worldEdits,
    };
  }
}

// ── Player ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function copyPose(s: TakeSample, o: TakePose): TakePose {
  o.pos[0] = s.pos[0];
  o.pos[1] = s.pos[1];
  o.pos[2] = s.pos[2];
  o.yaw = wrapAngle(s.yaw);
  o.speed = s.speed;
  o.driving = !!s.driving;
  o.camPos[0] = s.camPos[0];
  o.camPos[1] = s.camPos[1];
  o.camPos[2] = s.camPos[2];
  o.camQuat[0] = s.camQuat[0];
  o.camQuat[1] = s.camQuat[1];
  o.camQuat[2] = s.camQuat[2];
  o.camQuat[3] = s.camQuat[3];
  return o;
}

/**
 * Replays a take: interpolated poses at any time (render interpolation, STU-1) and the world edits that fall in a
 * time window. Never re-simulates. Sequential playback is O(1) per call (a cursor); seeks are O(log n).
 */
export class TakePlayer {
  readonly durationS: number;
  private readonly samples: readonly TakeSample[];
  private readonly edits: readonly WorldEdit[];
  private cursor = 0;

  constructor(take: TakeV1) {
    if (!take || take.v !== 1) throw new Error('TakePlayer: unsupported take (expected v1)');
    this.durationS = take.durationS;
    this.samples = take.samples;
    this.edits = take.worldEdits.slice().sort((a, b) => a.t - b.t);
  }

  /**
   * Interpolated pose at time `tS` (clamped to the sampled range; yaw lerped along the shortest arc; camQuat slerped).
   * Writes into `out` when given (allocation-free) and returns it; an empty take yields the origin / identity.
   */
  poseAt(tS: number, out?: TakePose): TakePose {
    const o = out ?? { pos: [0, 0, 0], yaw: 0, speed: 0, driving: false, camPos: [0, 0, 0], camQuat: [0, 0, 0, 1] };
    const s = this.samples;
    const n = s.length;
    if (n === 0) return copyPose(emptySample(), o);
    const first = s[0]!;
    const last = s[n - 1]!;
    if (!(tS > first.t)) return copyPose(first, o); // also catches NaN
    if (tS >= last.t) return copyPose(last, o);
    const i = this.segmentIndex(tS);
    const a = s[i]!;
    const b = s[i + 1]!;
    const span = b.t - a.t;
    const u = span > 0 ? (tS - a.t) / span : 0;
    o.pos[0] = lerp(a.pos[0], b.pos[0], u);
    o.pos[1] = lerp(a.pos[1], b.pos[1], u);
    o.pos[2] = lerp(a.pos[2], b.pos[2], u);
    o.yaw = lerpAngle(a.yaw, b.yaw, u);
    o.speed = lerp(a.speed, b.speed, u);
    o.driving = !!a.driving;
    o.camPos[0] = lerp(a.camPos[0], b.camPos[0], u);
    o.camPos[1] = lerp(a.camPos[1], b.camPos[1], u);
    o.camPos[2] = lerp(a.camPos[2], b.camPos[2], u);
    slerp(a.camQuat, b.camQuat, u, o.camQuat);
    return o;
  }

  /** World edits with `t` in (fromS, toS], in time order — call once per replay frame with the previous and current time. */
  editsBetween(fromS: number, toS: number): WorldEdit[] {
    const e = this.edits;
    // Lower bound: first edit with t > fromS.
    let lo = 0;
    let hi = e.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (e[mid]!.t <= fromS) lo = mid + 1;
      else hi = mid;
    }
    const out: WorldEdit[] = [];
    for (let i = lo; i < e.length && e[i]!.t <= toS; i++) out.push(e[i]!);
    return out;
  }

  /** Largest i with samples[i].t <= t, given first.t < t < last.t. */
  private segmentIndex(t: number): number {
    const s = this.samples;
    const lastSeg = s.length - 2;
    const c = this.cursor;
    if (c <= lastSeg && s[c]!.t <= t) {
      if (t < s[c + 1]!.t) return c;
      if (c + 1 <= lastSeg && t < s[c + 2]!.t) return (this.cursor = c + 1);
    }
    let lo = 0;
    let hi = lastSeg;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid]!.t <= t) lo = mid;
      else hi = mid - 1;
    }
    return (this.cursor = lo);
  }
}

// ── Encoding (SCH-4 v0) ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * take.bin v1: `"TAKE"` · u32 header length · JSON header · packed body. The header is the take minus its samples plus
 * `n` and a human-readable `body` layout string (the SCH-4 style); the body is column-major little-endian float32 columns
 * (t, pos xyz, yaw, speed, camPos xyz, camQuat xyzw) followed by a uint8 flags column (bit 0 grounded, bit 1 driving —
 * files written before the driving bit existed decode unchanged) — 53 bytes per sample, so a 60 s take at 30 Hz is
 * ≈ 95 KB. Column-major keeps it friendly to gzip / R2 content-encoding.
 */
const MAGIC = [0x54, 0x41, 0x4b, 0x45] as const; // "TAKE"
const HEADER_PREFIX_BYTES = 8; // magic + u32 header length
export const TAKE_BYTES_PER_SAMPLE = 4 + 12 + 4 + 4 + 12 + 16 + 1;
const BODY_LAYOUT =
  'f32 t[n] | f32x3 pos[n] | f32 yaw[n] | f32 speed[n] | f32x3 camPos[n] | f32x4 camQuat[n] | u8 flags[n] (bit0 grounded, bit1 driving); little-endian, column-major';

interface TakeHeader extends Omit<TakeV1, 'samples'> {
  n: number;
  body: string;
}

export function encodeTake(take: TakeV1): Uint8Array {
  const samples = take.samples;
  const n = samples.length;
  const header: TakeHeader = {
    v: 1,
    id: take.id,
    actorId: take.actorId,
    cellVersion: take.cellVersion,
    hz: take.hz,
    startedAt: take.startedAt,
    durationS: take.durationS,
    n,
    body: BODY_LAYOUT,
    worldEdits: take.worldEdits,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const bytes = new Uint8Array(HEADER_PREFIX_BYTES + headerBytes.length + n * TAKE_BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint32(4, headerBytes.length, true);
  bytes.set(headerBytes, HEADER_PREFIX_BYTES);
  let o = HEADER_PREFIX_BYTES + headerBytes.length;
  const put = (v: number): void => {
    view.setFloat32(o, v, true);
    o += 4;
  };
  for (const s of samples) put(s.t);
  for (const s of samples) {
    put(s.pos[0]);
    put(s.pos[1]);
    put(s.pos[2]);
  }
  for (const s of samples) put(s.yaw);
  for (const s of samples) put(s.speed);
  for (const s of samples) {
    put(s.camPos[0]);
    put(s.camPos[1]);
    put(s.camPos[2]);
  }
  for (const s of samples) {
    put(s.camQuat[0]);
    put(s.camQuat[1]);
    put(s.camQuat[2]);
    put(s.camQuat[3]);
  }
  for (const s of samples) bytes[o++] = (s.grounded ? 1 : 0) | (s.driving ? 2 : 0);
  return bytes;
}

export function decodeTake(bytes: Uint8Array): TakeV1 {
  if (bytes.length < HEADER_PREFIX_BYTES || MAGIC.some((m, i) => bytes[i] !== m)) {
    throw new Error('decodeTake: not a take (bad magic)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(4, true);
  if (HEADER_PREFIX_BYTES + headerLen > bytes.length) throw new Error('decodeTake: truncated header');
  let header: Partial<TakeHeader>;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_PREFIX_BYTES, HEADER_PREFIX_BYTES + headerLen)));
  } catch (e) {
    throw new Error('decodeTake: bad header', { cause: e });
  }
  if (header.v !== 1) throw new Error(`decodeTake: unsupported take version ${String(header.v)}`);
  const n = header.n;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new Error('decodeTake: bad sample count');
  if (bytes.length !== HEADER_PREFIX_BYTES + headerLen + n * TAKE_BYTES_PER_SAMPLE) throw new Error('decodeTake: body length mismatch');
  let o = HEADER_PREFIX_BYTES + headerLen;
  const get = (): number => {
    const v = view.getFloat32(o, true);
    o += 4;
    return v;
  };
  const samples: TakeSample[] = [];
  for (let i = 0; i < n; i++) {
    const s = emptySample();
    s.t = get();
    samples.push(s);
  }
  for (const s of samples) {
    s.pos[0] = get();
    s.pos[1] = get();
    s.pos[2] = get();
  }
  for (const s of samples) s.yaw = get();
  for (const s of samples) s.speed = get();
  for (const s of samples) {
    s.camPos[0] = get();
    s.camPos[1] = get();
    s.camPos[2] = get();
  }
  for (const s of samples) {
    s.camQuat[0] = get();
    s.camQuat[1] = get();
    s.camQuat[2] = get();
    s.camQuat[3] = get();
  }
  for (const s of samples) {
    const flags = bytes[o++]!;
    s.grounded = (flags & 1) === 1;
    s.driving = (flags & 2) === 2;
  }
  return {
    v: 1,
    id: String(header.id ?? ''),
    actorId: String(header.actorId ?? ''),
    cellVersion: String(header.cellVersion ?? ''),
    hz: typeof header.hz === 'number' ? header.hz : 30,
    startedAt: String(header.startedAt ?? ''),
    durationS: typeof header.durationS === 'number' ? header.durationS : (samples[n - 1]?.t ?? 0),
    samples,
    worldEdits: Array.isArray(header.worldEdits) ? header.worldEdits : [],
  };
}

// ── Persistence (ACT-4: session store; R2 upload when signed in lands with the Worker) ───────────────────────────────

export interface TakeSummary {
  id: string;
  actorId: string;
  cellVersion: string;
  durationS: number;
  startedAt: string;
}

export interface TakeStore {
  save(take: TakeV1): Promise<void>;
  /** All saved takes, oldest first (by `startedAt`, then id). */
  list(): Promise<TakeSummary[]>;
  /** A fresh decode of the stored bytes (never the object passed to `save`), or null when unknown. */
  load(id: string): Promise<TakeV1 | null>;
  /** Resolves even when the id is unknown. */
  remove(id: string): Promise<void>;
}

export interface TakeStoreOptions {
  /** IndexedDB factory; default: the global `indexedDB` when present. `null` forces the in-memory backend. */
  indexedDB?: IDBFactory | null;
  /** Default 'coast'. */
  dbName?: string;
  /** Default 'takes'. */
  storeName?: string;
  /** Opening IndexedDB can hang on a corrupted profile; after this the store falls back to memory. Default 5000. */
  openTimeoutMs?: number;
}

/** What is persisted per take: the summary (so `list()` never decodes bodies) plus the SCH-4 bytes. */
interface TakeRecord extends TakeSummary {
  bytes: Uint8Array;
}

function openDb(factory: IDBFactory, name: string, storeName: string, timeoutMs: number): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(name, 1);
    } catch (e) {
      reject(e);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`IndexedDB open('${name}') timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      // Late success after the timeout: the store already fell back to memory — do not leak the connection.
      if (settled) req.result.close();
      else resolve(req.result);
      settled = true;
    };
    req.onerror = () => {
      clearTimeout(timer);
      settled = true;
      reject(req.error ?? new Error(`IndexedDB open('${name}') failed`));
    };
  });
}

/** One request in one transaction; writes resolve on commit, reads on request success. */
function run<T>(db: IDBDatabase, storeName: string, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeName, mode);
    } catch (e) {
      reject(e);
      return;
    }
    const req = op(tx.objectStore(storeName));
    const fail = () => reject(tx.error ?? req.error ?? new Error(`IndexedDB ${mode} on '${storeName}' failed`));
    if (mode === 'readonly') req.onsuccess = () => resolve(req.result);
    else tx.oncomplete = () => resolve(req.result);
    req.onerror = fail;
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

function summaryOf(r: TakeSummary): TakeSummary {
  return { id: r.id, actorId: r.actorId, cellVersion: r.cellVersion, durationS: r.durationS, startedAt: r.startedAt };
}

function sortSummaries(list: TakeSummary[]): TakeSummary[] {
  return list.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Create a take store. The backend is chosen on first use: IndexedDB when it opens, else memory (tests, browsers without
 * it, a profile whose open fails or hangs). Operation errors after that (e.g. quota) are surfaced to the caller.
 */
export function createTakeStore(opts: TakeStoreOptions = {}): TakeStore {
  const dbName = opts.dbName ?? 'coast';
  const storeName = opts.storeName ?? 'takes';
  const openTimeoutMs = opts.openTimeoutMs ?? 5000;
  const memory = new Map<string, TakeRecord>();
  let dbPromise: Promise<IDBDatabase | null> | undefined;

  function backend(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    const factory = opts.indexedDB === undefined ? (typeof indexedDB !== 'undefined' ? indexedDB : null) : opts.indexedDB;
    if (!factory) return (dbPromise = Promise.resolve(null));
    dbPromise = openDb(factory, dbName, storeName, openTimeoutMs).then(
      (db) => {
        db.onversionchange = () => {
          // Another tab upgraded the schema: release the connection; the next call reopens.
          db.close();
          dbPromise = undefined;
        };
        return db;
      },
      (e: unknown) => {
        console.warn('[takes] IndexedDB unavailable — takes will not persist beyond this session', e);
        return null;
      },
    );
    return dbPromise;
  }

  return {
    async save(take) {
      if (!take.id) throw new Error('takeStore.save(): take.id is required');
      const rec: TakeRecord = { ...summaryOf(take), bytes: encodeTake(take) };
      const db = await backend();
      if (!db) {
        memory.set(rec.id, rec);
        return;
      }
      await run(db, storeName, 'readwrite', (s) => s.put(rec));
    },
    async list() {
      const db = await backend();
      const records = db ? ((await run(db, storeName, 'readonly', (s) => s.getAll())) as TakeRecord[]) : [...memory.values()];
      return sortSummaries(records.map(summaryOf));
    },
    async load(id) {
      const db = await backend();
      const rec = db ? ((await run(db, storeName, 'readonly', (s) => s.get(id))) as TakeRecord | undefined) : memory.get(id);
      return rec ? decodeTake(rec.bytes) : null;
    },
    async remove(id) {
      const db = await backend();
      if (!db) {
        memory.delete(id);
        return;
      }
      await run(db, storeName, 'readwrite', (s) => s.delete(id));
    },
  };
}

/** The session take store (ACT-4): IndexedDB db 'coast', store 'takes'; in-memory when IndexedDB is unavailable. */
export const takeStore: TakeStore = createTakeStore();
