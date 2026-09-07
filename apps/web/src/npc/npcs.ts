/**
 * NPCs (goal.md PHY-4, CHR/AUD-1 placeholders): the Photographer (tutor) and a few extras — Detour crowd agents with
 * NpcBrain behaviours (loiter · approach · greet), placeholder capsules, kinematic capsules in Rapier so nobody walks
 * through them, and cached one-liners shown as subtitles (voice arrives with AUD-1). Skinned rigs replace the capsules
 * in M4; everything here talks to `NpcSystem` so that swap is local.
 */
import * as THREE from 'three';
import type * as RAPIER_NS from '@dimforge/rapier3d-compat';
import { NpcBrain, NpcNav, type Avatar, type AvatarAsset, type PhysicsWorld } from '@coast/engine';
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
  avatar?: Avatar;
  /** The capsule (its material carries the identity's colour). */
  capsule: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;
  body: RAPIER_NS.RigidBody;
  agent: CrowdAgent | null;
  facing: number;
  faceTarget: THREE.Vector3 | null;
  lineIndex: number;
}

export interface NpcEvents {
  onGreet?: (npc: Npc, line: string) => void;
  avatarFor?: (spec: NpcSpec) => { asset: AvatarAsset; color?: number };
}

export class NpcSystem {
  readonly npcs: Npc[] = [];
  private nav: NpcNav | null = null;
  private navFailed = false;
  private navGen = 0;
  private animationTimeS = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly playerTuple: [number, number, number] = [0, 0, 0];
  private readonly meTuple: [number, number, number] = [0, 0, 0];
  greets = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly world: THREE.Object3D,
    /** Ground height under a point — spans every resident cell and the roads between them (W-3). */
    private readonly heightAt: ((x: number, z: number) => number) | null,
    private readonly events: NpcEvents = {},
    private readonly random: () => number = Math.random,
  ) {}

  get ready() {
    return !!this.nav;
  }

  /**
   * Bake the navmesh from walkable meshes (async, WASM on demand) and put every NPC on it. Called again whenever a
   * cell's ground comes or goes: the previous mesh keeps the crowd walking until the new one is ready, then the
   * agents move over (a bake that an even newer one overtook is dropped).
   */
  async buildNav(walkable: THREE.Mesh[], bounds?: [[number, number, number], [number, number, number]]) {
    const gen = ++this.navGen;
    try {
      const nav = await NpcNav.build(walkable, { ...(bounds ? { bounds } : {}) }, 16);
      if (gen !== this.navGen) {
        nav.dispose();
        return;
      }
      this.nav?.dispose();
      this.nav = nav;
      for (const n of this.npcs) n.agent = nav.addAgent(n.mesh.position, { maxSpeed: n.spec.speed ?? 1.4 });
      performance.mark('coast:navmesh');
    } catch (e) {
      if (gen !== this.navGen) return;
      this.navFailed = true;
      console.warn('navmesh unavailable — NPCs will stand still', e);
    }
  }

  private groundY(pos: THREE.Vector3): number {
    return this.heightAt ? this.heightAt(pos.x, pos.z) : pos.y;
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
    pos.y = this.groundY(pos);
    mesh.position.copy(pos);
    this.world.add(mesh);

    const R = this.physics.R;
    const rb = this.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y + 0.9, pos.z));
    this.physics.world.createCollider(R.ColliderDesc.capsule(0.55, 0.32), rb);

    const npc: Npc = {
      spec,
      brain: new NpcBrain({ home: [pos.x, pos.y, pos.z], approaches: spec.approaches ?? false, random: this.random }),
      mesh,
      capsule: body,
      body: rb,
      agent: this.nav ? this.nav.addAgent(pos, { maxSpeed: spec.speed ?? 1.4 }) : null,
      facing: 0,
      faceTarget: null,
      lineIndex: 0,
    };
    this.refreshAvatar(npc);
    this.npcs.push(npc);
    return npc;
  }

  private refreshAvatar(npc: Npc) {
    const visual = this.events.avatarFor?.(npc.spec);
    const avatar = visual?.asset.instantiate();
    if (avatar) avatar.setTint(visual?.color ?? npc.spec.color);
    npc.avatar?.dispose();
    npc.avatar = avatar;
    for (const child of npc.mesh.children) if ((child as THREE.Mesh).isMesh) child.visible = !avatar;
    if (avatar) {
      npc.mesh.add(avatar.group);
      npc.mesh.updateWorldMatrix(true, true);
      avatar.sample(this.animationTimeS, 0, true);
    }
  }

  private disposeVisual(npc: Npc) {
    npc.avatar?.group.removeFromParent();
    npc.avatar?.dispose();
    npc.avatar = undefined;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    npc.mesh.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }

  byId(id: string): Npc | undefined {
    return this.npcs.find((n) => n.spec.id === id);
  }

  /** Take an NPC out of the world (its cell unloaded, W-3). Returns whether there was one. */
  remove(id: string): boolean {
    const i = this.npcs.findIndex((n) => n.spec.id === id);
    if (i < 0) return false;
    const n = this.npcs[i]!;
    this.npcs.splice(i, 1);
    this.world.remove(n.mesh);
    this.physics.world.removeRigidBody(n.body);
    if (n.agent && this.nav) this.nav.removeAgent(n.agent);
    n.agent = null;
    this.disposeVisual(n);
    return true;
  }

  /** The NPC nearest to `point` within `maxDist` metres (horizontal), or null. */
  nearest(point: THREE.Vector3, maxDist: number): Npc | null {
    let best: Npc | null = null;
    let bestD = maxDist;
    for (const n of this.npcs) {
      const d = Math.hypot(n.mesh.position.x - point.x, n.mesh.position.z - point.z);
      if (d <= bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /**
   * Possession (goal.md ACT-3): the player takes over `npc`'s identity and place, and the NPC entity carries on as
   * `identity` from `feet` (where the player stood, facing `yaw`) — an unpossessed actor loiters there like any other.
   * Returns the identity and spot the player now owns. Same call switches back: possess the body that carries you.
   */
  swapIdentity(npc: Npc, identity: NpcSpec, feet: THREE.Vector3, yaw: number): { spec: NpcSpec; position: THREE.Vector3; yaw: number } {
    const was = { spec: npc.spec, position: npc.mesh.position.clone(), yaw: npc.mesh.rotation.y };
    const pos = feet.clone();
    pos.y = this.groundY(pos);
    npc.spec = { ...identity, home: pos.clone() };
    npc.capsule.material.color.setHex(identity.color);
    npc.mesh.name = npc.spec.id;
    npc.mesh.position.copy(pos);
    npc.mesh.rotation.y = yaw;
    npc.facing = yaw;
    npc.faceTarget = null;
    npc.lineIndex = 0;
    npc.body.setTranslation({ x: pos.x, y: pos.y + 0.9, z: pos.z }, true);
    npc.body.setNextKinematicTranslation({ x: pos.x, y: pos.y + 0.9, z: pos.z });
    if (npc.agent && this.nav) {
      this.nav.stop(npc.agent);
      const snapped = this.nav.snap(pos, 3) ?? pos;
      npc.agent.teleport({ x: snapped.x, y: snapped.y, z: snapped.z });
    }
    // A fresh brain, but not a fresh greeting: the body you just stepped out of does not hail you on the spot.
    npc.brain = new NpcBrain({
      home: [pos.x, pos.y, pos.z],
      approaches: identity.approaches ?? false,
      greetDelay: 10,
      random: this.random,
    });
    this.refreshAvatar(npc);
    return was;
  }

  /** Per frame: brains → crowd → meshes/bodies. `paused` (diorama) freezes everyone. */
  update(dt: number, playerFeet: THREE.Vector3, paused = false) {
    if (paused) return;
    this.animationTimeS += dt;
    if (!this.nav) for (const n of this.npcs) n.avatar?.sample(this.animationTimeS, 0, true);
    if (!this.nav) return; // brains wait for the navmesh: a moveTo before the agent exists would be lost
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
      if (n.avatar) {
        const velocity = n.agent ? this.nav.velocity(n.agent, this.tmp2) : this.tmp2.set(0, 0, 0);
        n.mesh.updateWorldMatrix(true, true);
        n.avatar.sample(this.animationTimeS, Math.hypot(velocity.x, velocity.z), true);
      }
    }
  }

  dispose() {
    this.navGen++;
    for (const n of this.npcs) {
      this.world.remove(n.mesh);
      this.physics.world.removeRigidBody(n.body);
      n.agent = null;
      this.disposeVisual(n);
    }
    this.npcs.length = 0;
    this.nav?.dispose();
    this.nav = null;
  }

  get navFailedFlag() {
    return this.navFailed;
  }
}
