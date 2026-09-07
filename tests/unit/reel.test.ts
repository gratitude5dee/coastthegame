import { describe, it, expect } from 'vitest';
import { Reel } from '../../packages/studio/src/reel';
import { MISSIONS_V0 } from '../../packages/studio/src/missions';

/** goal.md MIS-4: the reel fills bar by bar; the best take per mission is what it keeps. */
describe('Reel', () => {
  it('starts empty over the track, keeps the best take per mission, and counts bars earned', () => {
    const reel = new Reel(MISSIONS_V0);
    expect(reel.totalBars).toBe(64);
    expect(reel.entries.map((e) => e.bars)).toEqual([
      [9, 16],
      [17, 20],
    ]);
    expect(reel.progress()).toEqual({ earnedBars: 0, coveredBars: 12, totalBars: 64, fraction: 0 });
    expect(reel.record('m01-low-and-slow', 0, 't1')).toBe(true); // a ☆☆☆ take still fills the slot
    expect(reel.record('m01-low-and-slow', 2, 't2')).toBe(true);
    expect(reel.record('m01-low-and-slow', 1, 't3')).toBe(false); // worse: kept out
    expect(reel.record('m01-low-and-slow', 2, 't4')).toBe(true); // ties go to the newer take
    expect(reel.record('nope', 3, 't5')).toBe(false);
    expect(reel.entry('m01-low-and-slow')).toMatchObject({ stars: 2, takeId: 't4' });
    expect(reel.progress()).toMatchObject({ earnedBars: 8, coveredBars: 12 });
    expect(reel.progress().fraction).toBeCloseTo(8 / 12);
    expect(reel.earned().map((e) => e.missionId)).toEqual(['m01-low-and-slow']);
  });

  it('round-trips through its saved state, dropping blob URLs and unknown missions', () => {
    const reel = new Reel(MISSIONS_V0);
    reel.record('m02-hop-on-the-one', 3, 'take-x');
    reel.setCut('m02-hop-on-the-one', 'blob:local');
    const saved = JSON.parse(JSON.stringify(reel.serialize()));
    saved.entries.push({ missionId: 'ghost', stars: 3, takeId: 'g', cutUrl: null });
    saved.entries[0].stars = 9; // junk
    const back = new Reel(MISSIONS_V0);
    back.restore(saved);
    expect(back.entry('m02-hop-on-the-one')).toMatchObject({ stars: 3, takeId: 'take-x', cutUrl: null });
    expect(back.entry('m01-low-and-slow')).toMatchObject({ stars: 0, takeId: null });
    back.setCut('m02-hop-on-the-one', 'https://coast.wzrd.tech/c/abc');
    const again = new Reel(MISSIONS_V0);
    again.restore(back.serialize());
    expect(again.entry('m02-hop-on-the-one')!.cutUrl).toBe('https://coast.wzrd.tech/c/abc');
    again.restore(null);
    again.restore({ v: 2 });
    expect(again.entry('m02-hop-on-the-one')!.stars).toBe(3);
  });
});
