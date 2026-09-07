import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TakeRecorder,
  TakePlayer,
  encodeTake,
  decodeTake,
  createTakeStore,
  takeStore,
  TAKE_BYTES_PER_SAMPLE,
  type TakeSample,
  type TakeV1,
  type Quat,
  type WorldEdit,
} from '../../packages/studio/src/takes';

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const T0 = 1000; // arbitrary clock origin (ms) — nothing should depend on it

function input(i = 0, over: Partial<Omit<TakeSample, 't'>> = {}): Omit<TakeSample, 't'> {
  return { pos: [i, 0, -i], yaw: 0, speed: 1, grounded: true, driving: false, camPos: [0, 1.6, 2], camQuat: [0, 0, 0, 1], ...over };
}

function rotY(deg: number): Quat {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

/** Angle in degrees between two unit quaternions (double-cover aware). acos near 1 carries ~1e-6° of float noise. */
function quatAngleDeg(a: Quat, b: Quat): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
}
const ANGLE_EPS_DEG = 1e-4;

/** Record `seconds` of pose input at `inputHz` (optionally jittered), return the take and the stored-sample bookkeeping. */
function record(inputHz: number, seconds: number, opts: { hz?: number; jitterMs?: number } = {}) {
  const rec = new TakeRecorder({ actorId: 'player', cellVersion: '2026-09-20.1', hz: opts.hz, idFactory: () => 'take-1' });
  rec.start(T0);
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1; // deterministic in [-1, 1)
  const frames = Math.round(inputHz * seconds);
  const stored: boolean[] = [];
  let lastMs = T0;
  for (let k = 0; k <= frames; k++) {
    const jitter = opts.jitterMs ? rand() * opts.jitterMs : 0;
    const nowMs = k === 0 ? T0 : T0 + (k * 1000) / inputHz + jitter;
    stored.push(rec.sample(nowMs, input(k)));
    lastMs = nowMs;
  }
  return { rec, take: rec.stop(lastMs), stored, frames };
}

function take(samples: TakeSample[], worldEdits: WorldEdit[] = [], durationS = samples[samples.length - 1]?.t ?? 0): TakeV1 {
  return {
    v: 1,
    id: 'hand',
    actorId: 'player',
    cellVersion: 'v',
    hz: 30,
    startedAt: '2026-09-06T00:00:00.000Z',
    durationS,
    samples,
    worldEdits,
  };
}

function sampleAt(t: number, over: Partial<TakeSample> = {}): TakeSample {
  return { t, pos: [0, 0, 0], yaw: 0, speed: 0, grounded: true, driving: false, camPos: [0, 0, 0], camQuat: [0, 0, 0, 1], ...over };
}

// ── TakeRecorder ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('TakeRecorder', () => {
  it('snapshots avatar identity and outfit at start and roundtrips only public metadata', () => {
    const avatar = { id: 'coast', name: '$COAST', color: 0x123456, url: 'private-model', image: 'private-selfie' };
    const rec = new TakeRecorder({ actorId: 'player', cellVersion: 'v', avatar });
    avatar.name = 'Coast';
    rec.start(0);
    rec.sample(0, input());
    avatar.id = 'replacement';
    avatar.color = 0xffffff;
    rec.avatar = { id: 'new', name: 'New' };
    const recorded = rec.stop(1000);
    expect(recorded.avatar).toEqual({ id: 'coast', name: 'Coast', color: 0x123456 });
    const bytes = encodeTake(recorded);
    expect(new TextDecoder().decode(bytes)).not.toContain('private-');
    expect(decodeTake(bytes).avatar).toEqual(recorded.avatar);
    expect(decodeTake(encodeTake({ ...recorded, avatar })).avatar).toEqual({ id: 'replacement', name: 'Coast', color: 0xffffff });
    rec.start(2000);
    expect(rec.stop(3000).avatar).toEqual({ id: 'new', name: 'New' });
    rec.avatar = undefined;
    rec.start(4000);
    expect(decodeTake(encodeTake(rec.stop(5000)))).not.toHaveProperty('avatar');
    expect(recorded.avatar).toEqual({ id: 'coast', name: 'Coast', color: 0x123456 });
  });

  it('replays grounded as a discrete flag, including backwards seeks and held endpoints', () => {
    const p = new TakePlayer(take([sampleAt(0), sampleAt(1, { grounded: false }), sampleAt(2)]));
    expect(p.poseAt(0.5).grounded).toBe(true);
    expect(p.poseAt(1).grounded).toBe(false);
    expect(p.poseAt(1.5).grounded).toBe(false);
    expect(p.poseAt(5).grounded).toBe(true);
    expect(p.poseAt(1.2).grounded).toBe(false);
    expect(p.poseAt(-1).grounded).toBe(true);
  });

  it('stores the first sample and rate-limits 120 Hz input to 30 Hz', () => {
    const { take, stored, frames } = record(120, 60);
    expect(stored[0]).toBe(true);
    // Every 4th frame lands on the 30 Hz grid: 60 s → 1800 periods + the sample at t=0.
    expect(take.samples).toHaveLength(1801);
    expect(stored.filter(Boolean)).toHaveLength(1801);
    expect(stored.slice(0, 8)).toEqual([true, false, false, false, true, false, false, false]);
    expect(frames).toBe(7200);
    for (let i = 1; i < take.samples.length; i++) {
      const dt = take.samples[i]!.t - take.samples[i - 1]!.t;
      expect(dt).toBeGreaterThanOrEqual(1 / 30 - 0.001 - 1e-6);
      expect(dt).toBeLessThan(1 / 30 + 0.001);
    }
    expect(take.samples[0]!.t).toBe(0);
    expect(take.durationS).toBeCloseTo(60, 6);
    expect(take.samples[take.samples.length - 1]!.t).toBeCloseTo(60, 4);
  });

  it('keeps the 30 Hz grid under ±0.4 ms frame jitter and for 60 / 72 / 90 Hz input', () => {
    expect(record(120, 60, { jitterMs: 0.4 }).take.samples).toHaveLength(1801);
    expect(record(60, 60).take.samples).toHaveLength(1801); // every 2nd frame
    expect(record(90, 60).take.samples).toHaveLength(1801); // every 3rd frame
    // 72 Hz cannot hit 33.3 ms exactly: 2 frames = 27.8 ms (too soon), 3 frames = 41.7 ms → 24 Hz, plus the final sample.
    const n72 = record(72, 60).take.samples.length;
    expect(n72).toBeGreaterThanOrEqual(1440);
    expect(n72).toBeLessThanOrEqual(1442);
  });

  it('ignores samples and edits when not recording and reports the recording flag', () => {
    const rec = new TakeRecorder({ actorId: 'a', cellVersion: 'v' });
    expect(rec.recording).toBe(false);
    expect(rec.sample(T0, input())).toBe(false);
    rec.edit(T0, { kind: 'propGrab', propId: 'can' });
    expect(rec.elapsedS(T0 + 500)).toBe(0);
    expect(() => rec.stop(T0)).toThrow(/not recording/);
    rec.start(T0);
    expect(rec.recording).toBe(true);
    expect(rec.elapsedS(T0 + 500)).toBeCloseTo(0.5, 9);
    const t = rec.stop(T0 + 500);
    expect(rec.recording).toBe(false);
    expect(t.samples).toHaveLength(0);
    expect(t.worldEdits).toHaveLength(0);
    expect(t.durationS).toBeCloseTo(0.5, 9);
  });

  it('stop() appends a final sample at durationS from the freshest pose when the last stored one is older than half a period', () => {
    // Pending (rate-limited) input exists: it becomes the final sample, re-stamped at the stop time.
    let rec = new TakeRecorder({ actorId: 'a', cellVersion: 'v' });
    rec.start(T0);
    expect(rec.sample(T0, input(0))).toBe(true);
    expect(rec.sample(T0 + 10, input(1))).toBe(false);
    let t = rec.stop(T0 + 20);
    expect(t.durationS).toBeCloseTo(0.02, 9);
    expect(t.samples).toHaveLength(2);
    expect(t.samples[1]!.t).toBeCloseTo(0.02, 6);
    expect(t.samples[1]!.pos).toEqual([1, 0, -1]);

    // No pending input: the last stored pose is held to the stop time.
    rec = new TakeRecorder({ actorId: 'a', cellVersion: 'v' });
    rec.start(T0);
    rec.sample(T0, input(7));
    t = rec.stop(T0 + 20);
    expect(t.samples).toHaveLength(2);
    expect(t.samples[1]!.t).toBeCloseTo(0.02, 6);
    expect(t.samples[1]!.pos).toEqual([7, 0, -7]);

    // Last stored sample is recent (< half a period): nothing appended.
    rec = new TakeRecorder({ actorId: 'a', cellVersion: 'v' });
    rec.start(T0);
    rec.sample(T0, input(0));
    rec.sample(T0 + 5, input(1));
    t = rec.stop(T0 + 10);
    expect(t.samples).toHaveLength(1);
    expect(t.durationS).toBeCloseTo(0.01, 9);
  });

  it('copies inputs (callers may reuse their arrays) at float32 precision', () => {
    const rec = new TakeRecorder({ actorId: 'a', cellVersion: 'v' });
    rec.start(T0);
    const s = input(0, { pos: [0.1, 0.2, 0.3], yaw: 0.7, speed: 2.5, camPos: [1.1, 1.2, 1.3], camQuat: [0.1, 0.2, 0.3, 0.9] });
    rec.sample(T0, s);
    s.pos[0] = 99;
    s.camQuat[3] = -1;
    const t = rec.stop(T0);
    const st = t.samples[0]!;
    expect(st.pos).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]);
    expect(st.yaw).toBe(Math.fround(0.7));
    expect(st.speed).toBe(2.5);
    expect(st.grounded).toBe(true);
    expect(st.camPos).toEqual([Math.fround(1.1), Math.fround(1.2), Math.fround(1.3)]);
    expect(st.camQuat).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3), Math.fround(0.9)]);
    expect(Math.abs(st.pos[0] - 0.1)).toBeLessThan(1e-7);
  });

  it('timestamps edits at the elapsed time unless t is given, copies them, and stop() sorts them by t', () => {
    const rec = new TakeRecorder({ actorId: 'a', cellVersion: 'v' });
    rec.start(T0);
    const pos: [number, number, number] = [1, 1.4, -2];
    rec.edit(T0 + 1500, { kind: 'sdfPaint', shape: 'sphere', pos, r: 0.12, rgba: [255, 40, 120, 255] });
    rec.edit(T0 + 2500, { kind: 'propThrow', propId: 'can', velocity: [1, 2, 3] });
    rec.edit(T0 + 2600, { t: 0.5, kind: 'propGrab', propId: 'can' });
    rec.edit(T0 + 2700, { kind: 'propPlace', propId: 'cone', pos: [4, 0, -9] });
    pos[0] = 42;
    const t = rec.stop(T0 + 3000);
    expect(t.worldEdits.map((e) => [e.t, e.kind])).toEqual([
      [0.5, 'propGrab'],
      [1.5, 'sdfPaint'],
      [2.5, 'propThrow'],
      [2.7, 'propPlace'],
    ]);
    expect(t.worldEdits[1]).toEqual({ t: 1.5, kind: 'sdfPaint', shape: 'sphere', pos: [1, 1.4, -2], r: 0.12, rgba: [255, 40, 120, 255] });
    expect(t.worldEdits[2]).toEqual({ t: 2.5, kind: 'propThrow', propId: 'can', velocity: [1, 2, 3] });
  });

  it('start() resets the buffers and mints a fresh id; header fields pass through', () => {
    let n = 0;
    const rec = new TakeRecorder({ actorId: 'npc-3', cellVersion: '2026-09-20.1', hz: 24, idFactory: () => `t${++n}` });
    rec.start(T0);
    rec.sample(T0, input());
    rec.sample(T0 + 20, input()); // < 1000/24 − 1 = 40.7 ms → dropped
    expect(rec.sample(T0 + 41, input())).toBe(true);
    rec.edit(T0 + 50, { kind: 'propGrab', propId: 'can' });
    const a = rec.stop(T0 + 70);
    expect(a).toMatchObject({ v: 1, id: 't1', actorId: 'npc-3', cellVersion: '2026-09-20.1', hz: 24 });
    expect(a.samples).toHaveLength(3); // t=0, t=0.041, final hold at 0.07 (29 ms > half a 41.7 ms period after 0.041)
    expect(a.worldEdits).toHaveLength(1);
    expect(Number.isNaN(Date.parse(a.startedAt))).toBe(false);
    rec.start(T0 + 5000);
    const b = rec.stop(T0 + 5000);
    expect(b.id).toBe('t2');
    expect(b.samples).toHaveLength(0);
    expect(b.worldEdits).toHaveLength(0);
    expect(a.samples).toHaveLength(3); // the first take keeps its own arrays
    expect(new TakeRecorder({ actorId: 'a', cellVersion: 'v' }).hz).toBe(30);
    expect(() => new TakeRecorder({ actorId: 'a', cellVersion: 'v', hz: 0 })).toThrow(/hz/);
  });
});

// ── TakePlayer ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('TakePlayer', () => {
  const two = take([
    sampleAt(0, { pos: [0, 0, 0], speed: 0, camPos: [0, 2, 4] }),
    sampleAt(1, { pos: [4, 2, -8], speed: 2, camPos: [4, 4, 0], camQuat: rotY(90) }),
  ]);

  it('lerps pos / camPos / speed, is exact at sample times and clamps outside the sampled range', () => {
    const p = new TakePlayer(two);
    expect(p.durationS).toBe(1);
    expect(p.poseAt(0.25)).toMatchObject({ pos: [1, 0.5, -2], speed: 0.5, camPos: [1, 2.5, 3] });
    expect(p.poseAt(0)).toMatchObject({ pos: [0, 0, 0], speed: 0, camQuat: [0, 0, 0, 1] });
    expect(p.poseAt(1)).toMatchObject({ pos: [4, 2, -8], speed: 2, camPos: [4, 4, 0] });
    expect(p.poseAt(-5)).toMatchObject({ pos: [0, 0, 0] });
    expect(p.poseAt(99)).toMatchObject({ pos: [4, 2, -8], speed: 2 });
    expect(p.poseAt(Number.NaN)).toMatchObject({ pos: [0, 0, 0] });
  });

  it('writes into `out` and returns it (allocation-free)', () => {
    const p = new TakePlayer(two);
    const out = {
      pos: [9, 9, 9] as [number, number, number],
      yaw: 9,
      speed: 9,
      camPos: [9, 9, 9] as [number, number, number],
      camQuat: [1, 0, 0, 0] as Quat,
    };
    const { pos, camPos, camQuat } = out;
    expect(p.poseAt(0.5, out)).toBe(out);
    expect(out.pos).toBe(pos);
    expect(out.camPos).toBe(camPos);
    expect(out.camQuat).toBe(camQuat);
    expect(out.pos).toEqual([2, 1, -4]);
    expect(out.speed).toBe(1);
    expect(p.poseAt(7, out)).toBe(out);
    expect(out.pos).toEqual([4, 2, -8]);
  });

  it('interpolates yaw along the shortest arc across the ±π wrap', () => {
    const p = new TakePlayer(take([sampleAt(0, { yaw: 3.0 }), sampleAt(1, { yaw: -3.0 })]));
    // 3.0 → −3.0 is a 0.283 rad turn through π, not a 6 rad turn through 0.
    expect(Math.abs(p.poseAt(0.5).yaw)).toBeCloseTo(Math.PI, 9);
    expect(p.poseAt(0.25).yaw).toBeCloseTo(3.0 + (2 * Math.PI - 6) / 4, 9);
    expect(p.poseAt(0.75).yaw).toBeCloseTo(-3.0 - (2 * Math.PI - 6) / 4, 9);
    expect(p.poseAt(0).yaw).toBe(3.0);
    expect(p.poseAt(1).yaw).toBe(-3.0);
    // The other direction, and the trivial case that does not wrap.
    const q = new TakePlayer(take([sampleAt(0, { yaw: -3.0 }), sampleAt(1, { yaw: 3.0 })]));
    expect(Math.abs(q.poseAt(0.5).yaw)).toBeCloseTo(Math.PI, 9);
    expect(q.poseAt(0.25).yaw).toBeCloseTo(-3.0 - (2 * Math.PI - 6) / 4, 9);
    const r = new TakePlayer(take([sampleAt(0, { yaw: -0.1 }), sampleAt(1, { yaw: 0.1 })]));
    expect(r.poseAt(0.5).yaw).toBeCloseTo(0, 12);
    // Continuity along the whole segment: no 2π jumps between neighbouring times.
    let prev = p.poseAt(0).yaw;
    for (let u = 0.01; u <= 1; u += 0.01) {
      const y = p.poseAt(u).yaw;
      let d = Math.abs(y - prev) % (2 * Math.PI);
      d = Math.min(d, 2 * Math.PI - d);
      expect(d).toBeLessThan(0.01);
      prev = y;
    }
    // Unwrapped sample values come back wrapped to [−π, π].
    expect(new TakePlayer(take([sampleAt(0, { yaw: 4.0 })])).poseAt(0).yaw).toBeCloseTo(4.0 - 2 * Math.PI, 12);
  });

  it('slerps camQuat continuously along the short path (double cover) and stays unit length', () => {
    const p = new TakePlayer(two);
    expect(quatAngleDeg(p.poseAt(0.5).camQuat, rotY(45))).toBeLessThan(ANGLE_EPS_DEG);
    expect(quatAngleDeg(p.poseAt(0.25).camQuat, rotY(22.5))).toBeLessThan(ANGLE_EPS_DEG);
    // −q is the same rotation: the negated end quaternion must give the same 45° midpoint, not the 135° long way.
    const neg = rotY(90).map((v) => -v) as Quat;
    const pn = new TakePlayer(take([sampleAt(0), sampleAt(1, { camQuat: neg })]));
    expect(quatAngleDeg(pn.poseAt(0.5).camQuat, rotY(45))).toBeLessThan(ANGLE_EPS_DEG);
    let prev = p.poseAt(0).camQuat.slice() as Quat;
    for (let u = 0.01; u <= 1.0001; u += 0.01) {
      const q = p.poseAt(Math.min(1, u)).camQuat;
      expect(Math.hypot(...q)).toBeCloseTo(1, 9);
      expect(quatAngleDeg(prev, q)).toBeLessThan(1.0); // 90° over 100 steps → 0.9° per step
      prev = q.slice() as Quat;
    }
    // Nearly parallel quaternions take the normalised-lerp branch and still land at the midpoint.
    const tiny = new TakePlayer(take([sampleAt(0), sampleAt(1, { camQuat: rotY(0.5) })]));
    expect(quatAngleDeg(tiny.poseAt(0.5).camQuat, rotY(0.25))).toBeLessThan(ANGLE_EPS_DEG);
    expect(Math.hypot(...tiny.poseAt(0.5).camQuat)).toBeCloseTo(1, 12);
  });

  it('editsBetween returns the edits with t in (from, to], sorted, whatever order they were recorded in', () => {
    const edits: WorldEdit[] = [
      { t: 3, kind: 'propRelease', propId: 'can' },
      { t: 1, kind: 'propGrab', propId: 'can' },
      { t: 2, kind: 'propThrow', propId: 'can', velocity: [0, 1, 0] },
      { t: 2, kind: 'sdfPaint', shape: 'sphere', pos: [0, 0, 0], r: 0.1, rgba: [1, 2, 3, 4] },
    ];
    const p = new TakePlayer(take([sampleAt(0), sampleAt(4)], edits));
    const kinds = (from: number, to: number) => p.editsBetween(from, to).map((e) => `${e.t}:${e.kind}`);
    expect(kinds(1, 2)).toEqual(['2:propThrow', '2:sdfPaint']);
    expect(kinds(0, 1)).toEqual(['1:propGrab']);
    expect(kinds(-1, 0.999)).toEqual([]);
    expect(kinds(2, 2)).toEqual([]);
    expect(kinds(3, 2)).toEqual([]);
    expect(kinds(0, 3)).toEqual(['1:propGrab', '2:propThrow', '2:sdfPaint', '3:propRelease']);
    expect(kinds(2.5, 10)).toEqual(['3:propRelease']);
    expect(kinds(3, 10)).toEqual([]);
    expect(kinds(-Infinity, Infinity)).toHaveLength(4);
    expect(edits[0]!.t).toBe(3); // the take's own array is not reordered
  });

  it('replays an empty take as the origin / identity and a single-sample take as that sample', () => {
    const empty = new TakePlayer(take([], [], 2));
    expect(empty.durationS).toBe(2);
    expect(empty.poseAt(1)).toEqual({
      pos: [0, 0, 0],
      yaw: 0,
      speed: 0,
      grounded: false,
      driving: false,
      camPos: [0, 0, 0],
      camQuat: [0, 0, 0, 1],
    });
    const one = new TakePlayer(take([sampleAt(0.5, { pos: [1, 2, 3], yaw: 1, speed: 3, camQuat: rotY(30) })]));
    expect(one.poseAt(0)).toMatchObject({ pos: [1, 2, 3], yaw: 1, speed: 3 });
    expect(one.poseAt(9)).toMatchObject({ pos: [1, 2, 3], camQuat: rotY(30) });
    expect(() => new TakePlayer({ ...take([]), v: 2 } as unknown as TakeV1)).toThrow(/v1/);
  });

  it('sequential playback (cursor fast path) agrees with random seeks', () => {
    const samples: TakeSample[] = [];
    for (let i = 0; i < 300; i++)
      samples.push(sampleAt(i / 30, { pos: [Math.sin(i / 7), i / 50, Math.cos(i / 11)], yaw: Math.sin(i / 5) * Math.PI }));
    const t = take(samples);
    const seq = new TakePlayer(t);
    const seek = new TakePlayer(t);
    const out = {
      pos: [0, 0, 0] as [number, number, number],
      yaw: 0,
      speed: 0,
      camPos: [0, 0, 0] as [number, number, number],
      camQuat: [0, 0, 0, 1] as Quat,
    };
    for (let time = 0; time <= 10; time += 1 / 120) {
      seq.poseAt(time, out);
      expect(out).toEqual(seek.poseAt(time));
    }
    expect(seek.poseAt(2.5)).toEqual(new TakePlayer(t).poseAt(2.5)); // seeking back after a forward walk
    expect(seq.poseAt(0.1)).toEqual(new TakePlayer(t).poseAt(0.1));
  });
});

// ── encodeTake / decodeTake ──────────────────────────────────────────────────────────────────────────────────────────

describe('encodeTake / decodeTake', () => {
  it('round-trips recorder output exactly (samples are float32 already) including world edits', () => {
    const rec = new TakeRecorder({ actorId: 'player', cellVersion: '2026-09-20.1', idFactory: () => 'rt-1' });
    rec.start(T0);
    for (let k = 0; k < 240; k++) {
      rec.sample(
        T0 + k * (1000 / 60),
        input(k, {
          pos: [Math.sin(k) * 30, k * 0.01, -k * 0.2],
          yaw: Math.sin(k / 3) * Math.PI,
          speed: k % 7,
          grounded: k % 5 !== 0,
          camQuat: rotY(k),
        }),
      );
    }
    rec.edit(T0 + 1000, { kind: 'sdfPaint', shape: 'sphere', pos: [1, 1.4, -2], r: 0.12, rgba: [255, 40, 120, 255] });
    rec.edit(T0 + 2000, { kind: 'propThrow', propId: 'can', velocity: [1, 2, 3] });
    const t = rec.stop(T0 + 4000);
    const bytes = encodeTake(t);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const back = decodeTake(bytes);
    expect(back).toEqual(t);
    expect(back.samples).not.toBe(t.samples);
    expect(back.samples.some((s) => !s.grounded)).toBe(true);
  });

  it('round-trips hand-built double-precision samples within 1e-6', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const samples: TakeSample[] = [];
    for (let i = 0; i < 500; i++) {
      const q: Quat = [rand(), rand(), rand(), rand()];
      const len = Math.hypot(...q);
      samples.push({
        t: i / 30 + rand() * 1e-3,
        pos: [rand() * 15, rand() * 15, rand() * 15],
        yaw: rand() * Math.PI,
        speed: Math.abs(rand()) * 12,
        grounded: rand() > 0,
        driving: rand() > 0.5,
        camPos: [rand() * 15, rand() * 15, rand() * 15],
        camQuat: q.map((v) => v / len) as Quat,
      });
    }
    const back = decodeTake(encodeTake(take(samples, [{ t: 1.25, kind: 'propGrab', propId: 'can' }], 17)));
    expect(back.samples).toHaveLength(500);
    expect(back.durationS).toBe(17);
    expect(back.worldEdits).toEqual([{ t: 1.25, kind: 'propGrab', propId: 'can' }]);
    for (let i = 0; i < samples.length; i++) {
      const a = samples[i]!;
      const b = back.samples[i]!;
      expect(Math.abs(a.t - b.t)).toBeLessThan(1e-6);
      expect(Math.abs(a.yaw - b.yaw)).toBeLessThan(1e-6);
      expect(Math.abs(a.speed - b.speed)).toBeLessThan(1e-6);
      expect(b.grounded).toBe(a.grounded);
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(a.pos[k]! - b.pos[k]!)).toBeLessThan(1e-6);
        expect(Math.abs(a.camPos[k]! - b.camPos[k]!)).toBeLessThan(1e-6);
      }
      for (let k = 0; k < 4; k++) expect(Math.abs(a.camQuat[k]! - b.camQuat[k]!)).toBeLessThan(1e-6);
    }
  });

  it('encodes a 60 s take at 30 Hz in ≤ 250 KB (53 bytes per sample + a small header)', () => {
    const { take } = record(120, 60);
    const bytes = encodeTake(take);
    const n = take.samples.length;
    expect(n).toBe(1801);
    expect(bytes.length).toBeLessThanOrEqual(250 * 1024);
    expect(bytes.length).toBeGreaterThanOrEqual(n * TAKE_BYTES_PER_SAMPLE);
    expect(bytes.length - n * TAKE_BYTES_PER_SAMPLE).toBeLessThan(1024); // header overhead
    expect(bytes.length).toBeLessThan(100 * 1024);
    expect(decodeTake(bytes).samples).toHaveLength(n);
  });

  it('rejects foreign, truncated or future-version bytes and reads from offset views', () => {
    const t = take([sampleAt(0, { pos: [1, 2, 3] }), sampleAt(1, { grounded: false })]);
    const bytes = encodeTake(t);
    expect(() => decodeTake(new TextEncoder().encode('{"v":1}'))).toThrow(/magic/);
    expect(() => decodeTake(bytes.subarray(0, bytes.length - 1))).toThrow(/length/);
    expect(() => decodeTake(bytes.subarray(0, 12))).toThrow(/truncated/);
    const v2 = encodeTake({ ...t, v: 2 as unknown as 1 }); // encode always writes v1; forge the header instead
    const text = new TextDecoder().decode(v2);
    const forged = new TextEncoder().encode(text.replace('{"v":1', '{"v":2'));
    expect(() => decodeTake(forged)).toThrow(/version 2/);
    // A view into a larger buffer at a non-zero byteOffset decodes identically.
    const big = new Uint8Array(bytes.length + 7);
    big.set(bytes, 3);
    expect(decodeTake(big.subarray(3, 3 + bytes.length))).toEqual(t);
  });

  it('packs driving into the flags byte next to grounded, and reads files written before the bit existed', () => {
    const t = take([sampleAt(0, { driving: true, grounded: false }), sampleAt(1, { driving: true }), sampleAt(2)]);
    const bytes = encodeTake(t);
    const flags = bytes.subarray(bytes.length - 3);
    expect([...flags]).toEqual([2, 3, 1]); // bit0 grounded, bit1 driving
    expect(decodeTake(bytes)).toEqual(t);
    // Legacy: a body whose flags column is the old u8 grounded (0 / 1) decodes with driving = false everywhere.
    flags[0] = 0;
    flags[1] = 1;
    const legacy = decodeTake(bytes);
    expect(legacy.samples.map((x) => x.driving)).toEqual([false, false, false]);
    expect(legacy.samples.map((x) => x.grounded)).toEqual([false, true, true]);
  });
});

describe('TakeRecorder actor id (ACT-3 possession)', () => {
  it('start(nowMs, actorId) tags the take with who performed it; the previous id sticks until changed', () => {
    const rec = new TakeRecorder({ actorId: 'player', cellVersion: 'v', idFactory: () => 'x' });
    rec.start(T0, 'photographer');
    rec.sample(T0, input(0, { driving: true }));
    const a = rec.stop(T0 + 100);
    expect(a.actorId).toBe('photographer');
    expect(a.samples[0]!.driving).toBe(true);
    rec.start(T0 + 200);
    rec.sample(T0 + 200, input(1));
    expect(rec.stop(T0 + 300).actorId).toBe('photographer');
    rec.start(T0 + 400, 'player');
    rec.sample(T0 + 400, input(2));
    expect(rec.stop(T0 + 500).actorId).toBe('player');
  });
});

// ── takeStore ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A minimal in-memory IDBFactory: enough of open/upgrade/transaction/put/get/getAll/delete to drive the real plumbing. */
function fakeIndexedDB(mode: 'ok' | 'throw' | 'error' | 'hang' = 'ok') {
  const stores = new Map<string, Map<string, unknown>>();
  const state = { opens: 0, stores };
  const request = <T>(fn: () => T, tx?: { oncomplete?: () => void }) => {
    const r: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => {
      try {
        r.result = fn();
        r.onsuccess?.();
        queueMicrotask(() => tx?.oncomplete?.());
      } catch (e) {
        r.error = e;
        r.onerror?.();
      }
    });
    return r;
  };
  const objectStore = (name: string, tx?: { oncomplete?: () => void }) => {
    const m = stores.get(name)!;
    return {
      put: (v: { id: string }) => request(() => (m.set(v.id, structuredClone(v)), v.id), tx),
      get: (k: string) => request(() => structuredClone(m.get(k)), tx),
      getAll: () => request(() => [...m.values()].map((v) => structuredClone(v)), tx),
      delete: (k: string) => request(() => (m.delete(k), undefined), tx),
    };
  };
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => (stores.set(n, new Map()), objectStore(n)),
    transaction: (n: string) => {
      const tx: { oncomplete?: () => void; objectStore: (name: string) => ReturnType<typeof objectStore> } = {
        objectStore: () => objectStore(n, tx),
      };
      return tx;
    },
    close: () => {},
  };
  const factory = {
    open() {
      state.opens++;
      if (mode === 'throw') throw new Error('SecurityError: IndexedDB is disabled');
      const r: { result?: typeof db; error?: Error; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = {};
      if (mode === 'hang') return r;
      queueMicrotask(() => {
        if (mode === 'error') {
          r.error = new Error('InvalidStateError: private mode');
          r.onerror?.();
          return;
        }
        r.result = db;
        r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  } as unknown as IDBFactory;
  return { factory, state };
}

describe('takeStore', () => {
  afterEach(() => vi.restoreAllMocks());

  const t1 = take([sampleAt(0), sampleAt(1, { pos: [1, 2, 3] })], [{ t: 0.5, kind: 'propGrab', propId: 'can' }], 1);

  it('memory fallback (no indexedDB): save / list / load / remove', async () => {
    expect(typeof indexedDB).toBe('undefined'); // vitest runs in node — the default store must fall back
    for (const store of [takeStore, createTakeStore({ indexedDB: null })]) {
      const a = { ...t1, id: 'a', startedAt: '2026-09-06T10:00:00.000Z' };
      const b = { ...t1, id: 'b', startedAt: '2026-09-06T09:00:00.000Z', actorId: 'npc-1', durationS: 4 };
      await store.save(a);
      await store.save(b);
      expect(await store.list()).toEqual([
        { id: 'b', actorId: 'npc-1', cellVersion: 'v', durationS: 4, startedAt: '2026-09-06T09:00:00.000Z' },
        { id: 'a', actorId: 'player', cellVersion: 'v', durationS: 1, startedAt: '2026-09-06T10:00:00.000Z' },
      ]);
      const loaded = await store.load('a');
      expect(loaded).toEqual(a);
      expect(loaded).not.toBe(a);
      expect(loaded!.samples).not.toBe(a.samples);
      expect(await store.load('nope')).toBeNull();
      await store.remove('a');
      await store.remove('nope');
      expect(await store.load('a')).toBeNull();
      expect((await store.list()).map((s) => s.id)).toEqual(['b']);
      await store.remove('b');
      expect(await store.list()).toEqual([]);
      await expect(store.save({ ...a, id: '' })).rejects.toThrow(/id/);
    }
  });

  it('persists through IndexedDB when it opens (one connection, records carry the SCH-4 bytes)', async () => {
    const { factory, state } = fakeIndexedDB('ok');
    const store = createTakeStore({ indexedDB: factory });
    await store.save({ ...t1, id: 'x' });
    await store.save({ ...t1, id: 'y', startedAt: '2026-09-07T00:00:00.000Z' });
    expect(state.opens).toBe(1);
    const records = state.stores.get('takes')!;
    expect([...records.keys()].sort()).toEqual(['x', 'y']);
    expect((records.get('x') as { bytes: Uint8Array }).bytes).toBeInstanceOf(Uint8Array);
    expect((await store.list()).map((s) => s.id)).toEqual(['x', 'y']);
    expect(await store.load('y')).toEqual({ ...t1, id: 'y', startedAt: '2026-09-07T00:00:00.000Z' });
    expect(await store.load('zzz')).toBeNull();
    await store.remove('x');
    expect([...records.keys()]).toEqual(['y']);
    expect((await store.list()).map((s) => s.id)).toEqual(['y']);
    expect(state.opens).toBe(1);
  });

  it('falls back to memory when IndexedDB.open throws, errors or hangs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const mode of ['throw', 'error', 'hang'] as const) {
      const { factory, state } = fakeIndexedDB(mode);
      const store = createTakeStore({ indexedDB: factory, openTimeoutMs: 20 });
      await store.save({ ...t1, id: mode });
      expect((await store.list()).map((s) => s.id)).toEqual([mode]);
      expect(await store.load(mode)).toEqual({ ...t1, id: mode });
      await store.remove(mode);
      expect(await store.list()).toEqual([]);
      expect(state.opens).toBe(1); // the decision is cached; no reopen storm
      expect(state.stores.size).toBe(0);
    }
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe('prop pose tracks (ACT-2 / STU-1: the replay re-throws the can)', () => {
  const q = (deg: number): Quat => {
    const h = (deg * Math.PI) / 360;
    return [0, Math.sin(h), 0, Math.cos(h)];
  };

  it('records only while a prop moves (rate-limited per prop), holds the final pose, and replays it interpolated', () => {
    const rec = new TakeRecorder({ actorId: 'player', cellVersion: 'v', idFactory: () => 't' });
    rec.start(T0);
    // A can at rest for a second: one sample (the first is always kept), then nothing.
    for (let k = 0; k <= 60; k++) rec.sampleProp(T0 + k * (1000 / 60), 'can_1', [1, 0.2, 0], [0, 0, 0, 1]);
    // Thrown at t = 1 s: it flies for a second.
    for (let k = 0; k <= 60; k++) {
      const t = 1 + k / 60;
      rec.sampleProp(T0 + t * 1000, 'can_1', [1 + (t - 1) * 4, 0.2 + (t - 1) * 2, 0], q((t - 1) * 180));
    }
    rec.sample(T0, input(0));
    const take = rec.stop(T0 + 3000);
    expect(take.props).toHaveLength(1);
    const track = take.props![0]!;
    expect(track.id).toBe('can_1');
    // 1 (rest) + ~30 (one second of flight at 30 Hz) + the hold at the end.
    expect(track.samples.length).toBeGreaterThanOrEqual(30);
    expect(track.samples.length).toBeLessThanOrEqual(34);
    expect(track.samples[0]).toEqual({ t: 0, pos: [1, Math.fround(0.2), 0], quat: [0, 0, 0, 1] }); // float32, like the actor
    expect(track.samples.at(-1)!.t).toBeCloseTo(3, 5);
    expect(track.samples.at(-1)!.pos[0]).toBeCloseTo(5, 3);
    const player = new TakePlayer(take);
    expect(player.propIds).toEqual(['can_1']);
    expect(player.propPoseAt('nope', 1)).toBeNull();
    expect(player.propPoseAt('can_1', 0.5)!.pos).toEqual([1, Math.fround(0.2), 0]); // still at rest between the first two samples
    const mid = player.propPoseAt('can_1', 1.5)!;
    expect(mid.pos[0]).toBeCloseTo(3, 1);
    expect(mid.pos[1]).toBeCloseTo(1.2, 1);
    expect(Math.hypot(...mid.quat)).toBeCloseTo(1, 5);
    expect(player.propPoseAt('can_1', 9)!.pos[0]).toBeCloseTo(5, 3); // held after the end
  });

  it('a prop that never moved leaves no track, and tracks survive the codec and a take without any', () => {
    const rec = new TakeRecorder({ actorId: 'player', cellVersion: 'v', idFactory: () => 't' });
    rec.start(T0);
    rec.sample(T0, input(0));
    for (let k = 0; k < 10; k++) rec.sampleProp(T0 + k * 40, 'crate_1', [0, 0, 0], [0, 0, 0, 1]);
    rec.sampleProp(T0 + 500, 'ball_1', [0, 1, 0], [0, 0, 0, 1]);
    rec.sampleProp(T0 + 600, 'ball_1', [0, 2, 0], [0, 0, 0, 1]);
    const take = rec.stop(T0 + 1000);
    expect(take.props!.map((p) => p.id)).toEqual(['ball_1']); // the crate was offered but never moved: no track
    const back = decodeTake(encodeTake(take));
    expect(back.props).toEqual(take.props);
    const still = new TakeRecorder({ actorId: 'player', cellVersion: 'v', idFactory: () => 's' });
    still.start(T0);
    still.sample(T0, input(0));
    const plain = still.stop(T0 + 100);
    expect(plain.props).toBeUndefined();
    expect(decodeTake(encodeTake(plain)).props).toBeUndefined();
  });
});
