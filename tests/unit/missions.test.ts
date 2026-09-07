import { describe, it, expect } from 'vitest';
import {
  ShotMeter,
  starsFor,
  MISSION_LOW_AND_SLOW,
  BAND_PASS_SHARE,
  PRESET_PASS_SHARE,
  BEAT_PASS_SHARE,
  type Constraint,
  type ConstraintResult,
  type MeterSample,
  type Mission,
} from '../../packages/studio/src/missions';

/**
 * goal.md §3.3 MIS-1…MIS-3 / SCH-3: the shot meter and the judge are the same evaluators. Every evaluator is pinned on
 * pass/fail/score, the hint text is checked with the measured value substituted, and `live()` (running counters) is
 * compared against an independent brute-force recomputation over the same samples.
 */

/** A well-framed frame on the golden-path mission: low, level, subject in frame, golden hour, in the valley. */
function sample(over: Partial<MeterSample> = {}): MeterSample {
  return { t: 0, cameraHeightM: 0.5, cameraPitchDeg: -4, subjectInFrame: true, timePreset: 'golden', lensMm: 35, cell: 'valley', ...over };
}

/** A single-constraint mission so each evaluator can be exercised in isolation. */
function missionWith(constraints: Constraint[], hints: Mission['hints'] = {}): Mission {
  return { ...MISSION_LOW_AND_SLOW, id: 'test', constraints, hints };
}

function run(m: Mission, samples: MeterSample[], elapsedS = 6): ConstraintResult {
  const meter = new ShotMeter(m);
  for (const s of samples) meter.push(s);
  const [r] = meter.finish(elapsedS).results;
  return r!;
}

/** n samples with the given overrides. */
const times = (n: number, over: Partial<MeterSample> = {}) => Array.from({ length: n }, (_, i) => sample({ t: i / 30, ...over }));

describe('cameraHeight', () => {
  it('passes when ≥ 80% of samples sit under max_m, score = share', () => {
    const r = run(missionWith([{ kind: 'cameraHeight', max_m: 0.9 }]), [
      ...times(9, { cameraHeightM: 0.4 }),
      ...times(1, { cameraHeightM: 1.2 }),
    ]);
    expect(r.pass).toBe(true);
    expect(r.score).toBeCloseTo(0.9);
    expect(r.hint).toBeUndefined();
    expect(r.text).toBe('0.48 m'); // mean of all samples when it passed
  });

  it('fails under 80% and the hint quotes the mean of the offending samples, not the overall mean', () => {
    // Overall mean would be 0.85 m (< 0.9 m) — a hint quoting that would contradict itself.
    const r = run(missionWith([{ kind: 'cameraHeight', max_m: 0.9 }], MISSION_LOW_AND_SLOW.hints), [
      ...times(5, { cameraHeightM: 0.4 }),
      ...times(5, { cameraHeightM: 1.3 }),
    ]);
    expect(r.pass).toBe(false);
    expect(r.score).toBeCloseTo(0.5);
    expect(r.value).toBeCloseTo(1.3);
    expect(r.hint).toBe('camera too high — 1.3 m, keep it under 0.9 m');
  });

  it('uses a "too low" default hint for a min_m band when the mission has no hint', () => {
    const r = run(missionWith([{ kind: 'cameraHeight', min_m: 1.5, max_m: 2 }]), times(4, { cameraHeightM: 0.6 }));
    expect(r.pass).toBe(false);
    expect(r.hint).toBe('camera too low — 0.6 m, keep it above 1.5 m');
  });

  it('exports the pass thresholds the rules cite', () => {
    expect(BAND_PASS_SHARE).toBe(0.8);
    expect(PRESET_PASS_SHARE).toBe(0.9);
    expect(BEAT_PASS_SHARE).toBe(0.6);
  });
});

describe('cameraAngle', () => {
  it('pitchMax 5: looking down or level passes, tilted up beyond 5° fails with degrees substituted', () => {
    const c: Constraint = { kind: 'cameraAngle', pitchMax: 5 };
    expect(run(missionWith([c]), times(6, { cameraPitchDeg: -12 })).pass).toBe(true);
    expect(run(missionWith([c]), times(6, { cameraPitchDeg: 5 })).pass).toBe(true);
    const up = run(
      missionWith([c], { cameraAngle: 'keep the camera level or looking down — pitch {value}, max {max}' }),
      times(6, { cameraPitchDeg: 12.4 }),
    );
    expect(up.pass).toBe(false);
    expect(up.score).toBe(0);
    expect(up.hint).toBe('keep the camera level or looking down — pitch 12°, max 5°');
  });

  it('pitchMin: looking further down than allowed fails with the default "tilted down" hint', () => {
    const r = run(missionWith([{ kind: 'cameraAngle', pitchMin: -10, pitchMax: 10 }]), times(3, { cameraPitchDeg: -30 }));
    expect(r.hint).toBe('camera tilted down — pitch -30°, keep it above -10°');
  });
});

describe('subjectInFrame', () => {
  it('score = share / minShare clamped; pass when share ≥ minShare', () => {
    const c: Constraint = { kind: 'subjectInFrame', subject: 'crate_1', minShare: 0.7 };
    const half = run(missionWith([c], MISSION_LOW_AND_SLOW.hints), [
      ...times(5, { subjectInFrame: true }),
      ...times(5, { subjectInFrame: false }),
    ]);
    expect(half.pass).toBe(false);
    expect(half.score).toBeCloseTo(0.5 / 0.7);
    expect(half.text).toBe('50%');
    expect(half.hint).toBe('keep the crate in frame — 50%, needs 70%');

    const most = run(missionWith([c]), [...times(8, { subjectInFrame: true }), ...times(2, { subjectInFrame: false })]);
    expect(most.pass).toBe(true);
    expect(most.score).toBe(1); // 0.8 / 0.7 clamps to 1
  });

  it('default hint names the subject', () => {
    const r = run(missionWith([{ kind: 'subjectInFrame', subject: 'lowrider', minShare: 0.8 }]), times(4, { subjectInFrame: false }));
    expect(r.hint).toBe('keep lowrider in frame — 0%, needs 80%');
  });
});

describe('timePreset', () => {
  it('needs ≥ 90% of samples under the preset; the hint names the dominant wrong preset', () => {
    const c: Constraint = { kind: 'timePreset', is: 'golden' };
    expect(run(missionWith([c]), times(10, { timePreset: 'golden' })).pass).toBe(true);
    const r = run(missionWith([c], MISSION_LOW_AND_SLOW.hints), [
      ...times(17, { timePreset: 'golden' }),
      ...times(3, { timePreset: 'blue' }),
    ]);
    expect(r.pass).toBe(false);
    expect(r.score).toBeCloseTo(0.85);
    expect(r.text).toBe('blue');
    expect(r.hint).toBe('shoot at golden hour — 15% of this take was blue');
  });

  it('live text is the current preset (what the player is looking at)', () => {
    const meter = new ShotMeter(missionWith([{ kind: 'timePreset', is: 'golden' }]));
    meter.push(sample({ timePreset: 'noon' }));
    expect(meter.live(0)[0]!.text).toBe('noon');
  });
});

describe('duration_s', () => {
  const m = missionWith([{ kind: 'duration_s', target: 6, tolerance: 0.25 }], MISSION_LOW_AND_SLOW.hints);

  it('passes within ±tolerance·target and scores the distance to the target', () => {
    expect(run(m, [], 6)).toMatchObject({ pass: true, score: 1, text: '6 / 6 s' });
    const near = run(m, [], 5);
    expect(near.pass).toBe(true);
    expect(near.score).toBeCloseTo(1 - 1 / 1.5);
    const short = run(m, [], 4.1);
    expect(short.pass).toBe(false);
    expect(short.score).toBe(0); // 1.9 s off > the 1.5 s band → clamped to 0
    expect(short.hint).toBe('aim for a 6 s take — this one ran 4.1 s');
    expect(run(m, [], 8).hint).toBe('aim for a 6 s take — this one ran 8 s');
  });

  it('default hints say short vs long', () => {
    const bare = missionWith([{ kind: 'duration_s', target: 8, tolerance: 0.1 }]);
    expect(run(bare, [], 5).hint).toBe('too short — 5 s, aim for 8 s');
    expect(run(bare, [], 10).hint).toBe('too long — 10 s, aim for 8 s');
  });

  it('live() shows progress toward the target while recording, and "pass" means cutting now is fine', () => {
    const meter = new ShotMeter(m);
    expect(meter.live(3)[0]).toMatchObject({ pass: false, score: 0.5, text: '3 / 6 s' });
    expect(meter.live(4.6)[0]!.pass).toBe(true); // inside the 4.5–7.5 s window
    expect(meter.live(6)[0]).toMatchObject({ pass: true, score: 1 });
    expect(meter.live(9)[0]).toMatchObject({ pass: false, score: 1 }); // progress clamps, but you overshot
  });
});

describe('beatSync', () => {
  const c: Constraint = { kind: 'beatSync', event: 'hop', window_ms: 120 };

  it('no events → score 0 and "hit the hop on the beat"', () => {
    const r = run(missionWith([c], { beatSync: 'ignored when there were no events {value}' }), times(10));
    expect(r).toMatchObject({ pass: false, score: 0, text: '0/0', hint: 'hit the hop on the beat' });
  });

  it("share of events inside the window; pass ≥ 60%; only the constraint's event counts", () => {
    const hits = [
      sample({ beatEvent: 'hop', beatPhaseMs: 40 }),
      sample({ beatEvent: 'hop', beatPhaseMs: -100 }),
      sample({ beatEvent: 'hop', beatPhaseMs: 300 }),
      sample({ beatEvent: 'jump', beatPhaseMs: 900 }), // a different event, ignored
    ];
    const r = run(missionWith([c]), hits);
    expect(r.pass).toBe(true);
    expect(r.score).toBeCloseTo(2 / 3);
    expect(r.text).toBe('2/3');
  });

  it('misses quote the mean phase error; an event without a phase counts as off-beat', () => {
    const r = run(missionWith([c]), [
      sample({ beatEvent: 'hop', beatPhaseMs: 20 }),
      sample({ beatEvent: 'hop', beatPhaseMs: 200 }),
      sample({ beatEvent: 'hop', beatPhaseMs: -160 }),
      sample({ beatEvent: 'hop' }),
    ]);
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0.25);
    expect(r.hint).toBe('hop off the beat — 180 ms off, land within 120 ms');
  });
});

describe('cell & lens', () => {
  it('cell: 1 only when every sample is in the cell', () => {
    const c: Constraint = { kind: 'cell', is: 'pier' };
    expect(run(missionWith([c]), times(5, { cell: 'pier' }))).toMatchObject({ pass: true, score: 1 });
    const r = run(missionWith([c]), [...times(9, { cell: 'pier' }), sample({ cell: 'garage' })]);
    expect(r).toMatchObject({ pass: false, score: 0, hint: 'shoot in pier — this take was in garage' });
    expect(run(missionWith([c]), []).pass).toBe(false);
  });

  it('lens_mm: share in range; samples that report no lens are not evidence', () => {
    const c: Constraint = { kind: 'lens_mm', min: 24, max: 35 };
    const r = run(missionWith([c]), [...times(4, { lensMm: 35 }), ...times(1, { lensMm: 85 }), ...times(20, { lensMm: undefined })]);
    expect(r.pass).toBe(true);
    expect(r.score).toBeCloseTo(0.8);
    const long = run(missionWith([c]), times(3, { lensMm: 85 }));
    expect(long.hint).toBe('lens too long — 85 mm, use 35 mm or wider');
  });
});

describe('hints', () => {
  it('a mission hint without tokens gets the measured value appended; unknown tokens are left alone', () => {
    const plain = run(
      missionWith([{ kind: 'cameraHeight', max_m: 0.6 }], { cameraHeight: 'camera too high — under 0.6 m' }),
      times(3, { cameraHeightM: 1.3 }),
    );
    expect(plain.hint).toBe('camera too high — under 0.6 m (measured 1.3 m)');
    const odd = run(
      missionWith([{ kind: 'cameraHeight', max_m: 0.6 }], { cameraHeight: '{value} vs {nope}' }),
      times(3, { cameraHeightM: 1.3 }),
    );
    expect(odd.hint).toBe('1.3 m vs {nope}');
  });

  it('every failed constraint gets exactly one hint, passing ones none (MIS-3)', () => {
    const meter = new ShotMeter(MISSION_LOW_AND_SLOW);
    for (const s of times(30, { cameraHeightM: 1.4, timePreset: 'noon' })) meter.push(s);
    const v = meter.finish(6);
    for (const r of v.results) expect(typeof r.hint === 'string').toBe(!r.pass);
    expect(v.results.filter((r) => r.hint).map((r) => r.kind)).toEqual(['cameraHeight', 'timePreset']);
  });
});

describe('starsFor', () => {
  const res = (passes: boolean[]): ConstraintResult[] => passes.map((pass) => ({ kind: 'cell', pass, score: pass ? 1 : 0 }));
  it('3 = all pass, 2 = all but one, 1 = at least half, 0 otherwise', () => {
    expect(starsFor(res([true, true, true, true, true]))).toBe(3);
    expect(starsFor(res([true, true, true, true, false]))).toBe(2);
    expect(starsFor(res([true, true, true, false, false]))).toBe(1);
    expect(starsFor(res([true, true, false, false, false]))).toBe(0);
    expect(starsFor(res([true, false]))).toBe(2);
    expect(starsFor(res([false]))).toBe(0);
    expect(starsFor(res([]))).toBe(3);
  });
});

describe('ShotMeter', () => {
  it('results follow mission.constraints order and the verdict carries mission/take ids', () => {
    const meter = new ShotMeter(MISSION_LOW_AND_SLOW);
    meter.push(sample());
    expect(meter.live(1).map((r) => r.kind)).toEqual(MISSION_LOW_AND_SLOW.constraints.map((c) => c.kind));
    const v = meter.finish(6);
    expect(v.missionId).toBe('m01-low-and-slow');
    expect(v.takeId).toBe('m01-low-and-slow-take-1');
    expect(meter.finish(6, 'take-abc').takeId).toBe('take-abc');
    expect(meter.finish(6).takeId).toBe('m01-low-and-slow-take-3');
  });

  it('live() from running counters matches a brute-force recomputation, and finish() agrees with live()', () => {
    // Deterministic LCG so the run is reproducible.
    let seed = 7;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const presets = ['golden', 'blue', 'noon'] as const;
    const samples: MeterSample[] = Array.from({ length: 400 }, (_, i) =>
      sample({
        t: i / 60,
        cameraHeightM: rnd() * 1.6,
        cameraPitchDeg: rnd() * 30 - 20,
        subjectInFrame: rnd() < 0.75,
        timePreset: presets[Math.floor(rnd() * 3)]!,
      }),
    );
    const meter = new ShotMeter(MISSION_LOW_AND_SLOW);
    const share = (xs: MeterSample[], f: (s: MeterSample) => boolean) => xs.filter(f).length / xs.length;
    for (let i = 0; i < samples.length; i++) {
      meter.push(samples[i]!);
      if (i % 37 !== 0) continue;
      const seen = samples.slice(0, i + 1);
      const [height, subject, light] = meter.live(i / 60);
      expect(height!.score).toBeCloseTo(
        share(seen, (s) => s.cameraHeightM <= 0.9),
        12,
      );
      expect(subject!.score).toBeCloseTo(Math.min(1, share(seen, (s) => s.subjectInFrame) / 0.7), 12);
      expect(light!.score).toBeCloseTo(
        share(seen, (s) => s.timePreset === 'golden'),
        12,
      );
    }
    const live = meter.live(6);
    const v = meter.finish(6);
    expect(v.results.map((r) => [r.kind, r.pass, r.score])).toEqual(live.map((r) => [r.kind, r.pass, r.score]));
    expect(v.stars).toBe(starsFor(v.results));
    expect(meter.sampleCount).toBe(400);
  });

  it('reset() forgets the samples (per-frame preview before "action")', () => {
    const meter = new ShotMeter(MISSION_LOW_AND_SLOW);
    for (const s of times(20, { cameraHeightM: 1.5 })) meter.push(s);
    expect(meter.live(0)[0]!.score).toBe(0);
    meter.reset();
    expect(meter.sampleCount).toBe(0);
    meter.push(sample({ cameraHeightM: 0.42 }));
    expect(meter.live(0)[0]).toMatchObject({ pass: true, score: 1, text: '0.42 m' });
  });

  it('golden path: a good take that is only too high scores ★★☆ with one hint (goal.md §3.1 step 5)', () => {
    const meter = new ShotMeter(MISSION_LOW_AND_SLOW);
    for (const s of times(180, { cameraHeightM: 1.3 })) meter.push(s);
    const v = meter.finish(6.2);
    expect(v.stars).toBe(2);
    const hints = v.results.filter((r) => r.hint).map((r) => r.hint);
    expect(hints).toEqual(['camera too high — 1.3 m, keep it under 0.9 m']);
  });
});

describe('MISSION_LOW_AND_SLOW', () => {
  it('matches the SCH-3 shape and has a hint for every constraint', () => {
    expect(MISSION_LOW_AND_SLOW).toMatchObject({
      id: 'm01-low-and-slow',
      title: 'Low & slow',
      trackId: 'coast-01',
      barRange: [9, 16],
      look: '35mm-dusk',
      cell: 'valley',
      takesMax: 3,
      authoredBy: 'human',
      reward: { stars: 3, unlock: 'lens-35mm' },
    });
    // No cameraAngle constraint: a ≤0.9 m camera aimed at a standing character necessarily looks UP (a low-angle shot).
    expect(MISSION_LOW_AND_SLOW.constraints.map((c) => c.kind)).toEqual(['cameraHeight', 'subjectInFrame', 'timePreset', 'duration_s']);
    for (const c of MISSION_LOW_AND_SLOW.constraints) expect(MISSION_LOW_AND_SLOW.hints[c.kind]).toBeTypeOf('string');
    expect(JSON.parse(JSON.stringify(MISSION_LOW_AND_SLOW))).toEqual(MISSION_LOW_AND_SLOW); // plain data, no functions/classes
  });
});
