// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { StudioSession, type FrameContext } from '../../apps/web/src/studio/session';
import { GhostActor } from '../../apps/web/src/studio/ghosts';
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

  it('multi-take blocking: take 2 rolls with take 1 performing as a ghost, the set loops after the cut and resets per mission', async () => {
    const looks: string[] = [];
    const scene = new THREE.Scene();
    const s = new StudioSession(
      document.body,
      scene,
      new THREE.Group(),
      document.createElement('canvas'),
      'test-cell',
      MISSIONS_V0,
      0,
      (actorId) => {
        looks.push(actorId);
        return new GhostActor(scene, new THREE.Group(), null, { color: 0xffffff, name: actorId });
      },
    );
    s.brief();
    const bad = { cameraHeightM: 1.8, subjectInFrame: false, timePreset: 'noon' as const };
    // Take 1 as $COAST: walk 6 m in 2 s.
    expect(s.action(ctx(1000, bad))).toBe('rolled');
    expect(s.ghostsVisible).toBe(0); // nothing to replay yet
    for (let i = 1; i <= 60; i++) s.tick(ctx(1000 + (i * 1000) / 30, { ...bad, feet: new THREE.Vector3(i * 0.1, 0, 0) }));
    expect(s.action(ctx(3000, bad))).toBe('cut');
    await new Promise((r) => setTimeout(r, 0));
    expect(s.set.size).toBe(1);
    expect(s.set.layers[0]!.take.actorId).toBe('player');
    expect(looks).toEqual(['player']);
    expect(s.playing).toBe(true); // the set loops after the cut
    expect(s.ghostsVisible).toBe(1);
    // Take 2, possessing the Photographer: take 1 performs again on the take clock while this one rolls.
    s.retake();
    s.actorId = 'photographer';
    expect(s.action(ctx(10_000, bad))).toBe('rolled');
    expect(s.playing).toBe(true);
    expect(s.ghostsVisible).toBe(1);
    s.tick(ctx(11_000, bad)); // 1 s into take 2 = 1 s into the replay of take 1 → 3 m along
    expect(s.ghosts[0]!.group.position.x).toBeCloseTo(3, 1);
    s.tick(ctx(14_000, bad)); // past take 1's 2 s: the ghost holds its mark
    expect(s.ghosts[0]!.group.position.x).toBeCloseTo(6, 1);
    expect(s.action(ctx(14_500, bad))).toBe('cut');
    await new Promise((r) => setTimeout(r, 0));
    expect(s.set.layers.map((l) => l.take.actorId)).toEqual(['player', 'photographer']);
    expect(looks).toEqual(['player', 'photographer']);
    expect(s.ghostsVisible).toBe(2);
    // P toggles the looping playback of the whole set.
    s.togglePlayback(15_000);
    expect(s.ghostsVisible).toBe(0);
    s.togglePlayback(15_100);
    expect(s.ghostsVisible).toBe(2);
    // A third take fills the set; walking off after the mission is done clears it (a new shot, a fresh set).
    s.retake();
    expect(s.action(ctx(20_000, bad))).toBe('rolled');
    s.tick(ctx(20_100, bad));
    expect(s.action(ctx(20_500, bad))).toBe('cut');
    await new Promise((r) => setTimeout(r, 0));
    expect(s.set.size).toBe(3);
    expect(s.leave().id).toBe(MISSIONS_V0[1]!.id); // out of takes → next mission
    expect(s.set.size).toBe(0);
    expect(s.ghosts.length).toBe(0);
    expect(s.playing).toBe(false);
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

  it('props that moved during a take replay kinematically with the set (the replay re-throws the can)', async () => {
    const s = makeSession();
    const writes: [string, number][] = [];
    s.propWriter = (id, pose) => writes.push([id, pose.pos[0]]);
    s.brief();
    const bad = { cameraHeightM: 1.8, subjectInFrame: false, timePreset: 'noon' as const };
    expect(s.action(ctx(1000, bad))).toBe('rolled');
    for (let i = 1; i <= 60; i++) {
      const t = i / 30;
      // The can flies +x for the first second, the crate never moves (awake but still).
      s.tick(
        ctx(1000 + t * 1000, {
          ...bad,
          props: [
            { id: 'can_1', pos: [Math.min(t, 1) * 6, 1, 0], quat: [0, 0, 0, 1] },
            { id: 'crate_1', pos: [2, 0, -3], quat: [0, 0, 0, 1] },
          ],
        }),
      );
    }
    expect(s.action(ctx(3000, bad))).toBe('cut');
    await new Promise((r) => setTimeout(r, 0));
    const take = s.set.layers[0]!.take;
    expect(take.props?.map((p) => p.id)).toEqual(['can_1']);
    expect(s.set.propIds()).toEqual(['can_1']);
    // The set loops after the cut: the can is written back along its track.
    expect(writes.length).toBeGreaterThan(0); // startPlayback seeks t = 0 immediately
    s.startPlayback(3000, true); // on the test clock
    writes.length = 0;
    s.tick(ctx(3500, bad)); // 0.5 s into the loop → x ≈ 3
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe('can_1');
    expect(writes[0]![1]).toBeCloseTo(3, 0);
    s.tick(ctx(4800, bad)); // 1.8 s: held at the end of its flight
    expect(writes.at(-1)![1]).toBeCloseTo(6, 1);
  });
});
