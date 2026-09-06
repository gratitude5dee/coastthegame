import { describe, it, expect, beforeAll } from 'vitest';
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
    npcs.dispose();
  }, 30_000);
});
