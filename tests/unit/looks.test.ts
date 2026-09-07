import { describe, it, expect } from 'vitest';
import {
  LOOKS,
  LOOK_ORDER,
  NEUTRAL_POST,
  bakeLut,
  gradeColor,
  isLookName,
  isNeutralLook,
  lookRecipe,
} from '../../packages/engine/src/render/looks';
import { GRADES, TIME_ORDER, gradeState, lerpGradeState } from '../../packages/engine/src/world/grade';
import { LOOK_NAMES } from '../../packages/director/src/schema';
import { MISSIONS_V0 } from '../../packages/studio/src/missions';
import { parseUtterance } from '../../packages/director/src/grammar';

/** goal.md MIS-6 / STU-4 / W-5: the mission names the look; a look is a LUT on the finished picture. */
const rgb =
  (look = lookRecipe('clean'), post = NEUTRAL_POST) =>
  (r: number, g: number, b: number) =>
    gradeColor(look, post, r, g, b, [0, 0, 0]).map((v) => +v.toFixed(6));

describe('looks (MIS-6)', () => {
  it('ships clean, 35 mm dusk, VHS 1994, noir and neon night; the director schema and the missions name the same ones', () => {
    expect(LOOK_ORDER).toEqual(['clean', '35mm-dusk', 'vhs-1994', 'noir', 'neon-night']);
    expect([...LOOK_NAMES]).toEqual(LOOK_ORDER);
    for (const m of MISSIONS_V0) expect(isLookName(m.look)).toBe(true);
    expect(isLookName('sepia-1899')).toBe(false);
    expect(lookRecipe('sepia-1899')).toBe(LOOKS.clean);
    expect(lookRecipe(undefined).label).toBe('clean');
    expect(isNeutralLook(LOOKS.clean!)).toBe(true);
    for (const name of LOOK_ORDER.slice(1)) expect(isNeutralLook(LOOKS[name]!)).toBe(false);
  });

  it('clean is the identity; noir is monochrome; every look keeps black black-ish, white white-ish and grey in range', () => {
    const clean = rgb();
    expect(clean(0.2, 0.5, 0.8)).toEqual([0.2, 0.5, 0.8]);
    expect(clean(0, 0, 0)).toEqual([0, 0, 0]);
    expect(clean(1, 1, 1)).toEqual([1, 1, 1]);
    const noir = rgb(lookRecipe('noir'));
    const [r, g, b] = noir(0.8, 0.3, 0.1);
    expect(r).toBeCloseTo(g!, 6);
    expect(g).toBeCloseTo(b!, 6);
    for (const name of LOOK_ORDER) {
      const f = rgb(lookRecipe(name));
      const black = f(0, 0, 0);
      const white = f(1, 1, 1);
      const grey = f(0.5, 0.5, 0.5);
      expect(Math.max(...black)).toBeLessThan(0.15);
      expect(Math.min(...white)).toBeGreaterThan(0.85);
      for (const v of grey) {
        expect(v).toBeGreaterThan(0.3);
        expect(v).toBeLessThan(0.7);
      }
    }
    // 35 mm dusk warms the highlights and cools the shadows; VHS lifts the blacks (a faded print).
    const dusk = rgb(lookRecipe('35mm-dusk'));
    const hi = dusk(0.85, 0.85, 0.85);
    expect(hi[0]).toBeGreaterThan(hi[2]!);
    const lo = dusk(0.15, 0.15, 0.15);
    expect(lo[2]).toBeGreaterThan(lo[0]!);
    expect(rgb(lookRecipe('vhs-1994'))(0, 0, 0)[0]).toBeGreaterThan(0.02);
  });

  it('the time-of-day post share folds in first: contrast about middle grey and a lift', () => {
    const f = rgb(lookRecipe('clean'), { contrast: 1.2, lift: 0 });
    expect(f(0.5, 0.5, 0.5)).toEqual([0.5, 0.5, 0.5]);
    expect(f(0.7, 0.7, 0.7)[0]).toBeCloseTo(0.74, 6);
    expect(f(0.3, 0.3, 0.3)[0]).toBeCloseTo(0.26, 6);
    expect(rgb(lookRecipe('clean'), { contrast: 1, lift: 0.03 })(0, 0, 0)).toEqual([0.03, 0.03, 0.03]);
    expect(isNeutralLook(LOOKS.clean!, { contrast: 1.2, lift: 0 })).toBe(false);
    for (const t of TIME_ORDER) {
      expect(GRADES[t].post.contrast).toBeGreaterThan(0.8);
      expect(GRADES[t].post.contrast).toBeLessThan(1.3);
    }
    expect(GRADES.noon.post).toEqual({ contrast: 1, lift: 0 });
    expect(GRADES.fog_noon.post.contrast).toBeLessThan(1); // fog flattens
    expect(GRADES.night.post.contrast).toBeGreaterThan(1);
    const s = gradeState(GRADES.noon);
    lerpGradeState(s, gradeState(GRADES.night), 0.5);
    expect(s.postContrast).toBeCloseTo((1 + GRADES.night.post.contrast) / 2, 6);
  });

  it('bakes a cubic LUT with red fastest (the postprocessing LookupTexture layout), reusing the buffer', () => {
    const size = 8;
    const lut = bakeLut(lookRecipe('clean'), NEUTRAL_POST, size);
    expect(lut.length).toBe(size * size * size * 4);
    const at = (r: number, g: number, b: number) => {
      const i = (r + g * size + b * size * size) * 4;
      return [lut[i], lut[i + 1], lut[i + 2], lut[i + 3]];
    };
    expect(at(0, 0, 0)).toEqual([0, 0, 0, 1]);
    expect(at(7, 0, 0)).toEqual([1, 0, 0, 1]);
    expect(at(0, 7, 0)).toEqual([0, 1, 0, 1]);
    expect(at(0, 0, 7)).toEqual([0, 0, 1, 1]);
    expect(at(3, 5, 6).map((v) => +v!.toFixed(6))).toEqual([3 / 7, 5 / 7, 6 / 7, 1].map((v) => +v.toFixed(6)));
    const again = bakeLut(lookRecipe('noir'), NEUTRAL_POST, size, lut);
    expect(again).toBe(lut); // in place
    const i = (7 + 0 * size + 0 * size * size) * 4;
    expect(lut[i]).toBeCloseTo(lut[i + 1]!, 6); // pure red is now grey
    expect(bakeLut(lookRecipe('clean'), NEUTRAL_POST, 4, lut)).not.toBe(lut); // a different size gets its own buffer
  });

  it('the director knows the look words and keeps them apart from the light words', () => {
    expect(parseUtterance('make it noir').acts[0]).toEqual({ op: 'set_look', preset: 'noir' });
    expect(parseUtterance('use the vhs look').acts[0]).toEqual({ op: 'set_look', preset: 'vhs-1994' });
    expect(parseUtterance('35mm dusk').acts[0]).toEqual({ op: 'set_look', preset: '35mm-dusk' });
    expect(parseUtterance('neon night').acts[0]).toEqual({ op: 'set_look', preset: 'neon-night' });
    expect(parseUtterance('grade it monochrome').acts[0]).toEqual({ op: 'set_look', preset: 'noir' });
    expect(parseUtterance('clean look').acts[0]).toEqual({ op: 'set_look', preset: 'clean' });
    expect(parseUtterance('night').acts[0]).toEqual({ op: 'set_time', preset: 'night' });
    expect(parseUtterance('dusk').acts[0]).toEqual({ op: 'set_time', preset: 'blue' });
    expect(parseUtterance('clear').acts[0]).toEqual({ op: 'set_weather', kind: 'clear' });
    expect(parseUtterance('put on the noir look, then golden hour').acts).toEqual([
      { op: 'set_look', preset: 'noir' },
      { op: 'set_time', preset: 'golden' },
    ]);
  });
});
