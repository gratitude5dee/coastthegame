import { describe, it, expect } from 'vitest';
import { StrideTracker } from '../../packages/engine/src/audio/stride';

/** goal.md AUD-3: footsteps fire per metre walked, alternate feet, sprint lengthens the stride, landings after air. */
describe('StrideTracker', () => {
  it('fires a step every walkStride metres, alternating feet, at any frame rate — but never more than one per frame', () => {
    const run = (dt: number) => {
      const s = new StrideTracker({ walkStride: 0.75 });
      let steps = 0;
      const feet: number[] = [];
      let frames = 0;
      for (let t = 0; t < 6; t += dt) {
        frames++;
        for (const ev of s.update(3, true, dt)) {
          if (ev === 'step') {
            steps++;
            feet.push(s.foot);
          }
        }
      }
      for (let i = 1; i < feet.length; i++) expect(feet[i]).not.toBe(feet[i - 1]);
      return { steps, frames };
    };
    expect(run(1 / 60).steps).toBe(24); // 18 m / 0.75
    expect(run(1 / 12).steps).toBe(24);
    const slow = run(0.4); // 1.2 m per frame: a step per frame, never a burst
    expect(slow.steps).toBe(slow.frames);
  });

  it('uses the longer stride when sprinting and stays silent when standing still', () => {
    const s = new StrideTracker({ walkStride: 0.75, sprintStride: 1.1, sprintAbove: 4.5 });
    let steps = 0;
    for (let i = 0; i < 120; i++) steps += s.update(6, true, 1 / 60).filter((e) => e === 'step').length; // 12 m at 6 m/s
    expect(steps).toBe(10); // 12 / 1.1 → 10 full strides
    expect(s.update(0.1, true, 1 / 60)).toEqual([]);
    expect(s.update(0, true, 1)).toEqual([]);
  });

  it('reports a landing after ≥ 120 ms in the air, not after a physics micro-hop', () => {
    const s = new StrideTracker();
    for (let i = 0; i < 20; i++) expect(s.update(0, false, 1 / 60)).toEqual([]); // 333 ms airborne
    expect(s.update(0, true, 1 / 60)).toEqual(['land']);
    s.update(0, false, 1 / 60); // one frame off the ground (a step edge)
    expect(s.update(0, true, 1 / 60)).toEqual([]);
  });
});
