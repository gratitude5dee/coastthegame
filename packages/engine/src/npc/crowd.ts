/**
 * NPC navigation (goal.md PHY-4): a Recast navmesh baked at runtime from the walkable geometry (the cell collider, or
 * the splat-derived ground grid on sample worlds) and a Detour crowd that steers the NPCs with avoidance. Recast's
 * WASM is loaded on demand like Rapier (QB-3). Agents are plain positions; the game owns the meshes and the brains.
 */
import * as THREE from 'three';
import type { Crowd, CrowdAgent, NavMesh, NavMeshQuery } from 'recast-navigation';

type Recast = typeof import('recast-navigation');
type Generators = typeof import('recast-navigation/generators');

let recastPromise: Promise<{ core: Recast; gen: Generators }> | null = null;
/** Loads + initialises Recast's WASM once (dynamic import keeps it out of the boot chunk, QB-3). */
export function loadRecast() {
  if (!recastPromise) {
    recastPromise = Promise.all([import('recast-navigation'), import('recast-navigation/generators')]).then(async ([core, gen]) => {
      await core.init();
      return { core, gen };
    });
  }
  return recastPromise;
}

/** Flatten meshes into one world-space soup (positions + indices) — what the generator eats. */
export function meshesToSoup(meshes: THREE.Mesh[]): { positions: Float32Array; indices: Uint32Array } {
  const pos: number[] = [];
  const idx: number[] = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    m.updateWorldMatrix(true, false);
    const g = m.geometry;
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      pos.push(v.x, v.y, v.z);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) idx.push(base + i);
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

export interface NavOptions {
  /** Agent radius / height / climb / slope, metres and degrees (converted to Recast voxels). */
  agentRadius?: number;
  agentHeight?: number;
  agentClimb?: number;
  slopeDeg?: number;
  cellSize?: number;
  cellHeight?: number;
  bounds?: [[number, number, number], [number, number, number]];
}

export class NpcNav {
  readonly navMesh: NavMesh;
  readonly query: NavMeshQuery;
  readonly crowd: Crowd;
  readonly agents: CrowdAgent[] = [];
  private readonly tmp = new THREE.Vector3();

  private constructor(
    private readonly core: Recast,
    navMesh: NavMesh,
    maxAgents: number,
  ) {
    this.navMesh = navMesh;
    this.query = new core.NavMeshQuery(navMesh);
    this.crowd = new core.Crowd(navMesh, { maxAgents, maxAgentRadius: 0.6 });
  }

  /** Bake a navmesh from walkable meshes (world-space matrices are honoured). Throws when Recast rejects the input. */
  static async build(meshes: THREE.Mesh[], opts: NavOptions = {}, maxAgents = 16): Promise<NpcNav> {
    const { core, gen } = await loadRecast();
    const cs = opts.cellSize ?? 0.35;
    const ch = opts.cellHeight ?? 0.2;
    const { positions, indices } = meshesToSoup(meshes);
    const result = gen.generateSoloNavMesh(positions, indices, {
      cs,
      ch,
      walkableSlopeAngle: opts.slopeDeg ?? 50,
      walkableHeight: Math.ceil((opts.agentHeight ?? 1.8) / ch),
      walkableClimb: Math.ceil((opts.agentClimb ?? 0.5) / ch),
      walkableRadius: Math.ceil((opts.agentRadius ?? 0.4) / cs),
      maxEdgeLen: 12,
      minRegionArea: 8,
      mergeRegionArea: 20,
      ...(opts.bounds ? { bounds: opts.bounds } : {}),
    });
    if (!result.success) throw new Error(`navmesh: ${result.error}`);
    return new NpcNav(core, result.navMesh, maxAgents);
  }

  /** Nearest walkable point to a world position (null when the navmesh has nothing within `halfExtents`). */
  snap(p: THREE.Vector3, halfExtents = 2): THREE.Vector3 | null {
    const r = this.query.findClosestPoint({ x: p.x, y: p.y, z: p.z }, { halfExtents: { x: halfExtents, y: halfExtents, z: halfExtents } });
    return r.success ? new THREE.Vector3(r.point.x, r.point.y, r.point.z) : null;
  }

  addAgent(position: THREE.Vector3, params: { radius?: number; height?: number; maxSpeed?: number } = {}): CrowdAgent | null {
    const start = this.snap(position, 3) ?? position;
    const agent = this.crowd.addAgent(
      { x: start.x, y: start.y, z: start.z },
      {
        radius: params.radius ?? 0.35,
        height: params.height ?? 1.7,
        maxSpeed: params.maxSpeed ?? 1.4,
        maxAcceleration: 6,
        collisionQueryRange: 2.5,
        pathOptimizationRange: 8,
        separationWeight: 1.5,
      },
    );
    this.agents.push(agent);
    return agent;
  }

  /** Ask an agent to walk to a world point (snapped to the navmesh). Returns false when unreachable. */
  moveTo(agent: CrowdAgent, target: THREE.Vector3): boolean {
    const p = this.snap(target, 3);
    if (!p) return false;
    return agent.requestMoveTarget({ x: p.x, y: p.y, z: p.z });
  }

  stop(agent: CrowdAgent) {
    agent.resetMoveTarget();
  }

  /** Whether the agent is (nearly) still: no target or within 0.4 m of it with little velocity. */
  arrived(agent: CrowdAgent): boolean {
    const v = agent.velocity();
    return Math.hypot(v.x, v.z) < 0.05;
  }

  /** Agent position after the last sub-step (Detour's own `interpolatedPosition` stalls when the step divides evenly). */
  position(agent: CrowdAgent, out = new THREE.Vector3()): THREE.Vector3 {
    const p = agent.position();
    return out.set(p.x, p.y, p.z);
  }

  velocity(agent: CrowdAgent, out = new THREE.Vector3()): THREE.Vector3 {
    const v = agent.velocity();
    return out.set(v.x, v.y, v.z);
  }

  /** Step the crowd: fixed 60 Hz sub-steps (≤ 5 per frame) so agents move the same at any frame rate. */
  update(dt: number) {
    this.crowd.update(1 / 60, Math.min(dt, 0.25), 5);
  }

  /** A random walkable point within `radius` of `center`. */
  randomAround(center: THREE.Vector3, radius: number): THREE.Vector3 | null {
    const r = this.query.findRandomPointAroundCircle({ x: center.x, y: center.y, z: center.z }, radius);
    return r.success ? this.tmp.set(r.randomPoint.x, r.randomPoint.y, r.randomPoint.z).clone() : null;
  }

  dispose() {
    this.crowd.destroy();
    this.query.destroy();
    this.navMesh.destroy();
  }
}
