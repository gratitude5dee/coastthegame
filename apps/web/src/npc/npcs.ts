/**
 * NPCs (goal.md PHY-4, CHR/AUD-1 placeholders): the Photographer (tutor) and a few extras — Detour crowd agents with
 * NpcBrain behaviours (loiter · approach · greet), placeholder capsules, kinematic capsules in Rapier so nobody walks
 * through them, and cached one-liners shown as subtitles (voice arrives with AUD-1). Skinned rigs replace the capsules
 * in M4; everything here talks to `NpcSystem` so that swap is local.
 */
import * as THREE from 'three';
import type * as RAPIER_NS from '@dimforge/rapier3d-compat';
import { NpcBrain, NpcNav, groundHeightAt, type GroundGrid, type PhysicsWorld } from '@coast/engine';
import type { CrowdAgent } from 'recast-navigation';

export interface NpcSpec {
  id: string;
  name: string;
  color: number;
  home: THREE.Vector3;
  lines: string[];
  approaches?: boolean;
  speed?: number;
}

export interface Npc {
  spec: NpcSpec;
  brain: NpcBrain;
  mesh: THREE.Group;
  body: RAPIER_NS.RigidBody;
  agent: CrowdAgent | null;
  facing: number;
  faceTarget: THREE.Vector3 | null;
  lineIndex: number;
}

export interface NpcEvents {
  onGreet?: (npc: Npc, line: string) => void;
}

export class NpcSystem {
  readonly npcs: Npc[] = [];
  private nav: NpcNav | null = null;
  private navFailed = false;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly playerTuple: [number, number, number] = [0, 0, 0];
  private readonly meTuple: [number, number, number] = [0, 0, 0];
  greets = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly world: THREE.Object3D,
    private readonly ground: GroundGrid | null,
    private readonly events: NpcEvents = {},
    private readonly random: () => number = Math.random,
  ) {}

  get ready() {
    return !!this.nav;
  }

  /** Bake the navmesh from walkable meshes (async, WASM on demand) and put every NPC on it. */
  async buildNav(walkable: THREE.Mesh[], bounds?: [[number, number, number], [number, number, number]]) {
    try {
      const nav = await NpcNav.build(walkable, { ...(bounds ? { bounds } : {}) }, 16);
      this.nav = nav;
      for (const n of this.npcs) n.agent = nav.addAgent(n.mesh.position, { maxSpeed: n.spec.speed ?? 1.4 });
      performance.mark('coast:navmesh');
    } catch (e) {
      this.navFailed = true;
      console.warn('navmesh unavailable — NPCs will stand still', e);
    }
  }

  spawn(spec: NpcSpec): Npc {
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.32, 1.0, 6, 16),
      new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.6 }),
    );
    body.position.y = 0.85;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.12), new THREE.MeshStandardMaterial({ color: 0x0b0a10 }));
    head.position.set(0.18, 1.35, -0.28); // the Photographer's camera; a "nose" on everyone else
    mesh.add(body, head);
    mesh.name = spec.id;
    const pos = spec.home.clone();
    if (this.ground) pos.y = groundHeightAt(this.ground, pos.x, pos.z);
    mesh.position.copy(pos);
    this.world.add(mesh);

    const R = this.physics.R;
    const rb = this.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y + 0.9, pos.z));
    this.physics.world.createCollider(R.ColliderDesc.capsule(0.55, 0.32), rb);

    const npc: Npc = {
      spec,
      brain: new NpcBrain({ home: [pos.x, pos.y, pos.z], approaches: spec.approaches ?? false, random: this.random }),
      mesh,
      body: rb,
      agent: this.nav ? this.nav.addAgent(pos, { maxSpeed: spec.speed ?? 1.4 }) : null,
      facing: 0,
      faceTarget: null,
      lineIndex: 0,
    };
    this.npcs.push(npc);
    return npc;
  }

  byId(id: string): Npc | undefined {
    return this.npcs.find((n) => n.spec.id === id);
  }

  /** Per frame: brains → crowd → meshes/bodies. `paused` (diorama) freezes everyone. */
  update(dt: number, playerFeet: THREE.Vector3, paused = false) {
    if (paused || !this.nav) return; // brains wait for the navmesh: a moveTo before the agent exists would be lost
    this.playerTuple[0] = playerFeet.x;
    this.playerTuple[1] = playerFeet.y;
    this.playerTuple[2] = playerFeet.z;
    for (const n of this.npcs) {
      const p = n.mesh.position;
      this.meTuple[0] = p.x;
      this.meTuple[1] = p.y;
      this.meTuple[2] = p.z;
      const arrived = n.agent && this.nav ? this.nav.arrived(n.agent) : true;
      for (const ev of n.brain.update(this.meTuple, this.playerTuple, dt, arrived)) {
        if (ev.kind === 'moveTo' && n.agent && this.nav && ev.target) {
          n.faceTarget = null;
          this.nav.moveTo(n.agent, this.tmp.set(ev.target[0], ev.target[1], ev.target[2]));
        } else if (ev.kind === 'stop' && n.agent && this.nav) this.nav.stop(n.agent);
        else if (ev.kind === 'face' && ev.target)
          n.faceTarget = (n.faceTarget ?? new THREE.Vector3()).set(ev.target[0], ev.target[1], ev.target[2]);
        else if (ev.kind === 'greet') {
          const line = n.spec.lines[n.lineIndex % n.spec.lines.length] ?? '';
          n.lineIndex++;
          this.greets++;
          this.events.onGreet?.(n, line);
        }
      }
    }
    if (this.nav) {
      this.nav.update(dt);
      for (const n of this.npcs) {
        if (!n.agent) continue;
        const pos = this.nav.position(n.agent, this.tmp);
        n.mesh.position.set(pos.x, pos.y, pos.z);
        const v = this.nav.velocity(n.agent, this.tmp2);
        if (Math.hypot(v.x, v.z) > 0.15) n.facing = Math.atan2(-v.x, -v.z);
      }
    }
    for (const n of this.npcs) {
      if (n.faceTarget && n.brain.state !== 'loiter' && n.brain.state !== 'approach') {
        const dx = n.faceTarget.x - n.mesh.position.x;
        const dz = n.faceTarget.z - n.mesh.position.z;
        if (Math.hypot(dx, dz) > 0.05) n.facing = Math.atan2(-dx, -dz);
      }
      // Smooth turn toward the facing.
      const cur = n.mesh.rotation.y;
      const delta = Math.atan2(Math.sin(n.facing - cur), Math.cos(n.facing - cur));
      n.mesh.rotation.y = cur + delta * Math.min(1, dt * 8);
      n.body.setNextKinematicTranslation({ x: n.mesh.position.x, y: n.mesh.position.y + 0.9, z: n.mesh.position.z });
    }
  }

  dispose() {
    for (const n of this.npcs) {
      this.world.remove(n.mesh);
      this.physics.world.removeRigidBody(n.body);
    }
    this.npcs.length = 0;
    this.nav?.dispose();
    this.nav = null;
  }

  get navFailedFlag() {
    return this.navFailed;
  }
}
