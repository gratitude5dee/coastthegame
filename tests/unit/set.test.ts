import { describe, it, expect } from 'vitest';
import { TakeSet, setTime } from '../../packages/studio/src/set';
import type { TakeSample, TakeV1 } from '../../packages/studio/src/takes';

/** goal.md ACT-2 multi-take blocking (§3.1 step 5): the mission's takes replay together; short takes hold their mark. */
function sampleAt(t: number, x: number, driving = false): TakeSample {
  return { t, pos: [x, 0, 0], yaw: 0, speed: 1, grounded: true, driving, camPos: [0, 1.6, 2], camQuat: [0, 0, 0, 1] };
}

function take(id: string, actorId: string, seconds: number, edits: TakeV1['worldEdits'] = []): TakeV1 {
  const samples: TakeSample[] = [];
  for (let i = 0; i <= seconds * 10; i++) samples.push(sampleAt(i / 10, i / 10, actorId === 'driver'));
  return { v: 1, id, actorId, cellVersion: 'v', hz: 10, startedAt: '', durationS: seconds, samples, worldEdits: edits };
}

describe('TakeSet', () => {
  it('layers takes in order, is as long as its longest take, and holds a finished layer at its last pose', () => {
    const set = new TakeSet(3);
    expect(set.size).toBe(0);
    expect(set.durationS).toBe(0);
    expect(set.poseAt(0, 1)).toBeNull();
    set.add(take('a', 'player', 2));
    set.add(take('b', 'driver', 5));
    expect(set.size).toBe(2);
    expect(set.durationS).toBe(5);
    // Both perform on the same clock …
    expect(set.poseAt(0, 1)!.pos[0]).toBeCloseTo(1);
    expect(set.poseAt(1, 1)!.pos[0]).toBeCloseTo(1);
    expect(set.poseAt(1, 1)!.driving).toBe(true);
    // … and layer 0 holds its mark after its own 2 s while layer 1 keeps going.
    expect(set.poseAt(0, 4)!.pos[0]).toBeCloseTo(2);
    expect(set.poseAt(1, 4)!.pos[0]).toBeCloseTo(4);
  });

  it('caps the layers (the oldest take drops off) and forgets a scrapped take by id', () => {
    const set = new TakeSet(2);
    set.add(take('a', 'player', 1));
    set.add(take('b', 'player', 1));
    set.add(take('c', 'player', 1));
    expect(set.layers.map((l) => l.take.id)).toEqual(['b', 'c']);
    expect(set.remove('b')).toBe(true);
    expect(set.remove('zzz')).toBe(false);
    expect(set.layers.map((l) => l.take.id)).toEqual(['c']);
    set.clear();
    expect(set.size).toBe(0);
  });

  it("hands out each layer's world edits once per pass, replaying them again when the loop restarts", () => {
    const set = new TakeSet();
    set.add(
      take('a', 'player', 3, [
        { t: 0.5, kind: 'sdfPaint', shape: 'sphere', pos: [0, 1, 0], r: 0.2, rgba: [255, 0, 0, 255] },
        { t: 2.5, kind: 'propGrab', propId: 'can' },
      ]),
    );
    set.rewind();
    expect(set.editsSince(0, 0.4)).toEqual([]);
    expect(set.editsSince(0, 1).map((e) => e.kind)).toEqual(['sdfPaint']);
    expect(set.editsSince(0, 2)).toEqual([]);
    expect(set.editsSince(0, 3).map((e) => e.kind)).toEqual(['propGrab']);
    // The loop wrapped (time went backwards): the pass starts over from the beginning.
    expect(set.editsSince(0, 0.6).map((e) => e.kind)).toEqual(['sdfPaint']);
    expect(set.editsSince(9, 1)).toEqual([]); // no such layer
  });

  it('setTime counts up under a rolling take and wraps at the set length when looping', () => {
    expect(setTime(1000, 1000, 5, false)).toBe(0);
    expect(setTime(7500, 1000, 5, false)).toBeCloseTo(6.5); // past the end: the caller's pose clamps
    expect(setTime(7500, 1000, 5, true)).toBeCloseTo(1.5);
    expect(setTime(500, 1000, 5, true)).toBe(0); // never negative
    expect(setTime(2000, 1000, 0, true)).toBeCloseTo(0, 2); // empty set: no NaN
  });
});
