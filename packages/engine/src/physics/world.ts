/**
 * Physics world (goal.md PHY-1, STU-1): Rapier loaded on demand (QB-3), fixed 60 Hz stepping with an accumulator and
 * render interpolation alpha. Export/replay never re-simulates — poses are authoritative (ACT-2); this stepper is for play.
 */
import type * as RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export type Rapier = typeof RAPIER_NS;

let rapierPromise: Promise<Rapier> | null = null;
/** Loads + initialises the Rapier WASM once (dynamic import keeps it out of the boot chunk). */
export function loadRapier(): Promise<Rapier> {
  if (!rapierPromise) {
    rapierPromise = import('@dimforge/rapier3d-compat').then(async (R) => {
      await R.init();
      return R as unknown as Rapier;
    });
  }
  return rapierPromise;
}

export interface GroundGrid {
  /** Heights at grid vertices, row-major: index = z * cols + x. */
  heights: Float32Array;
  cols: number;
  rows: number;
  minX: number;
  minZ: number;
  cellSize: number;
  /** World-space rect of the cells that had real samples (the rest is hole-filled); the fence hugs this when present. */
  coverage?: { minX: number; minZ: number; maxX: number; maxZ: number };
  /** How many cells had real samples (diagnostics: 0 = the estimator saw no splats). */
  sampled?: number;
}

export class PhysicsWorld {
  readonly world: RAPIER_NS.World;
  readonly fixedDt = 1 / 60;
  private accumulator = 0;
  /** Interpolation factor for rendering between the last two fixed steps (0..1). */
  alpha = 0;
  stepCount = 0;

  constructor(
    readonly R: Rapier,
    gravity = -9.81,
  ) {
    this.world = new R.World({ x: 0, y: gravity, z: 0 });
    this.world.timestep = this.fixedDt;
  }

  /**
   * Advance by a variable frame dt using fixed steps (max 5 per frame to survive tab switches).
   * `onStep` runs before each fixed step (character controllers, kinematic bodies).
   */
  step(dtSeconds: number, onStep: (dt: number) => void): number {
    this.accumulator += Math.min(dtSeconds, 0.25);
    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < 5) {
      onStep(this.fixedDt);
      this.world.step();
      this.accumulator -= this.fixedDt;
      steps++;
      this.stepCount++;
    }
    if (steps === 5) this.accumulator = 0; // dropped time — never spiral
    this.alpha = this.accumulator / this.fixedDt;
    return steps;
  }

  /** Static trimesh collider from a three.js geometry (indexed or not) with an optional world matrix. */
  addStaticTrimesh(geometry: THREE.BufferGeometry, matrixWorld?: THREE.Matrix4): RAPIER_NS.Collider {
    const geo = geometry.index ? geometry : geometry.toNonIndexed();
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const vertices = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (matrixWorld) v.applyMatrix4(matrixWorld);
      vertices[i * 3] = v.x;
      vertices[i * 3 + 1] = v.y;
      vertices[i * 3 + 2] = v.z;
    }
    let indices: Uint32Array;
    if (geo.index) indices = new Uint32Array(geo.index.array as ArrayLike<number>);
    else {
      indices = new Uint32Array(pos.count);
      for (let i = 0; i < pos.count; i++) indices[i] = i;
    }
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    return this.world.createCollider(this.R.ColliderDesc.trimesh(vertices, indices), body);
  }

  /**
   * Static ground from a height grid (goal.md PHY-1 fallback for cells without a collider), optionally only the part
   * inside `rect` (the fence rectangle: beyond the scan's coverage the grid is hole-filled guesswork, and a phantom
   * floor there would reach into a neighbouring cell, W-3). Returns the collider + a debug geometry.
   */
  addGroundGrid(grid: GroundGrid, rect?: XZRect): { collider: RAPIER_NS.Collider; geometry: THREE.BufferGeometry } {
    const geometry = groundGridGeometry(grid, rect);
    const collider = this.addStaticTrimesh(geometry);
    return { collider, geometry };
  }

  /**
   * Invisible walls around a ground grid (PHY-1 sample worlds / cells without a collider): static cuboids rising
   * `height` m above the highest ground vertex, so the car and the character stay on the block. Where a cell graph
   * joins this cell to a neighbour (W-3), pass the transition's footprint as an `opening` and the wall leaves a gap
   * there. Returns the colliders (one fixed body) so a streamed cell can take its fence with it.
   */
  addFence(grid: GroundGrid, height = 4, margin = 1.5, openings: XZRect[] = []): RAPIER_NS.Collider[] {
    let top = -Infinity;
    let bottom = Infinity;
    for (let i = 0; i < grid.heights.length; i++) {
      const h = grid.heights[i]!;
      if (h > top) top = h;
      if (h < bottom) bottom = h;
    }
    if (!Number.isFinite(top)) top = bottom = 0;
    const rect = fenceRect(grid, margin);
    const hy = (top + height - bottom) / 2 + 1;
    const cy = (top + height + bottom) / 2 - 1;
    const t = 0.25; // wall half thickness
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    return fenceWalls(rect, openings, t).map((w) =>
      this.world.createCollider(this.R.ColliderDesc.cuboid(w.ex, hy, w.ez).setTranslation(w.x, cy, w.z).setFriction(0.2), body),
    );
  }

  /** A static, optionally rotated box (transition floors, curbs, gates). */
  addStaticBox(center: THREE.Vector3, halfExtents: THREE.Vector3, quaternion?: THREE.Quaternion, friction = 0.9): RAPIER_NS.Collider {
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    const desc = this.R.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setTranslation(center.x, center.y, center.z)
      .setFriction(friction);
    if (quaternion) desc.setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });
    return this.world.createCollider(desc, body);
  }

  /** Remove colliders (and their fixed bodies once empty) — a streamed cell leaving the world. */
  removeColliders(colliders: RAPIER_NS.Collider[]) {
    const bodies = new Set<RAPIER_NS.RigidBody>();
    for (const c of colliders) {
      const body = c.parent();
      if (body) bodies.add(body);
      this.world.removeCollider(c, false);
    }
    for (const body of bodies) if (body.numColliders() === 0) this.world.removeRigidBody(body);
  }

  dispose() {
    this.world.free();
  }
}

/**
 * Builds an indexed grid mesh (Y-up) from a height grid — shared by the collider and the debug wireframe. With `rect`,
 * only the vertices inside it (grown by one cell so the fence line is covered) are built.
 */
export function groundGridGeometry(grid: GroundGrid, rect?: XZRect): THREE.BufferGeometry {
  const { heights, minX, minZ, cellSize } = grid;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const x0 = rect ? clamp(Math.floor((rect.minX - minX) / cellSize) - 1, 0, grid.cols - 2) : 0;
  const x1 = rect ? clamp(Math.ceil((rect.maxX - minX) / cellSize) + 1, x0 + 1, grid.cols - 1) : grid.cols - 1;
  const z0 = rect ? clamp(Math.floor((rect.minZ - minZ) / cellSize) - 1, 0, grid.rows - 2) : 0;
  const z1 = rect ? clamp(Math.ceil((rect.maxZ - minZ) / cellSize) + 1, z0 + 1, grid.rows - 1) : grid.rows - 1;
  const cols = x1 - x0 + 1;
  const rows = z1 - z0 + 1;
  const positions = new Float32Array(cols * rows * 3);
  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      const i = z * cols + x;
      positions[i * 3] = minX + (x0 + x) * cellSize;
      positions[i * 3 + 1] = heights[(z0 + z) * grid.cols + (x0 + x)] ?? 0;
      positions[i * 3 + 2] = minZ + (z0 + z) * cellSize;
    }
  }
  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let z = 0; z < rows - 1; z++) {
    for (let x = 0; x < cols - 1; x++) {
      const a = z * cols + x;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

export interface XZRect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface FenceWall {
  x: number;
  z: number;
  ex: number;
  ez: number;
}

/** The rectangle a fence hugs: the scan's coverage plus a margin, clamped to the grid. */
export function fenceRect(grid: GroundGrid, margin = 1.5): XZRect {
  const gridMaxX = grid.minX + (grid.cols - 1) * grid.cellSize;
  const gridMaxZ = grid.minZ + (grid.rows - 1) * grid.cellSize;
  const c = grid.coverage;
  return {
    minX: c ? Math.max(grid.minX, c.minX - margin) : grid.minX,
    minZ: c ? Math.max(grid.minZ, c.minZ - margin) : grid.minZ,
    maxX: c ? Math.min(gridMaxX, c.maxX + margin) : gridMaxX,
    maxZ: c ? Math.min(gridMaxZ, c.maxZ + margin) : gridMaxZ,
  };
}

/**
 * Wall segments (centre + half extents in XZ) for the four sides of `rect`, thickness `t`, minus every `opening`
 * that crosses a side: an opening that overlaps a wall's plane cuts its span out of that wall. Pure, so a cell
 * graph's doorways can be checked without a physics world.
 */
export function fenceWalls(rect: XZRect, openings: XZRect[] = [], t = 0.25): FenceWall[] {
  const walls: FenceWall[] = [];
  const spans = (from: number, to: number, cuts: [number, number][]): [number, number][] => {
    let pieces: [number, number][] = [[from, to]];
    for (const [c0, c1] of cuts) {
      const next: [number, number][] = [];
      for (const [a, b] of pieces) {
        if (c1 <= a || c0 >= b) next.push([a, b]);
        else {
          if (c0 > a) next.push([a, c0]);
          if (c1 < b) next.push([c1, b]);
        }
      }
      pieces = next;
    }
    return pieces.filter(([a, b]) => b - a > 0.05);
  };
  // Sides along X (at minZ / maxZ) and along Z (at minX / maxX); an opening cuts a side when it reaches its plane.
  const sides: { axis: 'x' | 'z'; at: number; outward: -1 | 1 }[] = [
    { axis: 'x', at: rect.minZ, outward: -1 },
    { axis: 'x', at: rect.maxZ, outward: 1 },
    { axis: 'z', at: rect.minX, outward: -1 },
    { axis: 'z', at: rect.maxX, outward: 1 },
  ];
  for (const side of sides) {
    const along = side.axis === 'x' ? [rect.minX - t, rect.maxX + t] : [rect.minZ - t, rect.maxZ + t];
    const cuts: [number, number][] = [];
    for (const o of openings) {
      const reaches = side.axis === 'x' ? o.minZ <= side.at + t && o.maxZ >= side.at - t : o.minX <= side.at + t && o.maxX >= side.at - t;
      if (reaches) cuts.push(side.axis === 'x' ? [o.minX, o.maxX] : [o.minZ, o.maxZ]);
    }
    for (const [a, b] of spans(along[0]!, along[1]!, cuts)) {
      const mid = (a + b) / 2;
      const half = (b - a) / 2;
      const off = side.at + side.outward * t;
      walls.push(side.axis === 'x' ? { x: mid, z: off, ex: half, ez: t } : { x: off, z: mid, ex: t, ez: half });
    }
  }
  return walls;
}

/**
 * Flattest spot on a ring around `center` (radii in m) for a footprint of `halfX` × `halfZ` m — where to park a car so
 * it does not spawn half-inside a hillside. Scores each candidate by the height range under the footprint (lower is
 * flatter); returns the best candidate and its score. Falls back to `center` when nothing is inside the grid.
 */
export function flattestSpot(
  grid: GroundGrid,
  center: THREE.Vector3,
  radiusMin: number,
  radiusMax: number,
  halfX = 2.5,
  halfZ = 2.5,
  angles = 16,
): { position: THREE.Vector3; range: number } {
  const maxX = grid.minX + (grid.cols - 1) * grid.cellSize;
  const maxZ = grid.minZ + (grid.rows - 1) * grid.cellSize;
  const inside = (x: number, z: number) => x >= grid.minX && x <= maxX && z >= grid.minZ && z <= maxZ;
  let best: { position: THREE.Vector3; range: number } | null = null;
  const step = Math.max(grid.cellSize, 0.5);
  for (let r = radiusMin; r <= radiusMax + 1e-6; r += Math.max(1, (radiusMax - radiusMin) / 3)) {
    for (let a = 0; a < angles; a++) {
      const t = (a / angles) * Math.PI * 2;
      const cx = center.x + Math.sin(t) * r;
      const cz = center.z + Math.cos(t) * r;
      if (!inside(cx - halfX, cz - halfZ) || !inside(cx + halfX, cz + halfZ)) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (let x = cx - halfX; x <= cx + halfX + 1e-6; x += step) {
        for (let z = cz - halfZ; z <= cz + halfZ + 1e-6; z += step) {
          const h = groundHeightAt(grid, x, z);
          if (h < lo) lo = h;
          if (h > hi) hi = h;
        }
      }
      const range = hi - lo;
      if (!best || range < best.range) best = { position: new THREE.Vector3(cx, groundHeightAt(grid, cx, cz), cz), range };
    }
  }
  return best ?? { position: new THREE.Vector3(center.x, groundHeightAt(grid, center.x, center.z), center.z), range: 0 };
}

/** Bilinear height lookup on a ground grid (world XZ → Y), clamped to the grid. */
export function groundHeightAt(grid: GroundGrid, x: number, z: number): number {
  const fx = THREE.MathUtils.clamp((x - grid.minX) / grid.cellSize, 0, grid.cols - 1.0001);
  const fz = THREE.MathUtils.clamp((z - grid.minZ) / grid.cellSize, 0, grid.rows - 1.0001);
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;
  const h = (xx: number, zz: number) => grid.heights[zz * grid.cols + xx] ?? 0;
  const top = h(x0, z0) * (1 - tx) + h(x0 + 1, z0) * tx;
  const bot = h(x0, z0 + 1) * (1 - tx) + h(x0 + 1, z0 + 1) * tx;
  return top * (1 - tz) + bot * tz;
}
