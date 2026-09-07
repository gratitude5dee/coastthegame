/**
 * The level as a graph of cells with streaming (goal.md W-3, SCH-1 `transitions`, SCH-2 `level.json`, ADR-0009).
 *
 * Cells share one world frame: `level.json.placements[id].origin` puts each cell's frame in the world, and every
 * transition is a portal AABB authored in the cell's frame on BOTH cells of an edge (the exit on one side, the
 * return on the other). The streamer is pure: given the player's position it says which cell to load, which to
 * drop and when the player has arrived somewhere else — no renderer, no timers, unit-tested.
 */
import type { Level } from './cell';

export type Vec3 = [number, number, number];
/** Axis-aligned box as [min, max]. */
export type Aabb = [Vec3, Vec3];

/** SCH-1 `transitions[]` entry: a doorway in the cell's frame and how far before it the neighbour starts streaming. */
export interface CellTransition {
  to: string;
  portal: Aabb;
  streamAt_m: number;
}

export interface CellPlacement {
  /** World position of the cell's origin (metres). */
  origin: Vec3;
}

/** What the graph needs from each cell (a subset of SCH-1). */
export interface LevelCellInput {
  id: string;
  transitions: CellTransition[];
}

/** A transition in world space, from one cell to another. */
export interface Portal {
  from: string;
  to: string;
  /** World-space doorway (the cell's portal moved by its placement). */
  aabb: Aabb;
  /** Distance (m, XZ) from the doorway at which `to` starts streaming. */
  streamAt: number;
  /** Centre of the doorway's floor. */
  floor: Vec3;
}

export type StreamEvent =
  | { kind: 'load'; cell: string; via: Portal }
  | { kind: 'unload'; cell: string }
  | { kind: 'arrive'; cell: string; from: string; via: Portal };

export interface StreamerOptions {
  /** W-3: the active cell + its nearest neighbour on every tier. */
  residentCells?: number;
  /** How far (m) above/below a portal's box the player may be and still count as inside it. */
  portalSlackY?: number;
}

export function aabbCenter(b: Aabb): Vec3 {
  return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, (b[0][2] + b[1][2]) / 2];
}

/** Distance in the XZ plane from a point to an AABB (0 inside). */
export function distanceToAabbXZ(p: { x: number; z: number }, b: Aabb): number {
  const dx = Math.max(b[0][0] - p.x, 0, p.x - b[1][0]);
  const dz = Math.max(b[0][2] - p.z, 0, p.z - b[1][2]);
  return Math.hypot(dx, dz);
}

/** Inside the box's XZ footprint and within `slackY` of its vertical range. */
export function insideAabb(p: { x: number; y: number; z: number }, b: Aabb, slackY = 0): boolean {
  return p.x >= b[0][0] && p.x <= b[1][0] && p.z >= b[0][2] && p.z <= b[1][2] && p.y >= b[0][1] - slackY && p.y <= b[1][1] + slackY;
}

export function translateAabb(b: Aabb, o: Vec3): Aabb {
  return [
    [b[0][0] + o[0], b[0][1] + o[1], b[0][2] + o[2]],
    [b[1][0] + o[0], b[1][1] + o[1], b[1][2] + o[2]],
  ];
}

export class LevelGraph {
  readonly id: string;
  readonly hub: string;
  readonly cells: string[];
  private readonly origins = new Map<string, Vec3>();
  private readonly exits = new Map<string, Portal[]>();

  /**
   * Builds the world-space graph. Throws on a malformed level: an edge to an unknown cell, a cell without a
   * placement, or an edge that only one of its two cells knows about (arrival needs the return portal).
   */
  constructor(level: Level, cells: Record<string, LevelCellInput>) {
    this.id = level.id;
    this.hub = level.hub;
    this.cells = [...level.cells];
    for (const id of level.cells) {
      if (!cells[id]) throw new Error(`level ${level.id}: cell ${id} has no definition`);
      const placement = level.placements?.[id];
      this.origins.set(id, placement ? [...placement.origin] : [0, 0, 0]);
      this.exits.set(id, []);
    }
    if (!this.origins.has(level.hub)) throw new Error(`level ${level.id}: hub ${level.hub} is not one of its cells`);
    for (const [a, b] of level.edges) {
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const) {
        const cell = cells[from];
        if (!cell || !this.origins.has(from) || !this.origins.has(to))
          throw new Error(`level ${level.id}: edge ${a}–${b} names an unknown cell`);
        const t = cell.transitions.find((x) => x.to === to);
        if (!t) throw new Error(`level ${level.id}: cell ${from} has no transition to ${to} (edges need a portal on both sides)`);
        const aabb = translateAabb(t.portal, this.origins.get(from)!);
        const c = aabbCenter(aabb);
        this.exits.get(from)!.push({ from, to, aabb, streamAt: t.streamAt_m, floor: [c[0], aabb[0][1], c[2]] });
      }
    }
  }

  origin(id: string): Vec3 {
    const o = this.origins.get(id);
    if (!o) throw new Error(`unknown cell ${id}`);
    return o;
  }

  has(id: string) {
    return this.origins.has(id);
  }

  /** Cell-frame point → world. */
  toWorld(id: string, p: Vec3): Vec3 {
    const o = this.origin(id);
    return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
  }

  /** Every portal leading out of `from`. */
  exitsOf(from: string): Portal[] {
    return this.exits.get(from) ?? [];
  }

  portal(from: string, to: string): Portal | undefined {
    return this.exitsOf(from).find((p) => p.to === to);
  }

  neighbours(id: string): string[] {
    return this.exitsOf(id).map((p) => p.to);
  }
}

/**
 * Decides residency from the player's position (W-3): load a neighbour when the player is within `streamAt` of the
 * portal that leads to it; keep at most `residentCells` cells by evicting the resident cell whose portal is farthest
 * from the player (never the active one, never the one just requested); arrive when the player stands in a loaded
 * neighbour's return portal. Nothing here happens on a timer — the same walk always produces the same events.
 */
export class CellStreamer {
  active: string;
  readonly residentCells: number;
  private readonly slackY: number;
  private readonly resident: string[] = [];
  private readonly loaded = new Set<string>();

  constructor(
    readonly graph: LevelGraph,
    active: string,
    opts: StreamerOptions = {},
  ) {
    if (!graph.has(active)) throw new Error(`unknown cell ${active}`);
    this.active = active;
    this.residentCells = Math.max(1, opts.residentCells ?? 2);
    this.slackY = opts.portalSlackY ?? 2;
    this.resident.push(active);
  }

  /** Resident cells in load order (the active cell included); loading and loaded alike. */
  get residentIds(): readonly string[] {
    return this.resident;
  }

  isResident(id: string) {
    return this.resident.includes(id);
  }

  isLoaded(id: string) {
    return this.loaded.has(id);
  }

  /** The host reports a cell's world + ground as ready; arrival into it is possible from then on. */
  markLoaded(id: string) {
    if (this.resident.includes(id)) this.loaded.add(id);
  }

  /** The closest exit of the active cell — for the HUD ("→ street · 12 m"). */
  nearest(pos: { x: number; z: number }): { portal: Portal; distance: number } | null {
    let best: { portal: Portal; distance: number } | null = null;
    for (const portal of this.graph.exitsOf(this.active)) {
      const distance = distanceToAabbXZ(pos, portal.aabb);
      if (!best || distance < best.distance) best = { portal, distance };
    }
    return best;
  }

  update(pos: { x: number; y: number; z: number }): StreamEvent[] {
    const events: StreamEvent[] = [];
    // Arrival: standing in a loaded neighbour's return doorway.
    for (const exit of this.graph.exitsOf(this.active)) {
      if (!this.loaded.has(exit.to)) continue;
      const back = this.graph.portal(exit.to, this.active)!;
      if (insideAabb(pos, back.aabb, this.slackY)) {
        const from = this.active;
        this.active = exit.to;
        events.push({ kind: 'arrive', cell: exit.to, from, via: back });
        break;
      }
    }
    // Streaming: the neighbour behind the nearest close-enough exit.
    let want: Portal | null = null;
    let wantD = Infinity;
    for (const exit of this.graph.exitsOf(this.active)) {
      if (this.resident.includes(exit.to)) continue;
      const d = distanceToAabbXZ(pos, exit.aabb);
      if (d <= exit.streamAt && d < wantD) {
        want = exit;
        wantD = d;
      }
    }
    if (want) {
      while (this.resident.length >= this.residentCells) {
        const victim = this.farthest(pos, want.to);
        if (!victim) break;
        this.drop(victim);
        events.push({ kind: 'unload', cell: victim });
      }
      this.resident.push(want.to);
      events.push({ kind: 'load', cell: want.to, via: want });
    }
    return events;
  }

  /** Drop a cell (the host failed to load it, or a scene reset). */
  drop(id: string) {
    const i = this.resident.indexOf(id);
    if (i >= 0) this.resident.splice(i, 1);
    this.loaded.delete(id);
  }

  private farthest(pos: { x: number; z: number }, keep: string): string | null {
    let victim: string | null = null;
    let far = -1;
    for (const id of this.resident) {
      if (id === this.active || id === keep) continue;
      const portal = this.graph.portal(this.active, id);
      const d = portal ? distanceToAabbXZ(pos, portal.aabb) : Infinity;
      if (d > far) {
        far = d;
        victim = id;
      }
    }
    return victim;
  }
}
