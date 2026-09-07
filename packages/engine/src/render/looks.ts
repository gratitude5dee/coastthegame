/**
 * Looks (goal.md MIS-6 "the mission names the look", STU-4 "colour LUT named by the mission's look", W-5 "post LUT"):
 * a look is a film stock — a colour transform on the finished picture, applied as a 3D LUT by the post stack
 * (`render/post.ts`) live and in the cut export, so the splats, the props, the sky and the ghosts all take the same
 * grade. Recipes are baked into the LUT here, on the CPU, from a handful of knobs (ASC-CDL-ish lift · gamma · gain,
 * contrast about middle grey, saturation, split toning, a faded print, plus vignette / grain / aberration / bloom
 * amounts the post stack reads directly). Pure and import-free: unit-tested, and the same numbers describe the look in
 * the provenance manifest. The time-of-day grade adds its own contrast / lift on top (`world/grade.ts`).
 */

export interface LookRecipe {
  label: string;
  /** Contrast about middle grey (1 = as rendered). */
  contrast: number;
  /** 0 = monochrome, 1 = as rendered. */
  saturation: number;
  /** ASC CDL in display space: out = (in · gain + lift) ^ (1 / gamma), per channel. */
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
  /** Split toning: a chroma pushed into the shadows and one into the highlights (amount 0 = none). */
  shadowTint: [number, number, number];
  shadowAmount: number;
  highlightTint: [number, number, number];
  highlightAmount: number;
  /** A faded print: black lifts to `fade · 0.12`. */
  fade: number;
  /** Post-stack amounts (0..1): vignette darkness, film grain, chromatic aberration, and how much bloom the look lets through. */
  vignette: number;
  grain: number;
  aberration: number;
  bloom: number;
}

const NEUTRAL: Omit<LookRecipe, 'label'> = {
  contrast: 1,
  saturation: 1,
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  shadowTint: [0, 0, 0],
  shadowAmount: 0,
  highlightTint: [0, 0, 0],
  highlightAmount: 0,
  fade: 0,
  vignette: 0,
  grain: 0,
  aberration: 0,
  bloom: 1,
};

/** The looks a mission can name (MIS-6). `clean` is the picture as rendered. */
export const LOOKS: Record<string, LookRecipe> = {
  clean: { label: 'clean', ...NEUTRAL },
  '35mm-dusk': {
    label: '35 mm dusk',
    ...NEUTRAL,
    contrast: 1.08,
    saturation: 1.12,
    lift: [0.012, 0.006, 0],
    gain: [1.02, 0.985, 0.92],
    shadowTint: [0.25, 0.35, 0.6],
    shadowAmount: 0.22,
    highlightTint: [1, 0.82, 0.55],
    highlightAmount: 0.28,
    fade: 0.06,
    vignette: 0.35,
    grain: 0.12,
    bloom: 0.7,
  },
  'vhs-1994': {
    label: 'VHS 1994',
    ...NEUTRAL,
    contrast: 0.94,
    saturation: 1.3,
    lift: [0.015, 0, 0.02],
    gamma: [1.05, 1.05, 1.05],
    gain: [1, 0.97, 0.95],
    shadowTint: [0.35, 0.2, 0.5],
    shadowAmount: 0.15,
    highlightTint: [1, 0.9, 0.7],
    highlightAmount: 0.15,
    fade: 0.18,
    vignette: 0.2,
    grain: 0.35,
    aberration: 0.6,
    bloom: 1.3,
  },
  noir: {
    label: 'noir',
    ...NEUTRAL,
    contrast: 1.25,
    saturation: 0,
    gamma: [0.95, 0.95, 0.95],
    fade: 0.05,
    vignette: 0.5,
    grain: 0.25,
    bloom: 0.4,
  },
  'neon-night': {
    label: 'neon night',
    ...NEUTRAL,
    contrast: 1.1,
    saturation: 1.25,
    gain: [0.95, 0.98, 1.08],
    shadowTint: [0.2, 0.25, 0.7],
    shadowAmount: 0.28,
    highlightTint: [1, 0.6, 0.85],
    highlightAmount: 0.3,
    vignette: 0.3,
    grain: 0.1,
    aberration: 0.25,
    bloom: 1.6,
  },
};

export const LOOK_ORDER = Object.keys(LOOKS) as readonly string[];

/** The recipe for a look name (`clean` for an unknown or missing name). */
export function lookRecipe(name: string | undefined | null): LookRecipe {
  return LOOKS[name ?? ''] ?? LOOKS.clean!;
}

/** Whether `name` is a look a mission or the director can ask for. */
export function isLookName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOOKS, name);
}

/** The time-of-day's share of the post grade (W-5): a contrast about middle grey and a lift, applied before the look. */
export interface PostGrade {
  contrast: number;
  lift: number;
}

export const NEUTRAL_POST: PostGrade = { contrast: 1, lift: 0 };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * One colour through the grade then the look, in display space (0..1 sRGB values, the way the picture reaches the
 * screen). Order: the time-of-day post grade, the faded print, the CDL, contrast, saturation, split toning, clamp.
 */
export function gradeColor(
  look: LookRecipe,
  post: PostGrade,
  r: number,
  g: number,
  b: number,
  out: [number, number, number],
): [number, number, number] {
  // The time-of-day's contrast + lift (a neutral post leaves the colour alone).
  if (post.contrast !== 1 || post.lift !== 0) {
    r = 0.5 + (r - 0.5) * post.contrast + post.lift;
    g = 0.5 + (g - 0.5) * post.contrast + post.lift;
    b = 0.5 + (b - 0.5) * post.contrast + post.lift;
  }
  // A faded print: black lifts, white stays.
  if (look.fade > 0) {
    const f = look.fade * 0.12;
    r = f + r * (1 - f);
    g = f + g * (1 - f);
    b = f + b * (1 - f);
  }
  // ASC CDL (slope = gain, offset = lift, power = 1 / gamma).
  r = Math.pow(clamp01(r * look.gain[0] + look.lift[0]), 1 / look.gamma[0]);
  g = Math.pow(clamp01(g * look.gain[1] + look.lift[1]), 1 / look.gamma[1]);
  b = Math.pow(clamp01(b * look.gain[2] + look.lift[2]), 1 / look.gamma[2]);
  // Contrast about middle grey.
  if (look.contrast !== 1) {
    r = 0.5 + (r - 0.5) * look.contrast;
    g = 0.5 + (g - 0.5) * look.contrast;
    b = 0.5 + (b - 0.5) * look.contrast;
  }
  // Saturation about luma.
  const y = luma(r, g, b);
  if (look.saturation !== 1) {
    r = y + (r - y) * look.saturation;
    g = y + (g - y) * look.saturation;
    b = y + (b - y) * look.saturation;
  }
  // Split toning: a zero-luma chroma vector pushed into the shadows / highlights so brightness holds.
  if (look.shadowAmount > 0) {
    const t = look.shadowTint;
    const ty = luma(t[0], t[1], t[2]);
    const w = (1 - clamp01(y)) * look.shadowAmount;
    r += (t[0] - ty) * w;
    g += (t[1] - ty) * w;
    b += (t[2] - ty) * w;
  }
  if (look.highlightAmount > 0) {
    const t = look.highlightTint;
    const ty = luma(t[0], t[1], t[2]);
    const w = clamp01(y) * look.highlightAmount;
    r += (t[0] - ty) * w;
    g += (t[1] - ty) * w;
    b += (t[2] - ty) * w;
  }
  out[0] = clamp01(r);
  out[1] = clamp01(g);
  out[2] = clamp01(b);
  return out;
}

/**
 * Bake the grade + look into a cubic 3D LUT: `size³` RGBA floats, red fastest, then green, then blue (the layout
 * `postprocessing`'s `LookupTexture` expects — index `(r + g·size + b·size²) · 4`). `into` is reused when it fits.
 */
export function bakeLut(look: LookRecipe, post: PostGrade = NEUTRAL_POST, size = 32, into?: Float32Array): Float32Array {
  const n = size * size * size * 4;
  const data = into && into.length === n ? into : new Float32Array(n);
  const s = 1 / (size - 1);
  const c: [number, number, number] = [0, 0, 0];
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        gradeColor(look, post, r * s, g * s, b * s, c);
        data[i++] = c[0];
        data[i++] = c[1];
        data[i++] = c[2];
        data[i++] = 1;
      }
    }
  }
  return data;
}

/** Whether a look + post grade is the identity (the LUT pass can be skipped). */
export function isNeutralLook(look: LookRecipe, post: PostGrade = NEUTRAL_POST): boolean {
  const one = (v: [number, number, number]) => v[0] === 1 && v[1] === 1 && v[2] === 1;
  const zero = (v: [number, number, number]) => v[0] === 0 && v[1] === 0 && v[2] === 0;
  return (
    post.contrast === 1 &&
    post.lift === 0 &&
    look.contrast === 1 &&
    look.saturation === 1 &&
    zero(look.lift) &&
    one(look.gamma) &&
    one(look.gain) &&
    look.shadowAmount === 0 &&
    look.highlightAmount === 0 &&
    look.fade === 0
  );
}
