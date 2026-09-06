import { describe, it, expect } from 'vitest';
import { barStartS, frameTime, planCut, CUT_MAX_SECONDS } from '../../packages/studio/src/export';

/** goal.md STU-1/STU-3: a cut is a fixed-step plan over the set — whole set, or a bar range of the track, capped. */
describe('planCut', () => {
  it('covers the whole set at 30 fps by default, 1080p, camera from the newest layer', () => {
    const p = planCut({ durationS: 4.5 });
    expect(p).toMatchObject({ fps: 30, width: 1920, height: 1080, startS: 0, frameCount: 135, cameraLayer: -1 });
    expect(p.endS).toBeCloseTo(4.5);
    expect(frameTime(p, 0)).toBe(0);
    expect(frameTime(p, 30)).toBeCloseTo(1);
  });

  it('a bar range on the beat grid picks the time span, clamped to the set', () => {
    // 92 bpm, 4/4: a bar is 2.6087 s.
    expect(barStartS(1)).toBe(0);
    expect(barStartS(9)).toBeCloseTo(8 * 4 * (60 / 92));
    expect(barStartS(2, { trackId: 't', bpm: 120, offsetMs: 500, beatsPerBar: 4 })).toBeCloseTo(2.5);
    const p = planCut({ durationS: 40, bars: [9, 12], fps: 24 });
    expect(p.startS).toBeCloseTo(barStartS(9));
    expect(p.endS).toBeCloseTo(barStartS(13), 1);
    expect(p.frameCount).toBe(Math.round(4 * 4 * (60 / 92) * 24));
    const clamped = planCut({ durationS: 10, bars: [3, 8] });
    expect(clamped.startS).toBeCloseTo(barStartS(3));
    expect(clamped.endS).toBeCloseTo(10, 1);
    const empty = planCut({ durationS: 3, bars: [9, 10] });
    expect(empty.frameCount).toBe(0);
  });

  it('caps a cut at 60 s and never plans negative or fractional frames', () => {
    const p = planCut({ durationS: 200 });
    expect(p.endS).toBe(CUT_MAX_SECONDS);
    expect(p.frameCount).toBe(1800);
    expect(planCut({ durationS: -1 }).frameCount).toBe(0);
    expect(planCut({ durationS: 1.02, fps: 24 }).frameCount).toBe(24);
    expect(planCut({ durationS: 2, width: 640, height: 360, cameraLayer: 1 })).toMatchObject({ width: 640, height: 360, cameraLayer: 1 });
  });
});
