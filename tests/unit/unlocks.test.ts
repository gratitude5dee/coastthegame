import { describe, it, expect } from 'vitest';
import { Reel } from '../../packages/studio/src/reel';
import { MISSIONS_V0 } from '../../packages/studio/src/missions';
import {
  CLASSIC_PATTERN,
  FREE_LENS_MM,
  FREE_TIME_PRESETS,
  STAR_LADDER,
  UNLOCKS,
  lensFor,
  nextUnlock,
  starsNeeded,
  totalStars,
  unlocksFor,
  unlocksOfKind,
} from '../../packages/studio/src/unlocks';

/** goal.md MIS-4: stars unlock outfits, lenses (24/35/50/85), hydraulic patterns, time presets and NPC cameos. */
describe('unlocks (MIS-4)', () => {
  it('the catalogue covers every kind MIS-4 names; every mission reward and ladder rung is in it', () => {
    const kinds = new Set(Object.values(UNLOCKS).map((u) => u.kind));
    expect([...kinds].sort()).toEqual(['cameo', 'lens', 'outfit', 'pattern', 'time']);
    expect(unlocksOfKind(Object.keys(UNLOCKS), 'lens').map((l) => l.mm)).toEqual([35, 50, 85]);
    expect(FREE_LENS_MM).toBe(24);
    for (const m of MISSIONS_V0) expect(UNLOCKS[m.reward.unlock!]).toBeDefined();
    for (const r of STAR_LADDER) expect(UNLOCKS[r.unlock]).toBeDefined();
    expect(STAR_LADDER.map((r) => r.stars)).toEqual([...STAR_LADDER.map((r) => r.stars)].sort((a, b) => a - b)); // climbs
    for (const u of Object.values(UNLOCKS)) expect(u.id in UNLOCKS && UNLOCKS[u.id] === u).toBe(true);
    expect(FREE_TIME_PRESETS).toContain('golden'); // the golden path never waits on a star
    expect(CLASSIC_PATTERN).toEqual(['front', 'back', 'left', 'right']);
  });

  it('a mission earned (≥ 1★) grants its reward; the ladder pays out on total stars; nothing twice', () => {
    const reel = new Reel(MISSIONS_V0);
    expect(unlocksFor(reel, MISSIONS_V0)).toEqual([]);
    expect(totalStars(reel)).toBe(0);
    reel.record('m01-low-and-slow', 1, 't1');
    expect(unlocksFor(reel, MISSIONS_V0)).toEqual(['lens-35mm']);
    reel.record('m02-hop-on-the-one', 1, 't2');
    expect(unlocksFor(reel, MISSIONS_V0)).toEqual(['lens-35mm', 'hydraulics-three-wheel', 'time-night']); // 2★ total
    reel.record('m01-low-and-slow', 3, 't3');
    expect(totalStars(reel)).toBe(4);
    expect(unlocksFor(reel, MISSIONS_V0)).toEqual(['lens-35mm', 'hydraulics-three-wheel', 'time-night', 'lens-50mm', 'outfit-gold']);
    reel.record('m02-hop-on-the-one', 3, 't4');
    const all = unlocksFor(reel, MISSIONS_V0);
    expect(all).toContain('lens-85mm');
    expect(all).toContain('cameo-dj');
    expect(all).not.toContain('time-fog'); // 8★ needs a third mission
    expect(new Set(all).size).toBe(all.length);
    // A worse take never takes an unlock away (the reel keeps the best verdict).
    reel.record('m01-low-and-slow', 0, 't5');
    expect(unlocksFor(reel, MISSIONS_V0)).toEqual(all);
  });

  it('says what the next star brings, how many stars a locked thing needs, and which lens a focal length is', () => {
    const reel = new Reel(MISSIONS_V0);
    expect(nextUnlock(reel)).toMatchObject({ stars: 2, starsToGo: 2, unlock: { id: 'time-night' } });
    reel.record('m01-low-and-slow', 2, 't');
    expect(nextUnlock(reel)).toMatchObject({ stars: 3, starsToGo: 1, unlock: { id: 'lens-50mm' } });
    expect(starsNeeded('lens-35mm', reel, MISSIONS_V0)).toBe(0); // the mission's reward, earned
    expect(starsNeeded('hydraulics-three-wheel', reel, MISSIONS_V0)).toBe(1); // mission 2's reward: one star there
    expect(starsNeeded('lens-85mm', reel, MISSIONS_V0)).toBe(4);
    expect(starsNeeded('lens-nope', reel, MISSIONS_V0)).toBe(Infinity);
    expect(lensFor(24)).toEqual({ mm: 24, unlock: null });
    expect(lensFor(28).mm).toBe(24);
    expect(lensFor(40)).toMatchObject({ mm: 35, unlock: { id: 'lens-35mm' } });
    expect(lensFor(70)).toMatchObject({ mm: 85 });
    expect(lensFor(200).unlock?.id).toBe('lens-85mm');
    reel.record('m02-hop-on-the-one', 3, 't2');
    reel.record('m01-low-and-slow', 3, 't3');
    expect(nextUnlock(reel)).toMatchObject({ stars: 8, unlock: { id: 'time-fog' } });
  });
});

describe('the director wears and runs unlocks (loadout)', () => {
  it('parses outfit and pattern words; a locked one comes back with the reason', async () => {
    const { parseUtterance } = await import('../../packages/director/src/grammar');
    const { ActExecutor } = await import('../../packages/director/src/executor');
    const { DeixisBuffer } = await import('../../packages/engine/src/intents/intents');
    expect(parseUtterance('wear the gold fit').acts[0]).toEqual({ op: 'loadout', outfit: 'outfit-gold' });
    expect(parseUtterance('put on the chrome').acts[0]).toEqual({ op: 'loadout', outfit: 'outfit-chrome' });
    expect(parseUtterance('default fit').acts[0]).toEqual({ op: 'loadout', outfit: 'default' });
    expect(parseUtterance('three-wheel motion').acts[0]).toEqual({ op: 'loadout', pattern: 'hydraulics-three-wheel' });
    expect(parseUtterance('hydraulics pancake').acts[0]).toEqual({ op: 'loadout', pattern: 'hydraulics-pancake' });
    expect(parseUtterance('classic hops').acts[0]).toEqual({ op: 'loadout', pattern: 'classic' });
    expect(parseUtterance('gold').acts).toEqual([]); // a colour alone is not an outfit
    // The executor hands the game's reason back as the error, and confirms what it wore otherwise.
    const worn: unknown[] = [];
    const ops = {
      objects: () => [],
      byId: () => null,
      describe: () => [],
      setLoadout: (l: { outfit?: string; pattern?: string }) => {
        worn.push(l);
        return l.outfit === 'outfit-chrome' ? 'the chrome fit is locked — 5★ more on the reel unlocks it' : (true as const);
      },
    } as unknown as ConstructorParameters<typeof ActExecutor>[0];
    const ex = new ActExecutor(ops);
    const out = ex.say('wear the gold fit, put on the chrome, three-wheel motion', {
      buffer: new DeixisBuffer(),
      speech: { startMs: 0, endMs: 1000 },
      mode: 'actor',
      speakerForward: [0, -1],
    });
    expect(out.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(out.results[1]!.error).toMatch(/chrome fit is locked — 5★/);
    expect(worn).toEqual([{ outfit: 'outfit-gold' }, { outfit: 'outfit-chrome' }, { pattern: 'hydraulics-three-wheel' }]);
  });
});
