import { describe, it, expect } from 'vitest';
import { BeatClock, DEFAULT_BEAT_GRID, beatsForBars } from '../../packages/studio/src/beats';

/** goal.md AUD-2 / MIS-2 beatSync: the beat clock is the game's metronome and the judge's ruler. */
describe('BeatClock', () => {
  const grid = { ...DEFAULT_BEAT_GRID, bpm: 120, beatsPerBar: 4 }; // 500 ms beats, 2 s bars

  it('maps wall time to beats, bars and the signed distance to the nearest beat', () => {
    const c = new BeatClock(grid);
    c.start(10_000);
    expect(c.beatMs).toBe(500);
    const p = c.phase(10_000 + 5 * 500 + 120); // 120 ms after beat 5 (late)
    expect(p.beatIndex).toBe(5);
    expect(p.beatInBar).toBe(1);
    expect(p.bar).toBe(1);
    expect(p.progress).toBeCloseTo(0.24, 5);
    expect(p.nearestIndex).toBe(5);
    expect(p.msToNearest).toBeCloseTo(120, 5);
    const early = c.phase(10_000 + 6 * 500 - 80); // 80 ms before beat 6 (early)
    expect(early.beatIndex).toBe(5);
    expect(early.nearestIndex).toBe(6);
    expect(early.msToNearest).toBeCloseTo(-80, 5);
  });

  it('honours the grid offset and a playhead start', () => {
    const c = new BeatClock({ ...grid, offsetMs: 250 });
    c.start(0, 1_000); // the track is already 1 s in
    expect(c.beatAt(0)).toBeCloseTo((1_000 - 250) / 500, 6);
    expect(c.timeOf(0)).toBe(-750);
  });

  it('reports the beats crossed since the last poll, at most 8 after a stall', () => {
    const c = new BeatClock(grid);
    c.start(0);
    expect(c.crossed(0)).toEqual([]);
    expect(c.crossed(499)).toEqual([]);
    expect(c.crossed(500)).toEqual([1]);
    expect(c.crossed(1_600)).toEqual([2, 3]);
    expect(c.crossed(1_700)).toEqual([]);
    expect(c.crossed(60_000)).toHaveLength(8);
    expect(c.crossed(60_000)).toEqual([]);
    c.stop();
    expect(c.crossed(90_000)).toEqual([]);
  });

  it('bar ranges map to beat ranges (1-based bars, inclusive)', () => {
    expect(beatsForBars(grid, [1, 1])).toEqual([0, 4]);
    expect(beatsForBars(grid, [9, 16])).toEqual([32, 64]);
  });

  it('rejects a degenerate grid', () => {
    expect(() => new BeatClock({ ...grid, bpm: 0 })).toThrow();
  });
});
