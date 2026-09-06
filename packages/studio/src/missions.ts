/**
 * Missions = shots (goal.md §3.3 MIS-*, SCH-3). Constraints are machine-checkable; the shot meter and the judge run the
 * same evaluators (MIS-2). Astra grades aesthetics only and never decides pass/fail.
 *
 * Plain numbers only — no `three` in the studio package; the game converts rig state into a {@link MeterSample}.
 */

/** Time-of-day presets the meter can observe. The engine's `TimePreset` is the subset a cell can be lit with. */
export type TimePresetName = 'noon' | 'golden' | 'blue' | 'night' | 'fog_noon';

export type Constraint =
  | { kind: 'cameraHeight'; min_m?: number; max_m?: number }
  | { kind: 'cameraAngle'; pitchMin?: number; pitchMax?: number } // degrees, negative = looking down
  | { kind: 'subjectInFrame'; subject: string; minShare: number } // share of frames with the subject's bounds inside the frustum
  | { kind: 'timePreset'; is: TimePresetName }
  | { kind: 'duration_s'; target: number; tolerance: number }
  | { kind: 'beatSync'; event: 'hop' | 'jump' | 'cut'; window_ms: number }
  | { kind: 'cell'; is: string }
  | { kind: 'lens_mm'; min?: number; max?: number };

export interface Mission {
  id: string;
  title: string;
  trackId: string;
  barRange: [number, number];
  section?: string; // song section the bars belong to, for the card subtitle ("Verse 2")
  look: string; // LUT + Turbo style preset name (MIS-6)
  cell: string;
  constraints: Constraint[];
  /**
   * One actionable, numeric hint per constraint (MIS-3). `{token}`s are replaced with measured values at the cut:
   * `{value}` (what was measured), `{min}`/`{max}`/`{target}` (the constraint's numbers), `{share}`/`{off}` (percentages),
   * `{subject}`, `{event}`, `{count}`, `{delta}`. A hint without tokens gets " (measured …)" appended.
   */
  hints: Partial<Record<Constraint['kind'], string>>;
  reward: { stars: 1 | 2 | 3; unlock?: string };
  takesMax: number; // 3 (MIS-3)
  authoredBy: 'planner' | 'human';
  approvedBy?: string; // MIS-5: GRATITUD3 signs off the 12 v1 missions
}

export interface ConstraintResult {
  kind: Constraint['kind'];
  pass: boolean;
  score: number; // 0..1 (drives the shot meter fill)
  hint?: string;
  /** Measured value in the constraint's unit (m, °, share 0..1, s, mm). Live: the current reading; at the cut: what the hint cites. */
  value?: number;
  /** The measured value formatted for a chip, e.g. "0.42 m" / "72%" / "4.1 / 6 s" / "2/3". */
  text?: string;
}

export interface Verdict {
  missionId: string;
  takeId: string;
  results: ConstraintResult[];
  stars: 0 | 1 | 2 | 3;
  aesthetic?: { score: number; keyframes: string[] }; // Astra vision, 0–10, advisory only
}

/** One frame of evidence for the meter. The game pushes these at a steady cadence (every render frame is fine). */
export interface MeterSample {
  t: number /* seconds since action */;
  cameraHeightM: number /* camera above ground */;
  cameraPitchDeg: number /* negative = looking down */;
  subjectInFrame: boolean /* the mission's subject (the game resolves the id) */;
  subjectDistanceM?: number /* informational — reserved for close-up constraints */;
  timePreset: TimePresetName;
  lensMm?: number;
  cell: string;
  beatEvent?: 'hop' | 'jump' | 'cut';
  beatPhaseMs?: number /* ms to nearest beat; an event without it counts as off-beat */;
}

// ── Pass thresholds (goal.md MIS-2) ─────────────────────────────────────────────────────────────────────────────────

/** cameraHeight / cameraAngle / lens_mm pass when at least this share of samples sits inside the band. */
export const BAND_PASS_SHARE = 0.8;
/** timePreset passes when at least this share of samples was shot under the preset. */
export const PRESET_PASS_SHARE = 0.9;
/** beatSync passes when at least this share of the events landed inside the window. */
export const BEAT_PASS_SHARE = 0.6;

// ── Formatting (shared by chips and hints so both quote the same number) ────────────────────────────────────────────

const NA = 'n/a';

/** Fixed decimals with trailing zeros trimmed: 1.30 → "1.3", 0.42 → "0.42", 6 → "6". */
function num(x: number, maxDecimals: number): string {
  return String(Number(x.toFixed(maxDecimals)));
}
const fmt = {
  m: (x: number | undefined) => (x === undefined ? NA : `${num(x, 2)} m`),
  deg: (x: number | undefined) => (x === undefined ? NA : `${num(x, 0)}°`),
  s: (x: number | undefined) => (x === undefined ? NA : `${num(x, 1)} s`),
  ms: (x: number | undefined) => (x === undefined ? NA : `${num(x, 0)} ms`),
  mm: (x: number | undefined) => (x === undefined ? NA : `${num(x, 0)} mm`),
  pct: (share: number) => `${Math.round(share * 100)}%`,
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Replace `{token}`s; unknown tokens are left as-is. A template with no tokens gets the measured value appended. */
function fillHint(template: string, tokens: Record<string, string>): string {
  if (!/\{\w+\}/.test(template)) return tokens.value === undefined ? template : `${template} (measured ${tokens.value})`;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => tokens[k] ?? m);
}

// ── Evaluators: one per constraint, incremental (O(1) per push, O(1) per read) ──────────────────────────────────────

interface Evaluator {
  push(s: MeterSample): void;
  reset(): void;
  /** Live reading while framing/recording. */
  live(elapsedS: number): ConstraintResult;
  /** Final reading at the cut: same pass/score rules, `value`/`text` = what the hint cites, plus the hint on failure. */
  finish(elapsedS: number, template: string | undefined): ConstraintResult;
}

/**
 * Band constraints (cameraHeight, cameraAngle, lens_mm): score = share of samples inside [min, max]; pass ≥ 0.8.
 * Live value = the latest reading. At the cut, value = mean of the samples on the dominant offending side (so a
 * "too high" hint quotes a height that is actually above the limit), or the mean of all samples when it passed.
 */
class BandEvaluator implements Evaluator {
  private n = 0;
  private inBand = 0;
  private sumAll = 0;
  private above = 0;
  private sumAbove = 0;
  private below = 0;
  private sumBelow = 0;
  private last: number | undefined;

  constructor(
    readonly kind: 'cameraHeight' | 'cameraAngle' | 'lens_mm',
    private readonly min: number | undefined,
    private readonly max: number | undefined,
    private readonly read: (s: MeterSample) => number | undefined,
    private readonly unit: (x: number | undefined) => string,
    private readonly fallback: { high: string; low: string }, // default hint templates when the mission has none
  ) {}

  push(s: MeterSample) {
    const v = this.read(s);
    if (v === undefined || Number.isNaN(v)) return; // unreadable (e.g. no lens reported) — not evidence either way
    this.n++;
    this.sumAll += v;
    this.last = v;
    if (this.max !== undefined && v > this.max) {
      this.above++;
      this.sumAbove += v;
    } else if (this.min !== undefined && v < this.min) {
      this.below++;
      this.sumBelow += v;
    } else this.inBand++;
  }
  reset() {
    this.n = this.inBand = this.sumAll = this.above = this.sumAbove = this.below = this.sumBelow = 0;
    this.last = undefined;
  }
  private share() {
    return this.n ? this.inBand / this.n : 0;
  }
  live(): ConstraintResult {
    const share = this.share();
    return { kind: this.kind, pass: share >= BAND_PASS_SHARE, score: share, value: this.last, text: this.unit(this.last) };
  }
  finish(_elapsedS: number, template: string | undefined): ConstraintResult {
    const share = this.share();
    const pass = share >= BAND_PASS_SHARE;
    const side = this.above >= this.below ? 'high' : 'low';
    const offenders = side === 'high' ? this.above : this.below;
    const value =
      this.n === 0
        ? undefined
        : pass || offenders === 0
          ? this.sumAll / this.n
          : side === 'high'
            ? this.sumAbove / this.above
            : this.sumBelow / this.below;
    const r: ConstraintResult = { kind: this.kind, pass, score: share, value, text: this.unit(value) };
    if (!pass) {
      const tokens = { value: this.unit(value), share: fmt.pct(share), min: this.unit(this.min), max: this.unit(this.max) };
      const fallback =
        side === 'high' && this.max !== undefined ? this.fallback.high : this.min !== undefined ? this.fallback.low : this.fallback.high;
      r.hint = fillHint(template ?? fallback, tokens);
    }
    return r;
  }
}

/** subjectInFrame: share of samples with the subject in frame; pass ≥ minShare; score = share / minShare clamped. */
class SubjectEvaluator implements Evaluator {
  private n = 0;
  private inFrame = 0;
  constructor(
    private readonly subject: string,
    private readonly minShare: number,
  ) {}
  push(s: MeterSample) {
    this.n++;
    if (s.subjectInFrame) this.inFrame++;
  }
  reset() {
    this.n = this.inFrame = 0;
  }
  private result(): ConstraintResult {
    const share = this.n ? this.inFrame / this.n : 0;
    const score = this.minShare > 0 ? clamp01(share / this.minShare) : 1;
    return { kind: 'subjectInFrame', pass: share >= this.minShare, score, value: share, text: fmt.pct(share) };
  }
  live() {
    return this.result();
  }
  finish(_elapsedS: number, template: string | undefined) {
    const r = this.result();
    if (!r.pass)
      r.hint = fillHint(template ?? 'keep {subject} in frame — {value}, needs {min}', {
        value: fmt.pct(r.value ?? 0),
        share: fmt.pct(r.value ?? 0),
        min: fmt.pct(this.minShare),
        subject: this.subject,
      });
    return r;
  }
}

/** timePreset: share of samples shot under the preset; pass ≥ 0.9. `{value}` = the dominant wrong preset. */
class PresetEvaluator implements Evaluator {
  private n = 0;
  private match = 0;
  private counts = new Map<TimePresetName, number>();
  private last: TimePresetName | undefined;
  constructor(private readonly is: TimePresetName) {}
  push(s: MeterSample) {
    this.n++;
    this.last = s.timePreset;
    if (s.timePreset === this.is) this.match++;
    else this.counts.set(s.timePreset, (this.counts.get(s.timePreset) ?? 0) + 1);
  }
  reset() {
    this.n = this.match = 0;
    this.counts.clear();
    this.last = undefined;
  }
  private dominantOff(): TimePresetName | undefined {
    let best: TimePresetName | undefined;
    let bestN = 0;
    for (const [k, v] of this.counts) {
      if (v > bestN) {
        best = k;
        bestN = v;
      }
    }
    return best;
  }
  live(): ConstraintResult {
    const share = this.n ? this.match / this.n : 0;
    return { kind: 'timePreset', pass: share >= PRESET_PASS_SHARE, score: share, value: share, text: this.last ?? NA };
  }
  finish(_elapsedS: number, template: string | undefined): ConstraintResult {
    const share = this.n ? this.match / this.n : 0;
    const pass = share >= PRESET_PASS_SHARE;
    const off = this.dominantOff();
    const r: ConstraintResult = { kind: 'timePreset', pass, score: share, value: share, text: pass ? this.is : (off ?? NA) };
    if (!pass)
      r.hint = fillHint(template ?? 'switch the light to {target} — {off} of this take was {value}', {
        value: off ?? NA,
        target: this.is,
        share: fmt.pct(share),
        off: fmt.pct(1 - share),
      });
    return r;
  }
}

/**
 * duration_s: pass when |elapsed − target| ≤ tolerance·target. At the cut score = 1 − clamp(|Δ| / (tolerance·target));
 * while recording the score is progress toward the target, min(elapsed / target, 1), and `pass` means "cut now is fine".
 */
class DurationEvaluator implements Evaluator {
  constructor(
    private readonly target: number,
    private readonly tolerance: number,
  ) {}
  push() {}
  reset() {}
  private band() {
    return Math.abs(this.tolerance * this.target);
  }
  private text(elapsedS: number) {
    return `${num(elapsedS, 1)} / ${num(this.target, 1)} s`;
  }
  live(elapsedS: number): ConstraintResult {
    const progress = this.target > 0 ? clamp01(elapsedS / this.target) : 1;
    const pass = Math.abs(elapsedS - this.target) <= this.band();
    return { kind: 'duration_s', pass, score: progress, value: elapsedS, text: this.text(elapsedS) };
  }
  finish(elapsedS: number, template: string | undefined): ConstraintResult {
    const delta = elapsedS - this.target;
    const band = this.band();
    const miss = band > 0 ? clamp01(Math.abs(delta) / band) : delta === 0 ? 0 : 1;
    const pass = Math.abs(delta) <= band;
    const r: ConstraintResult = { kind: 'duration_s', pass, score: 1 - miss, value: elapsedS, text: this.text(elapsedS) };
    if (!pass)
      r.hint = fillHint(template ?? (delta < 0 ? 'too short — {value}, aim for {target}' : 'too long — {value}, aim for {target}'), {
        value: fmt.s(elapsedS),
        target: fmt.s(this.target),
        min: fmt.s(this.target - band),
        max: fmt.s(this.target + band),
        delta: `${delta > 0 ? '+' : ''}${num(delta, 1)} s`,
      });
    return r;
  }
}

/**
 * beatSync: share of the constraint's events with |beatPhaseMs| ≤ window_ms; pass ≥ 0.6. No events → score 0 and the
 * hint "hit the <event> on the beat". `{value}` = mean |phase| of the missed events.
 */
class BeatEvaluator implements Evaluator {
  private events = 0;
  private hits = 0;
  private missed = 0; // misses with a measured phase
  private sumMiss = 0;
  constructor(
    private readonly event: 'hop' | 'jump' | 'cut',
    private readonly windowMs: number,
  ) {}
  push(s: MeterSample) {
    if (s.beatEvent !== this.event) return;
    this.events++;
    const phase = s.beatPhaseMs === undefined ? Infinity : Math.abs(s.beatPhaseMs);
    if (phase <= this.windowMs) this.hits++;
    else if (Number.isFinite(phase)) {
      this.missed++;
      this.sumMiss += phase;
    }
  }
  reset() {
    this.events = this.hits = this.missed = this.sumMiss = 0;
  }
  private result(): ConstraintResult {
    const share = this.events ? this.hits / this.events : 0;
    return {
      kind: 'beatSync',
      pass: this.events > 0 && share >= BEAT_PASS_SHARE,
      score: share,
      value: share,
      text: `${this.hits}/${this.events}`,
    };
  }
  live() {
    return this.result();
  }
  finish(_elapsedS: number, template: string | undefined) {
    const r = this.result();
    if (r.pass) return r;
    if (this.events === 0) r.hint = `hit the ${this.event} on the beat`;
    else {
      r.hint = fillHint(template ?? '{event} off the beat — {value} off, land within {max}', {
        value: fmt.ms(this.missed ? this.sumMiss / this.missed : undefined),
        share: fmt.pct(r.value ?? 0),
        max: fmt.ms(this.windowMs),
        count: String(this.events),
        hits: String(this.hits),
        event: this.event,
      });
    }
    return r;
  }
}

/** cell: 1 when every sample was taken in the cell (and there was at least one), else 0. `{value}` = the dominant other cell. */
class CellEvaluator implements Evaluator {
  private n = 0;
  private inCell = 0;
  private off = new Map<string, number>();
  private last: string | undefined;
  constructor(private readonly is: string) {}
  push(s: MeterSample) {
    this.n++;
    this.last = s.cell;
    if (s.cell === this.is) this.inCell++;
    else this.off.set(s.cell, (this.off.get(s.cell) ?? 0) + 1);
  }
  reset() {
    this.n = this.inCell = 0;
    this.off.clear();
    this.last = undefined;
  }
  private result(): ConstraintResult {
    const pass = this.n > 0 && this.inCell === this.n;
    return { kind: 'cell', pass, score: pass ? 1 : 0, value: this.n ? this.inCell / this.n : 0, text: this.last ?? NA };
  }
  live() {
    return this.result();
  }
  finish(_elapsedS: number, template: string | undefined) {
    const r = this.result();
    if (r.pass) return r;
    let value = NA;
    let bestN = 0;
    for (const [k, v] of this.off) {
      if (v > bestN) {
        value = k;
        bestN = v;
      }
    }
    r.text = value;
    r.hint = fillHint(template ?? 'shoot in {target} — this take was in {value}', { value, target: this.is, share: fmt.pct(r.value ?? 0) });
    return r;
  }
}

function evaluatorFor(c: Constraint): Evaluator {
  switch (c.kind) {
    case 'cameraHeight':
      return new BandEvaluator('cameraHeight', c.min_m, c.max_m, (s) => s.cameraHeightM, fmt.m, {
        high: 'camera too high — {value}, keep it under {max}',
        low: 'camera too low — {value}, keep it above {min}',
      });
    case 'cameraAngle':
      return new BandEvaluator('cameraAngle', c.pitchMin, c.pitchMax, (s) => s.cameraPitchDeg, fmt.deg, {
        high: 'camera tilted up — pitch {value}, keep it under {max}',
        low: 'camera tilted down — pitch {value}, keep it above {min}',
      });
    case 'lens_mm':
      return new BandEvaluator('lens_mm', c.min, c.max, (s) => s.lensMm, fmt.mm, {
        high: 'lens too long — {value}, use {max} or wider',
        low: 'lens too wide — {value}, use {min} or longer',
      });
    case 'subjectInFrame':
      return new SubjectEvaluator(c.subject, c.minShare);
    case 'timePreset':
      return new PresetEvaluator(c.is);
    case 'duration_s':
      return new DurationEvaluator(c.target, c.tolerance);
    case 'beatSync':
      return new BeatEvaluator(c.event, c.window_ms);
    case 'cell':
      return new CellEvaluator(c.is);
  }
}

/**
 * The shot meter (MIS-2) and the judge (MIS-3) — one object, two reads. Feed it a {@link MeterSample} per frame; `live()`
 * scores the samples so far for the chips, `finish()` is the verdict at the cut. Results are in `mission.constraints`
 * order. Everything is incremental: `push` and `live` cost O(constraints), never O(samples).
 *
 * Before "action" the chips should score the *current frame* (MIS-2): call `reset()` + `push(frame)` + `live(0)` each
 * frame while framing, then `reset()` once at "action" and keep pushing until "cut".
 */
export class ShotMeter {
  private readonly evaluators: Evaluator[];
  private samples = 0;
  private finished = 0;

  constructor(readonly mission: Mission) {
    this.evaluators = mission.constraints.map(evaluatorFor);
  }

  /** Samples pushed since the last reset. */
  get sampleCount() {
    return this.samples;
  }

  push(s: MeterSample): void {
    this.samples++;
    for (const e of this.evaluators) e.push(s);
  }

  /** Forget every sample (a new take, or the per-frame preview before "action"). */
  reset(): void {
    this.samples = 0;
    for (const e of this.evaluators) e.reset();
  }

  /** Live per-constraint scores 0..1 (drives the chips) computed over the samples so far — cheap (incremental accumulators, not re-scanning). */
  live(elapsedS: number): ConstraintResult[] {
    return this.evaluators.map((e) => e.live(elapsedS));
  }

  /**
   * Final verdict at cut: pass/fail per constraint, ★ 0–3, one actionable numeric hint per failed constraint (MIS-3), from
   * mission.hints with the measured value substituted, e.g. "camera too high — 1.3 m, keep it under 0.6 m".
   * @param takeId The Take this verdict grades; defaults to `<missionId>-take-<n>` counting finishes on this meter.
   */
  finish(elapsedS: number, takeId?: string): Verdict {
    this.finished++;
    const { mission } = this;
    const results = this.evaluators.map((e, i) => e.finish(elapsedS, mission.hints[mission.constraints[i]!.kind]));
    return { missionId: mission.id, takeId: takeId ?? `${mission.id}-take-${this.finished}`, results, stars: starsFor(results) };
  }
}

/** ★ 3 = every constraint passed; 2 = all but one; 1 = at least half; 0 otherwise. No constraints counts as all passed. */
export function starsFor(results: ConstraintResult[]): 0 | 1 | 2 | 3 {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  if (failed === 0) return 3;
  if (failed === 1 && passed > 0) return 2;
  return passed * 2 >= results.length ? 1 : 0;
}

/** Mission 1 of the golden path (goal.md §3.1 step 2): the tutor's brief on the dev cell. */
export const MISSION_LOW_AND_SLOW: Mission = {
  id: 'm01-low-and-slow',
  title: 'Low & slow',
  trackId: 'coast-01',
  barRange: [9, 16],
  section: 'Verse 2',
  look: '35mm-dusk',
  cell: 'valley',
  constraints: [
    { kind: 'cameraHeight', max_m: 0.9 },
    { kind: 'subjectInFrame', subject: 'crate_1', minShare: 0.7 },
    { kind: 'timePreset', is: 'golden' },
    { kind: 'duration_s', target: 6, tolerance: 0.25 },
  ],
  hints: {
    cameraHeight: 'camera too high — {value}, keep it under {max}',
    subjectInFrame: 'keep the crate in frame — {value}, needs {min}',
    timePreset: 'shoot at golden hour — {off} of this take was {value}',
    duration_s: 'aim for a {target} take — this one ran {value}',
  },
  reward: { stars: 3, unlock: 'lens-24mm' },
  takesMax: 3,
  authoredBy: 'human',
};

/**
 * Mission 2 (goal.md §3.1 step 3, PHY-3): hit the hydraulic switch on the beat with the lowrider in frame. Only *manual*
 * hops count as `beatEvent: 'hop'` — the beat-driven auto-hop (H) is the car dancing by itself, not the player's timing.
 */
export const MISSION_HOP_ON_THE_ONE: Mission = {
  id: 'm02-hop-on-the-one',
  title: 'Hop on the one',
  trackId: 'coast-demo',
  barRange: [17, 20],
  section: 'Hook',
  look: '35mm-dusk',
  cell: 'valley',
  constraints: [
    { kind: 'subjectInFrame', subject: 'lowrider', minShare: 0.7 },
    { kind: 'beatSync', event: 'hop', window_ms: 150 },
    { kind: 'cameraHeight', max_m: 1.2 },
    { kind: 'duration_s', target: 8, tolerance: 0.25 },
  ],
  hints: {
    subjectInFrame: 'keep the lowrider in frame — {value}, needs {min}',
    beatSync: 'hop off the beat — {value} off on average, land within {max} ({hits}/{count} hit)',
    cameraHeight: 'camera too high — {value}, keep it under {max}',
    duration_s: 'aim for an {target} take — this one ran {value}',
  },
  reward: { stars: 3, unlock: 'hydraulics-three-wheel' },
  takesMax: 3,
  authoredBy: 'human',
};

/** The tutor's mission order on the dev cell (M3.5 → M4 slice). */
export const MISSIONS_V0: Mission[] = [MISSION_LOW_AND_SLOW, MISSION_HOP_ON_THE_ONE];
