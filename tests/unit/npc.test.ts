import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { AvatarAsset } from '../../packages/engine/src/actors/avatar';
import type { NpcSpec } from '../../apps/web/src/npc/npcs';
import * as THREE from 'three';
import { NpcBrain } from '../../packages/engine/src/npc/brain';
import { NpcNav } from '../../packages/engine/src/npc/crowd';
import { groundGridGeometry, type GroundGrid } from '../../packages/engine/src/physics/world';

/** goal.md PHY-4 / NPC behaviours: the brain's state machine with a seeded RNG, and a real Recast bake + crowd walk. */
describe('NpcBrain', () => {
  const seq = (values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length]!;
  };
  const far: [number, number, number] = [50, 0, 50];

  it('loiters around home after a pause, then idles again when the crowd says it arrived', () => {
    const b = new NpcBrain({ home: [0, 0, 0], loiterRadius: 5, loiterPause: [2, 2], random: seq([0.5, 0.25, 1, 0.5]) });
    expect(b.state).toBe('idle');
    expect(b.update([0, 0, 0], far, 1, true)).toEqual([]);
    const ev = b.update([0, 0, 0], far, 1.1, true);
    expect(b.state).toBe('loiter');
    expect(ev[0]!.kind).toBe('moveTo');
    const t = ev[0]!.target!;
    expect(Math.hypot(t[0], t[2])).toBeLessThanOrEqual(5.0001);
    expect(b.update(t, far, 0.1, false)).toEqual([]); // still walking
    expect(b.update(t, far, 0.1, true)).toEqual([]);
    expect(b.state).toBe('idle');
  });

  it('a tutor approaches the player, stops at personal space, greets once, and respects the cooldown', () => {
    const b = new NpcBrain({
      home: [0, 0, 0],
      approaches: true,
      noticeDistance: 7,
      personalSpace: 1.7,
      greetDistance: 3.2,
      greetCooldown: 25,
      greetHold: 2,
      random: () => 0.5,
    });
    b.update([0, 0, 0], [6, 0, 0], 0.1, true);
    expect(b.state).toBe('approach');
    const ev = b.update([0, 0, 0], [6, 0, 0], 0.1, false);
    expect(ev.find((e) => e.kind === 'moveTo')?.target).toEqual([6, 0, 0]);
    // Walks into greet range: greeting fires (stop, face, greet) and holds.
    const g = b.update([3, 0, 0], [6, 0, 0], 0.1, false);
    expect(g.map((e) => e.kind)).toEqual(['stop', 'face', 'greet']);
    expect(b.state).toBe('greet');
    b.update([3, 0, 0], [6, 0, 0], 2.5, true);
    expect(b.state).toBe('idle');
    // Within cooldown: no second greeting and no re-approach even when close.
    expect(b.update([3, 0, 0], [4, 0, 0], 0.1, true).some((e) => e.kind === 'greet')).toBe(false);
    expect(b.state).toBe('idle');
    b.update([3, 0, 0], far, 30, true); // cooldown elapses while the player is away
    expect(b.update([3, 0, 0], [4.5, 0, 0], 0.1, true).some((e) => e.kind === 'greet')).toBe(true);
  });

  it('extras never approach but still greet in passing', () => {
    const b = new NpcBrain({ home: [0, 0, 0], approaches: false, random: () => 0.9 });
    b.update([0, 0, 0], [5, 0, 0], 0.1, true);
    expect(b.state).toBe('idle');
    expect(b.update([0, 0, 0], [2, 0, 0], 0.1, true).map((e) => e.kind)).toEqual(['stop', 'face', 'greet']);
  });
});

describe('NpcNav (Recast + Detour crowd)', () => {
  let nav: NpcNav;
  beforeAll(async () => {
    const cols = 41; // flat 30 m × 30 m ground grid, like a sample world's fallback collider
    const grid: GroundGrid = { heights: new Float32Array(cols * cols), cols, rows: cols, minX: -15, minZ: -15, cellSize: 0.75 };
    const mesh = new THREE.Mesh(groundGridGeometry(grid), new THREE.MeshBasicMaterial());
    nav = await NpcNav.build([mesh], {}, 4);
  }, 60_000);

  it('bakes a navmesh from the ground grid and an agent walks to a target with the crowd', () => {
    const agent = nav.addAgent(new THREE.Vector3(-8, 0, -8), { maxSpeed: 2 });
    expect(agent).toBeTruthy();
    expect(nav.moveTo(agent!, new THREE.Vector3(8, 0, 6))).toBe(true);
    for (let i = 0; i < 60 * 12; i++) nav.update(1 / 60);
    const p = nav.position(agent!);
    expect(Math.hypot(p.x - 8, p.z - 6)).toBeLessThan(0.6);
    expect(nav.arrived(agent!)).toBe(true);
    const off = nav.snap(new THREE.Vector3(40, 0, 40), 1);
    expect(off).toBeNull(); // nothing walkable out there
    nav.dispose();
  });
});

describe('NpcBrain greetDelay', () => {
  it('holds the first greeting back for the delay, then greets on the cooldown as usual', () => {
    const b = new NpcBrain({ home: [0, 0, 0], greetDelay: 10, greetCooldown: 25, random: () => 0.5 });
    const near: [number, number, number] = [1, 0, 0];
    expect(b.update([0, 0, 0], near, 1, true).some((e) => e.kind === 'greet')).toBe(false);
    expect(b.update([0, 0, 0], near, 8, true).some((e) => e.kind === 'greet')).toBe(false); // 9 s: still held
    expect(b.update([0, 0, 0], near, 1.5, true).some((e) => e.kind === 'greet')).toBe(true); // 10.5 s: greets
    const plain = new NpcBrain({ home: [0, 0, 0], random: () => 0.5 });
    expect(plain.update([0, 0, 0], near, 0.016, true).some((e) => e.kind === 'greet')).toBe(true); // no delay: at once
  });
});

describe('NpcSystem possession (ACT-3)', () => {
  it('swaps identity and place with the nearest NPC, and swapping again next to that body switches back', async () => {
    const { loadRapier, PhysicsWorld } = await import('../../packages/engine/src/physics/world');
    const { NpcSystem } = await import('../../apps/web/src/npc/npcs');
    const R = await loadRapier();
    const physics = new PhysicsWorld(R);
    const world = new THREE.Group();
    const npcs = new NpcSystem(physics, world, null, {}, () => 0.5);
    const photographer = npcs.spawn({
      id: 'photographer',
      name: 'Photographer',
      color: 0x4fa3d9,
      home: new THREE.Vector3(2, 0, 0),
      lines: ['hi'],
      approaches: true,
    });
    npcs.spawn({ id: 'npc_a', name: 'Rico', color: 0xd9a03a, home: new THREE.Vector3(9, 0, 0), lines: ['yo'] });
    const feet = new THREE.Vector3(0, 0, 0);
    expect(npcs.nearest(feet, 3.2)?.spec.id).toBe('photographer');
    expect(npcs.nearest(new THREE.Vector3(30, 0, 0), 3.2)).toBeNull();

    const me = { id: 'player', name: '$COAST', color: 0xffb54a, home: new THREE.Vector3(), lines: [], approaches: false };
    const was = npcs.swapIdentity(photographer, me, feet, 1.2);
    // I am the Photographer now, standing where she stood …
    expect(was.spec.id).toBe('photographer');
    expect(was.position.x).toBeCloseTo(2);
    // … and the NPC entity carries on as $COAST from where I stood, facing my way, with a fresh brain that does not tutor.
    expect(photographer.spec.id).toBe('player');
    expect(photographer.spec.name).toBe('$COAST');
    expect(photographer.mesh.name).toBe('player');
    expect(photographer.avatar).toBeUndefined();
    expect(photographer.capsule.visible).toBe(true);
    expect(photographer.capsule.material.color.getHex()).toBe(0xffb54a);
    expect(photographer.mesh.position.x).toBeCloseTo(0);
    expect(photographer.mesh.rotation.y).toBeCloseTo(1.2);
    expect(photographer.brain.opts.approaches).toBe(false);
    expect(photographer.brain.opts.home[0]).toBeCloseTo(0);
    expect(photographer.body.translation().x).toBeCloseTo(0);
    expect(npcs.byId('photographer')).toBeUndefined(); // the identity left the crowd
    expect(npcs.byId('player')).toBe(photographer);

    // Switch back: possess the body that carries $COAST.
    const back = npcs.swapIdentity(npcs.nearest(was.position, 3.2)!, was.spec, was.position, 0);
    expect(back.spec.id).toBe('player');
    expect(npcs.byId('photographer')).toBe(photographer);
    expect(photographer.brain.opts.approaches).toBe(true);
    expect(photographer.mesh.position.x).toBeCloseTo(2);
    expect(photographer.mesh.name).toBe('photographer');
    const capsuleGeometry = vi.spyOn(photographer.capsule.geometry, 'dispose');
    const capsuleMaterial = vi.spyOn(photographer.capsule.material, 'dispose');
    const nose = photographer.mesh.children[1] as THREE.Mesh;
    const noseGeometry = vi.spyOn(nose.geometry, 'dispose');
    const noseMaterial = vi.spyOn(nose.material as THREE.Material, 'dispose');
    npcs.dispose();
    expect(capsuleGeometry).toHaveBeenCalledTimes(1);
    expect(capsuleMaterial).toHaveBeenCalledTimes(1);
    expect(noseGeometry).toHaveBeenCalledTimes(1);
    expect(noseMaterial).toHaveBeenCalledTimes(1);
    physics.dispose();
  }, 30_000);
});

describe('NpcSystem avatars', () => {
  afterEach(() => vi.restoreAllMocks());

  const makeAsset = (id: string) => {
    const template = new THREE.Group();
    const geometry = new THREE.BoxGeometry(0.5, 1.8, 0.5);
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const model = new THREE.Mesh(geometry, material);
    model.name = `visual-${id}`;
    template.add(model);
    const idle = new THREE.AnimationClip('idle', 2, [new THREE.NumberKeyframeTrack(`${model.name}.rotation[y]`, [0, 2], [0.25, 1.25])]);
    const walk = new THREE.AnimationClip('walk', 2, [new THREE.NumberKeyframeTrack(`${model.name}.rotation[x]`, [0, 1, 2], [0, 0.5, 0])]);
    const asset = new AvatarAsset(
      template,
      [idle, walk],
      {
        boneCount: 0,
        triangles: 12,
        heightM: 1.8,
        clips: ['idle', 'walk'],
        rig: 'unrigged',
        warnings: [],
      },
      { id, name: id },
    );
    return { asset, geometry, material };
  };

  const spec = (id: string, color = 0xffffff): NpcSpec => ({ id, name: id, color, home: new THREE.Vector3(), lines: [] });

  it('refreshes independent visual identity on possession and disposes instances and placeholders without the shared assets', async () => {
    const { loadRapier, PhysicsWorld } = await import('../../packages/engine/src/physics/world');
    const { NpcSystem } = await import('../../apps/web/src/npc/npcs');
    const physics = new PhysicsWorld(await loadRapier());
    const mannequin = makeAsset('mannequin');
    const custom = makeAsset('custom');
    const live = custom.asset.instantiate();
    live.setTint(0xff0000);
    const avatarFor = vi.fn((s: NpcSpec) => (s.id === 'player' ? { asset: custom.asset, color: 0x123456 } : { asset: mannequin.asset }));
    const world = new THREE.Group();
    const npcs = new NpcSystem(physics, world, null, { avatarFor });
    const npc = npcs.spawn(spec('photographer', 0x00ff00));
    const other = npcs.spawn(spec('extra', 0x0000ff));
    const old = npc.avatar!;
    const oldDispose = vi.spyOn(old, 'dispose');
    expect(old).not.toBe(other.avatar);
    expect(old.group.parent).toBe(npc.mesh);
    expect(npc.capsule.visible).toBe(false);
    const nose = npc.mesh.children[1] as THREE.Mesh;
    expect(nose.visible).toBe(false);
    const material = (root: THREE.Object3D, name: string) =>
      (root.getObjectByName(name) as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(material(old.group, 'visual-mannequin').color.getHex()).toBe(0x00ff00);
    expect(material(other.avatar!.group, 'visual-mannequin').color.getHex()).toBe(0x0000ff);
    expect(material(old.group, 'visual-mannequin')).not.toBe(material(other.avatar!.group, 'visual-mannequin'));
    const sourceDisposals = [mannequin.geometry, mannequin.material, custom.geometry, custom.material].map((resource) =>
      vi.spyOn(resource, 'dispose'),
    );
    const placeholders = [npc.capsule.geometry, npc.capsule.material, nose.geometry, nose.material as THREE.Material].map((resource) =>
      vi.spyOn(resource, 'dispose'),
    );
    const was = npcs.swapIdentity(npc, spec('player'), new THREE.Vector3(2, 0, 1), 0.7);
    expect(avatarFor).toHaveBeenLastCalledWith(npc.spec);
    expect(npc.mesh.name).toBe('player');
    expect(npc.mesh.children).toHaveLength(3);
    expect(oldDispose).toHaveBeenCalledTimes(1);
    expect(old.group.parent).toBeNull();
    expect(npc.avatar!.group.getObjectByName('visual-custom')).toBeDefined();
    expect(npc.avatar).not.toBe(live);
    expect(material(npc.avatar!.group, 'visual-custom').color.getHex()).toBe(0x123456);
    expect(material(live.group, 'visual-custom').color.getHex()).toBe(0xff0000);
    live.setTint(0xffffff);
    expect(material(npc.avatar!.group, 'visual-custom').color.getHex()).toBe(0x123456);
    const playerBody = npc.avatar!;
    const playerDispose = vi.spyOn(playerBody, 'dispose');
    npcs.swapIdentity(npc, was.spec, was.position, was.yaw);
    expect(npc.mesh.name).toBe('photographer');
    expect(npc.avatar!.group.getObjectByName('visual-mannequin')).toBeDefined();
    expect(playerDispose).toHaveBeenCalledTimes(1);
    expect(playerBody.group.parent).toBeNull();
    for (const dispose of placeholders) expect(dispose).not.toHaveBeenCalled();
    const finalDispose = vi.spyOn(npc.avatar!, 'dispose');
    expect(npcs.remove('photographer')).toBe(true);
    expect(npcs.remove('photographer')).toBe(false);
    expect(finalDispose).toHaveBeenCalledTimes(1);
    expect(npc.avatar).toBeUndefined();
    expect(npc.mesh.parent).toBeNull();
    for (const dispose of placeholders) expect(dispose).toHaveBeenCalledTimes(1);
    const otherDispose = vi.spyOn(other.avatar!, 'dispose');
    npcs.dispose();
    npcs.dispose();
    expect(otherDispose).toHaveBeenCalledTimes(1);
    for (const dispose of sourceDisposals) expect(dispose).not.toHaveBeenCalled();
    const again = custom.asset.instantiate();
    again.sample(1, 2, true);
    again.dispose();
    live.dispose();
    custom.asset.dispose();
    mannequin.asset.dispose();
    for (const dispose of sourceDisposals) expect(dispose).toHaveBeenCalledTimes(1);
    physics.dispose();
  });

  it('initializes idle without navigation and advances only the unpaused simulation clock', async () => {
    const { loadRapier, PhysicsWorld } = await import('../../packages/engine/src/physics/world');
    const { NpcSystem } = await import('../../apps/web/src/npc/npcs');
    const physics = new PhysicsWorld(await loadRapier());
    const { asset } = makeAsset('idle');
    const npcs = new NpcSystem(physics, new THREE.Group(), null, { avatarFor: () => ({ asset }) });
    const npc = npcs.spawn(spec('idle'));
    const model = npc.avatar!.group.getObjectByName('visual-idle')!;
    expect(model.rotation.y).toBeCloseTo(0.25);
    const sample = vi.spyOn(npc.avatar!, 'sample');
    npcs.update(0.5, new THREE.Vector3());
    expect(sample).toHaveBeenLastCalledWith(0.5, 0, true);
    expect(model.rotation.y).toBeCloseTo(0.5);
    sample.mockClear();
    npcs.update(20, new THREE.Vector3(), true);
    expect(sample).not.toHaveBeenCalled();
    expect(model.rotation.y).toBeCloseTo(0.5);
    npcs.update(0.25, new THREE.Vector3());
    expect(sample).toHaveBeenLastCalledWith(0.75, 0, true);
    npcs.dispose();
    asset.dispose();
    physics.dispose();
  });

  it('samples actual crowd velocity on the accumulated clock and freezes animation and movement when paused', async () => {
    const { loadRapier, PhysicsWorld } = await import('../../packages/engine/src/physics/world');
    const { NpcSystem } = await import('../../apps/web/src/npc/npcs');
    const physics = new PhysicsWorld(await loadRapier());
    const { asset } = makeAsset('walker');
    const npcs = new NpcSystem(physics, new THREE.Group(), null, { avatarFor: () => ({ asset }) }, () => 0.5);
    const grid: GroundGrid = { heights: new Float32Array(41 * 41), cols: 41, rows: 41, minX: -15, minZ: -15, cellSize: 0.75 };
    const ground = new THREE.Mesh(groundGridGeometry(grid), new THREE.MeshBasicMaterial());
    await npcs.buildNav([ground]);
    const npc = npcs.spawn({ ...spec('walker'), speed: 2 });
    expect(npc.agent).not.toBeNull();
    const sample = vi.spyOn(npc.avatar!, 'sample');
    const far = new THREE.Vector3(50, 0, 50);
    for (let i = 0; i < 360; i++) {
      npcs.update(1 / 60, far);
      const velocity = npc.agent!.velocity();
      expect(sample.mock.lastCall![1]).toBeCloseTo(Math.hypot(velocity.x, velocity.z));
    }
    expect(sample.mock.calls.some((call) => call[1] > 0.1)).toBe(true);
    expect(sample.mock.calls.some((call) => call[1] === 0)).toBe(true);
    expect(sample.mock.lastCall![0]).toBeCloseTo(6);
    const position = npc.mesh.position.clone();
    const model = npc.avatar!.group.getObjectByName('visual-walker')!;
    const rotation = model.quaternion.clone();
    sample.mockClear();
    npcs.update(30, far, true);
    expect(sample).not.toHaveBeenCalled();
    expect(npc.mesh.position.equals(position)).toBe(true);
    expect(model.quaternion.equals(rotation)).toBe(true);
    npcs.update(0.1, far);
    expect(sample.mock.lastCall![0]).toBeCloseTo(6.1);
    npcs.dispose();
    asset.dispose();
    ground.geometry.dispose();
    ground.material.dispose();
    physics.dispose();
  });
});
