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

  /** Static ground from a height grid (goal.md PHY-1 fallback for cells without a collider). Returns the collider + a debug geometry. */
  addGroundGrid(grid: GroundGrid): { collider: RAPIER_NS.Collider; geometry: THREE.BufferGeometry } {
    const geometry = groundGridGeometry(grid);
    const collider = this.addStaticTrimesh(geometry);
    return { collider, geometry };
  }

  /**
   * Invisible walls around a ground grid (PHY-1 sample worlds / cells without a collider): four static cuboids rising
   * `height` m above the highest ground vertex, so the car and the character stay on the block. Cell graphs replace
   * this with streaming transitions (W-3).
   */
  addFence(grid: GroundGrid, height = 4): RAPIER_NS.Collider[] {
    let top = -Infinity;
    let bottom = Infinity;
    for (let i = 0; i < grid.heights.length; i++) {
      const h = grid.heights[i]!;
      if (h > top) top = h;
      if (h < bottom) bottom = h;
    }
    if (!Number.isFinite(top)) top = bottom = 0;
    const minX = grid.minX;
    const minZ = grid.minZ;
    const maxX = grid.minX + (grid.cols - 1) * grid.cellSize;
    const maxZ = grid.minZ + (grid.rows - 1) * grid.cellSize;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const hx = (maxX - minX) / 2;
    const hz = (maxZ - minZ) / 2;
    const hy = (top + height - bottom) / 2 + 1;
    const cy = (top + height + bottom) / 2 - 1;
    const t = 0.25; // wall half thickness
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    const walls: [number, number, number, number, number][] = [
      [cx, minZ - t, hx + t, hy, t],
      [cx, maxZ + t, hx + t, hy, t],
      [minX - t, cz, t, hy, hz + t],
      [maxX + t, cz, t, hy, hz + t],
    ];
    return walls.map(([x, z, ex, ey, ez]) =>
      this.world.createCollider(this.R.ColliderDesc.cuboid(ex, ey, ez).setTranslation(x, cy, z).setFriction(0.2), body),
    );
  }

  dispose() {
    this.world.free();
  }
}

/** Builds an indexed grid mesh (Y-up) from a height grid — shared by the collider and the debug wireframe. */
export function groundGridGeometry(grid: GroundGrid): THREE.BufferGeometry {
  const { heights, cols, rows, minX, minZ, cellSize } = grid;
  const positions = new Float32Array(cols * rows * 3);
  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      const i = z * cols + x;
      positions[i * 3] = minX + x * cellSize;
      positions[i * 3 + 1] = heights[i] ?? 0;
      positions[i * 3 + 2] = minZ + z * cellSize;
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
