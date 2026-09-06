// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { StudioSession, type FrameContext } from '../../apps/web/src/studio/session';
import { MISSIONS_V0 } from '../../packages/studio/src/missions';

/**
 * goal.md §3.1 steps 2–6 / MIS-3: the tutor's mission loop — brief → roll → cut → verdict → walk off → next mission.
 * No canvas capture in happy-dom (`captureStream` is absent), so the session records poses only; the judge and the
 * progression are what is under test. Beat events ride along on the frame context (a manual hop → beatSync).
 */
function makeSession(startIndex = 0) {
  const scene = new THREE.Scene();
  const canvas = document.createElement('canvas');
  return new StudioSession(document.body, scene, new THREE.Group(), canvas, 'test-cell', MISSIONS_V0, startIndex);
}

function ctx(nowMs: number, over: Partial<FrameContext> = {}): FrameContext {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
  camera.position.set(0, 0.5, 3);
  camera.lookAt(0, 0.5, 0);
  camera.updateMatrixWorld();
  return {
    nowMs,
    feet: new THREE.Vector3(),
    yaw: 0,
    speed: 0,
    grounded: true,
    camera,
    cameraHeightM: 0.5,
    subjectInFrame: true,
    timePreset: 'golden',
    cell: 'valley',
    ...over,
  };
}

/** Roll at t0, feed `seconds` of good frames at 30 Hz, cut. Returns the verdict. */
async function shoot(s: StudioSession, t0: number, seconds: number, over: Partial<FrameContext> = {}) {
  expect(s.action(ctx(t0, over))).toBe('rolled');
  const n = Math.round(seconds * 30);
  for (let i = 1; i <= n; i++) s.tick(ctx(t0 + (i * 1000) / 30, over));
  expect(s.action(ctx(t0 + seconds * 1000, over))).toBe('cut');
  await new Promise((r) => setTimeout(r, 0)); // cut() awaits the (absent) recorder
  expect(s.state).toBe('verdict');
  return s.lastVerdict!;
}

describe('StudioSession mission loop', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('briefs mission 1, judges a clean take ★★★ and hands out mission 2 when the player walks off', async () => {
    const s = makeSession();
    expect(s.state).toBe('idle');
    expect(s.action(ctx(0))).toBe('ignored'); // nothing to roll before the brief
    s.brief();
    expect(s.state).toBe('briefed');
    expect(s.subjectId).toBe('crate_1');
    const v = await shoot(s, 1000, 6);
    expect(v.stars).toBe(3);
    expect(s.takesUsed).toBe(1);
    expect(s.stars.get(MISSIONS_V0[0]!.id)).toBe(3);
    expect(s.leave().id).toBe(MISSIONS_V0[1]!.id);
    expect(s.state).toBe('idle');
    expect(s.takesUsed).toBe(0);
    s.brief();
    expect(s.mission.title).toBe('Hop on the one');
    expect(s.subjectId).toBe('lowrider');
  });

  it('keeps a ☆☆☆ mission on deck while takes remain, then moves on when they run out', async () => {
    const s = makeSession();
    s.brief();
    const bad = { cameraHeightM: 1.8, subjectInFrame: false, timePreset: 'noon' as const };
    expect((await shoot(s, 1000, 1.5, bad)).stars).toBe(0);
    expect(s.leave().id).toBe(MISSIONS_V0[0]!.id); // not earned, takes left → same mission
    expect(s.takesUsed).toBe(1);
    s.brief();
    expect(s.card.el.querySelector('.mc-state')!.textContent).toMatch(/Take 2 of 3/);
    expect((await shoot(s, 20_000, 1.5, bad)).stars).toBe(0);
    s.retake();
    expect(s.state).toBe('briefed');
    expect((await shoot(s, 40_000, 1.5, bad)).stars).toBe(0);
    expect(s.canRoll).toBe(false); // 3 of 3 used
    expect(s.leave().id).toBe(MISSIONS_V0[1]!.id); // out of takes → next mission anyway
  });

  it('mission 2 judges manual hops against the beat from the frame context', async () => {
    const s = makeSession(1);
    s.brief();
    expect(s.mission.id).toBe('m02-hop-on-the-one');
    const t0 = 5000;
    expect(s.action(ctx(t0))).toBe('rolled');
    for (let i = 1; i <= 240; i++) {
      const t = t0 + (i * 1000) / 30;
      const hop = i % 60 === 0 ? { beatEvent: 'hop' as const, beatPhaseMs: i === 120 ? 400 : 40 } : {};
      s.tick(ctx(t, { cameraHeightM: 0.8, ...hop }));
    }
    expect(s.action(ctx(t0 + 8000))).toBe('cut');
    await new Promise((r) => setTimeout(r, 0));
    const beat = s.lastVerdict!.results.find((r) => r.kind === 'beatSync')!;
    expect(beat.text).toBe('3/4');
    expect(beat.pass).toBe(true); // 75% ≥ 60%
    expect(s.lastVerdict!.stars).toBe(3);
  });
});
