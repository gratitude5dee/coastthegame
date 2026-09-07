// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { takeStore, type TakeAvatar, type TakeV1 } from '@coast/studio';
import * as THREE from 'three';
import { StudioSession, type FrameContext } from '../../apps/web/src/studio/session';
import { GhostActor } from '../../apps/web/src/studio/ghosts';
import { MISSIONS_V0 } from '../../packages/studio/src/missions';
import { cameraFrame, cameraJson } from '../../packages/studio/src/control';
import { exportControl as renderControl } from '../../apps/web/src/studio/control';
import { exportCut as renderCut } from '../../apps/web/src/studio/exporter';
import { buildControlPackage } from '../../apps/web/src/studio/controlPackage';

vi.mock('../../apps/web/src/studio/control', () => ({ exportControl: vi.fn() }));
vi.mock('../../apps/web/src/studio/exporter', () => ({ exportCut: vi.fn() }));
vi.mock('../../apps/web/src/studio/controlPackage', () => ({ buildControlPackage: vi.fn() }));

vi.mock('@coast/engine', () => import('../../packages/engine/src/camera/path'));

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

  it('uses the avatar and outfit captured at roll for set and saved reel ghosts after an avatar switch', async () => {
    const scene = new THREE.Scene();
    const factory = vi.fn(
      (actorId: string, avatar?: TakeAvatar) =>
        new GhostActor(scene, new THREE.Group(), null, { name: avatar?.name ?? actorId, color: avatar?.color ?? 0xffffff }),
    );
    const s = new StudioSession(
      document.body,
      scene,
      new THREE.Group(),
      document.createElement('canvas'),
      'test-cell',
      MISSIONS_V0,
      0,
      factory,
    );
    const first = { id: 'coast', name: '$COAST', color: 0x123456 };
    s.avatar = { ...first };
    s.brief();
    expect(s.action(ctx(1000))).toBe('rolled');
    s.avatar.color = 0xffffff;
    s.avatar = { id: 'other', name: 'Other', color: 0xabcdef };
    for (let i = 1; i <= 180; i++) s.tick(ctx(1000 + (i * 1000) / 30));
    expect(s.action(ctx(7000))).toBe('cut');
    await new Promise((r) => setTimeout(r, 0));
    expect(s.lastTake!.avatar).toEqual(first);
    expect(factory).toHaveBeenNthCalledWith(1, 'player', first);
    expect(s.ghosts[0]!.look).toEqual({ name: '$COAST', color: 0x123456 });
    s.retake();
    await shoot(s, 10_000, 1);
    expect(factory).toHaveBeenNthCalledWith(2, 'player', { id: 'other', name: 'Other', color: 0xabcdef });
    const short = vi.spyOn(s.ghosts[1]!, 'setPose');
    const long = vi.spyOn(s.ghosts[0]!, 'setPose');
    s.startPlayback(20_000, false);
    s.tick(ctx(23_000));
    expect(short.mock.lastCall![1]).toBe(1);
    expect(long.mock.lastCall![1]).toBe(3);
    s.tick(ctx(20_500));
    expect(short.mock.lastCall![1]).toBe(0.5);
    expect(long.mock.lastCall![1]).toBe(0.5);
    s.leave();
    expect(s.set.size).toBe(0);
    expect(await s.reviewMission(MISSIONS_V0[0]!.id, 50_000)).toBe(true);
    expect(factory).toHaveBeenNthCalledWith(3, 'player', first);
    s.stopPlayback();
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

  it('the reel keeps the best take per mission and can play it back again after the mission is over', async () => {
    const s = makeSession();
    const reels: number[] = [];
    s.onReel = (r) => reels.push(r.progress().earnedBars);
    s.brief();
    expect(s.reel.progress().earnedBars).toBe(0);
    const v = await shoot(s, 1000, 6);
    expect(v.stars).toBe(3);
    expect(s.reel.entry('m01-low-and-slow')).toMatchObject({ stars: 3, takeId: s.lastTake!.id });
    expect(reels).toEqual([8]);
    expect(s.leave().id).toBe(MISSIONS_V0[1]!.id); // mission 1 banked, its set cleared
    expect(s.set.size).toBe(0);
    // Watching it again from the reel: its own ghost, looping, independent of the (empty) current set.
    expect(await s.reviewMission('m01-low-and-slow', 50_000)).toBe(true);
    expect(s.reviewing).toBe('m01-low-and-slow');
    expect(s.playing).toBe(true);
    s.tick(ctx(51_000));
    expect(s.set.size).toBe(0);
    s.togglePlayback(52_000); // P stops the review
    expect(s.reviewing).toBeNull();
    expect(s.playing).toBe(false);
    expect(await s.reviewMission('m02-hop-on-the-one')).toBe(false); // nothing earned there yet
    const saved = s.reel.serialize();
    expect(saved.entries[0]).toMatchObject({ missionId: 'm01-low-and-slow', stars: 3 });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('StudioSession persisted avatar review', () => {
  const sessions: StudioSession[] = [];
  const setup = async () => {
    const scene = new THREE.Scene();
    const factory = vi.fn(
      (actorId: string, avatar?: TakeAvatar) =>
        new GhostActor(scene, new THREE.Group(), null, { name: avatar?.name ?? actorId, color: avatar?.color ?? 0xffffff }),
    );
    const s = new StudioSession(
      document.body,
      scene,
      new THREE.Group(),
      document.createElement('canvas'),
      'test-cell',
      [...MISSIONS_V0, { ...MISSIONS_V0[1]!, id: 'review-third' }],
      0,
      factory,
    );
    sessions.push(s);
    s.avatar = { id: 'current', name: 'Current performer', color: 0xabcdef };
    s.brief();
    await shoot(s, 1000, 6);
    const saved: TakeV1[] = [1, 2].map((i) => ({
      ...s.lastTake!,
      id: `saved-${i}`,
      actorId: `performer-${i}`,
      avatar: { id: `imported-${i}`, name: `Saved performer ${i}`, color: 0x123456 + i },
    }));
    const missions = [MISSIONS_V0[1]!.id, 'review-third'];
    saved.forEach((take, i) => s.reel.record(missions[i]!, 3, take.id));
    const load = vi.spyOn(takeStore, 'load').mockImplementation(async (id) => saved.find((take) => take.id === id) ?? null);
    return { s, scene, factory, saved, missions, load };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    for (const s of sessions.splice(0)) s.dispose();
    vi.restoreAllMocks();
  });

  it('awaits preparation of only the requested saved avatar and carries its exact metadata without changing the performer or set', async () => {
    const { s, scene, factory, saved, missions, load } = await setup();
    const ready = deferred<void>();
    s.prepareAvatar = vi.fn(() => ready.promise);
    const current = s.avatar;
    const take = s.lastTake;
    const request = s.reviewMission(missions[0]!, 20_000);
    await flush();
    expect(s.prepareAvatar).toHaveBeenCalledOnce();
    expect(s.prepareAvatar).toHaveBeenCalledWith(saved[0]!.avatar);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(s.reviewing).toBeNull();
    expect(s.playing).toBe(true);
    expect(s.ghosts[0]!.visible).toBe(true);
    ready.resolve();
    await expect(request).resolves.toBe(true);
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(saved[0]!.id);
    expect(factory).toHaveBeenLastCalledWith(saved[0]!.actorId, saved[0]!.avatar);
    expect(factory.mock.lastCall![1]).toBe(saved[0]!.avatar);
    expect(s.avatar).toBe(current);
    expect(s.actorId).toBe('player');
    expect(s.lastTake).toBe(take);
    expect(s.set.layers.map((layer) => layer.take)).toEqual([take]);
    expect(s.reviewing).toBe(missions[0]);
    expect(scene.children).toHaveLength(2);
    const ghost = factory.mock.results[1]!.value as GhostActor;
    const dispose = vi.spyOn(ghost, 'dispose');
    s.stopPlayback();
    expect(dispose).toHaveBeenCalledOnce();
    expect(scene.children).toHaveLength(1);
  });

  it.each(['prepare', 'factory'] as const)(
    'preserves the prior review and current take when the current %s fails with a missing asset',
    async (failure) => {
      const { s, scene, factory, missions } = await setup();
      await s.reviewMission(missions[0]!);
      const previous = factory.mock.results[1]!.value as GhostActor;
      const dispose = vi.spyOn(previous, 'dispose');
      const current = s.avatar;
      const take = s.lastTake;
      const error = new Error('Saved avatar missing: imported-2');
      const ready = deferred<void>();
      s.prepareAvatar = () => ready.promise;
      if (failure === 'factory')
        factory.mockImplementationOnce(() => {
          throw error;
        });
      const request = s.reviewMission(missions[1]!);
      const rejected = expect(request).rejects.toBe(error);
      await flush();
      if (failure === 'prepare') ready.reject(error);
      else ready.resolve();
      await rejected;
      expect(s.reviewing).toBe(missions[0]);
      expect(s.playing).toBe(true);
      expect(previous.visible).toBe(true);
      expect(dispose).not.toHaveBeenCalled();
      expect(s.avatar).toBe(current);
      expect(s.lastTake).toBe(take);
      expect(s.set.layers.map((layer) => layer.take)).toEqual([take]);
      expect(scene.children).toHaveLength(2);
    },
  );

  it.each(['resolve', 'reject'] as const)('lets the latest review win and suppresses a stale preparation %s', async (outcome) => {
    const { s, scene, factory, saved, missions } = await setup();
    const first = deferred<void>();
    const second = deferred<void>();
    s.prepareAvatar = (avatar) => (avatar.id === saved[0]!.avatar!.id ? first.promise : second.promise);
    const older = s.reviewMission(missions[0]!);
    await flush();
    const newer = s.reviewMission(missions[1]!);
    await flush();
    second.resolve();
    await expect(newer).resolves.toBe(true);
    if (outcome === 'resolve') first.resolve();
    else first.reject(new Error('stale missing asset'));
    await expect(older).resolves.toBe(false);
    expect(s.reviewing).toBe(missions[1]);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenLastCalledWith(saved[1]!.actorId, saved[1]!.avatar);
    expect(scene.children).toHaveLength(2);
    s.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it.each(['stopPlayback', 'stopReview', 'retake', 'roll', 'leave', 'dispose', 'recording', 'exporting'] as const)(
    '%s while preparing prevents a late ghost and leaks',
    async (cancel) => {
      const { s, scene, factory, missions } = await setup();
      const ready = deferred<void>();
      s.prepareAvatar = () => ready.promise;
      const request = s.reviewMission(missions[0]!);
      await flush();
      if (cancel === 'roll') expect(s.action(ctx(10_000))).toBe('rolled');
      else if (cancel === 'recording') s.state = 'recording';
      else if (cancel === 'exporting') s.exporting = true;
      else s[cancel]();
      ready.resolve();
      await expect(request).resolves.toBe(false);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(s.reviewing).toBeNull();
      if (cancel === 'dispose') await expect(s.reviewMission(missions[0]!)).resolves.toBe(false);
      s.dispose();
      expect(scene.children).toHaveLength(0);
    },
  );

  it('invalidates delayed store reads before preparation, including when a newer review has already started', async () => {
    const { s, factory, saved, missions, load } = await setup();
    const stored = deferred<TakeV1 | null>();
    load.mockImplementationOnce(() => stored.promise);
    s.prepareAvatar = vi.fn(async () => {});
    const older = s.reviewMission(missions[0]!);
    await expect(s.reviewMission(missions[1]!)).resolves.toBe(true);
    stored.resolve(saved[0]!);
    await expect(older).resolves.toBe(false);
    expect(s.prepareAvatar).toHaveBeenCalledOnce();
    expect(s.prepareAvatar).toHaveBeenCalledWith(saved[1]!.avatar);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(s.reviewing).toBe(missions[1]);
  });

  it.each(['stopPlayback', 'retake', 'dispose', 'recording', 'exporting'] as const)(
    '%s cancels a pending store read before preparing assets',
    async (cancel) => {
      const { s, scene, factory, saved, missions, load } = await setup();
      const stored = deferred<TakeV1 | null>();
      load.mockImplementationOnce(() => stored.promise);
      s.prepareAvatar = vi.fn(async () => {});
      const request = s.reviewMission(missions[0]!);
      if (cancel === 'recording') s.state = 'recording';
      else if (cancel === 'exporting') s.exporting = true;
      else s[cancel]();
      stored.resolve(saved[0]!);
      await expect(request).resolves.toBe(false);
      expect(s.prepareAvatar).not.toHaveBeenCalled();
      expect(factory).toHaveBeenCalledTimes(1);
      s.dispose();
      expect(scene.children).toHaveLength(0);
    },
  );

  it.each(['exportCut', 'exportControl'] as const)(
    '%s invalidates preparation even if export finishes before the asset loads',
    async (method) => {
      const { s, factory, missions } = await setup();
      const ready = deferred<void>();
      s.prepareAvatar = () => ready.promise;
      const request = s.reviewMission(missions[0]!);
      await flush();
      s.exportScene = () => ({
        renderer: {} as THREE.WebGLRenderer,
        scene: new THREE.Scene(),
        camera: new THREE.PerspectiveCamera(),
        begin: vi.fn(),
        end: vi.fn(),
      });
      vi.mocked(renderCut).mockRejectedValueOnce(new Error('no encoder'));
      vi.mocked(renderControl).mockRejectedValueOnce(new Error('no encoder'));
      await expect(s[method]()).rejects.toThrow('no encoder');
      expect(s.exporting).toBe(false);
      ready.resolve();
      await expect(request).resolves.toBe(false);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(s.reviewing).toBeNull();
      vi.mocked(renderCut).mockReset();
      vi.mocked(renderControl).mockReset();
    },
  );

  it('retains set playback on preparation failure and suppresses errors after an explicit stop', async () => {
    const { s, scene, factory, missions } = await setup();
    const error = new Error('missing saved avatar');
    s.prepareAvatar = async () => {
      throw error;
    };
    const previous = s.ghosts[0]!;
    const take = s.lastTake;
    const current = s.avatar;
    await expect(s.reviewMission(missions[0]!)).rejects.toBe(error);
    expect(s.playing).toBe(true);
    expect(previous.visible).toBe(true);
    expect(s.ghosts).toEqual([previous]);
    expect(s.avatar).toBe(current);
    expect(s.set.layers[0]!.take).toBe(take);
    expect(scene.children).toHaveLength(1);
    const ready = deferred<void>();
    s.prepareAvatar = () => ready.promise;
    const request = s.reviewMission(missions[0]!);
    await flush();
    s.stopReview();
    ready.reject(error);
    await expect(request).resolves.toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('keeps freshly recorded avatar ghosts synchronous without invoking preparation', async () => {
    const s = makeSession();
    sessions.push(s);
    s.avatar = { id: 'loaded', name: 'Already loaded' };
    s.prepareAvatar = vi.fn(async () => {
      throw new Error('must not prepare');
    });
    s.brief();
    expect(s.action(ctx(1000))).toBe('rolled');
    s.tick(ctx(1100));
    s.tick(ctx(1200));
    expect(s.action(ctx(1300))).toBe('cut');
    expect(s.ghosts).toHaveLength(1);
    expect(s.lastTake!.avatar).toEqual(s.avatar);
    expect(s.prepareAvatar).not.toHaveBeenCalled();
    await flush();
  });

  it('does not prepare legacy takes without avatar metadata', async () => {
    const s = makeSession();
    sessions.push(s);
    s.prepareAvatar = vi.fn(async () => {
      throw new Error('must not prepare');
    });
    s.brief();
    expect(s.action(ctx(1000))).toBe('rolled');
    s.tick(ctx(1100));
    s.tick(ctx(1200));
    expect(s.action(ctx(1300))).toBe('cut');
    expect(s.ghosts).toHaveLength(1);
    expect(s.prepareAvatar).not.toHaveBeenCalled();
    await flush();
    s.reel.record(s.mission.id, 3, s.lastTake!.id);
    await expect(s.reviewMission(s.mission.id)).resolves.toBe(true);
    expect(s.prepareAvatar).not.toHaveBeenCalled();
  });
});

describe('StudioSession control reference package', () => {
  const setup = async () => {
    const s = makeSession();
    s.avatar = { id: 'mannequin', name: 'Coast mannequin' };
    s.brief();
    await shoot(s, 1000, 2);
    const host = {
      renderer: {} as THREE.WebGLRenderer,
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100),
      begin: vi.fn(),
      end: vi.fn(),
      render: vi.fn(),
      look: () => 'noir',
    };
    s.exportScene = () => host;
    s.controlContext = () => ({ cell: 'valley', timePreset: 'noon', look: 'mission-look-is-not-rendered' });
    vi.mocked(buildControlPackage).mockResolvedValue({ blob: new Blob(['tar']), manifest: { files: [] } } as Awaited<
      ReturnType<typeof buildControlPackage>
    >);
    return { s, host };
  };

  beforeEach(() => {
    vi.mocked(renderControl).mockReset();
    vi.mocked(buildControlPackage).mockReset();
  });

  it('captures the actual look and subspan, forwards post rendering, and packages without uploading', async () => {
    const { s, host } = await setup();
    const joints: Record<string, [number, number, number]> = { mixamorigRightHand: [1, 2, 3] };
    vi.spyOn(s.ghosts[0]!, 'boneWorldPositions').mockReturnValue(joints);
    vi.mocked(renderControl).mockImplementation(async (plan, target, passes) => {
      expect(passes).toEqual(['beauty', 'depth', 'pose']);
      expect(target.render).toBe(host.render);
      expect(s.exporting).toBe(true);
      expect(s.action(ctx(9000))).toBe('ignored');
      s.retake();
      expect(s.state).toBe('verdict');
      const camera = cameraJson(plan);
      target.begin();
      for (let i = 0; i < plan.frameCount; i++) {
        target.seek(plan.startS + i / plan.fps);
        expect(target.actors()[0]?.rigJoints).toBe(joints);
        target.camera.updateMatrixWorld();
        const pos = target.camera.position.toArray() as [number, number, number];
        const quat = target.camera.quaternion.toArray() as [number, number, number, number];
        camera.frames.push(cameraFrame(plan, i / plan.fps, pos, quat, target.camera.fov));
      }
      target.end();
      return {
        passes: {},
        camera,
        hero: { blob: new Blob(['png']), mime: 'image/png', width: plan.width, height: plan.height, timeS: plan.startS, frame: 0 },
      };
    });
    const result = await s.exportControl({ startS: 0.5, endS: 1.5, cut: { fps: 10, width: 320, height: 180 } });
    expect(result.prompts.span).toMatchObject({ startS: 0.5, endS: 1.5, durationS: 1 });
    expect(result.prompts.context).toMatchObject({ cell: 'valley', timePreset: 'noon', look: 'noir', cameraSource: 'take' });
    expect(buildControlPackage).toHaveBeenCalledWith(
      expect.objectContaining({ hero: expect.objectContaining({ timeS: 0.5 }) }),
      result.prompts,
    );
    expect(s.exporting).toBe(false);
    expect(s.playing).toBe(true);
    expect(host.end).toHaveBeenCalledOnce();
    expect(s.lastShare).toBeNull();
  });

  it('restores playback when the renderer fails before begin and allows another export', async () => {
    const { s } = await setup();
    vi.mocked(renderControl).mockRejectedValue(new Error('no encoder'));
    await expect(s.exportControl()).rejects.toThrow('no encoder');
    expect(s.exporting).toBe(false);
    expect(s.playing).toBe(true);
    expect(s.canRoll).toBe(true);
    expect(buildControlPackage).not.toHaveBeenCalled();
    s.stopPlayback();
    await expect(s.exportControl()).rejects.toThrow('no encoder');
    expect(s.playing).toBe(false);
  });

  it('refuses control exports while recording even when earlier takes exist', async () => {
    const { s } = await setup();
    s.retake();
    expect(s.action(ctx(10000))).toBe('rolled');
    await expect(s.exportControl()).rejects.toThrow('finish recording');
    expect(renderControl).not.toHaveBeenCalled();
  });
});
