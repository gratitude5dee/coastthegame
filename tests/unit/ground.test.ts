import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { SplatMesh } from '@sparkjsdev/spark';
import { groundFromSplats } from '../../packages/engine/src/world/ground';
import { groundHeightAt } from '../../packages/engine/src/physics/world';

/**
 * goal.md PHY-1 fallback: the ground grid comes from a low percentile of splat heights per cell. A fake SplatMesh feeds
 * synthetic splats through the same `forEachSplat` contract (the LoD source resolution is exercised by the `lodSplats`
 * branch). The valley regression: terrain with >6 m of relief must keep its floor while sky blobs are dropped.
 */
type Splat = { c: THREE.Vector3; s: number; o: number };
function fakeMesh(splats: Splat[], opts: { lod?: boolean; matrix?: THREE.Matrix4 } = {}): SplatMesh {
  const forEachSplat = (cb: (i: number, c: THREE.Vector3, sc: THREE.Vector3, q: THREE.Quaternion, o: number, col: THREE.Color) => void) => {
    const sc = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    splats.forEach((sp, i) => cb(i, sp.c, sc.setScalar(sp.s), q, sp.o, col));
  };
  const matrixWorld = opts.matrix ?? new THREE.Matrix4();
  const mesh = {
    matrixWorld,
    scale: new THREE.Vector3(1, 1, 1),
    updateMatrixWorld: () => {},
    forEachSplat: opts.lod ? () => {} : forEachSplat, // with LoD the base set is empty, like Spark
    packedSplats: opts.lod ? { lodSplats: { forEachSplat } } : undefined,
    extSplats: undefined,
  };
  return mesh as unknown as SplatMesh;
}

/** Terrain z ∈ [−20, 20]: floor at y = 0.5·z (−10 … +10, 20 m of relief), 6 splats per 0.5 m step, plus grass above. */
function terrain(): Splat[] {
  const out: Splat[] = [];
  for (let x = -20; x <= 20; x += 0.5) {
    for (let z = -20; z <= 20; z += 0.5) {
      const floor = 0.5 * z;
      for (let k = 0; k < 6; k++)
        out.push({ c: new THREE.Vector3(x + (k % 3) * 0.1, floor + k * 0.15, z + Math.floor(k / 3) * 0.1), s: 0.05, o: 0.9 });
    }
  }
  return out;
}

describe('groundFromSplats', () => {
  it('keeps a sloping floor with 20 m of relief and rejects sky blobs above it', () => {
    const splats = terrain();
    // Sky: a dense cluster 25 m up over a few cells (would be "ground" for those cells without the outlier test).
    for (let k = 0; k < 40; k++)
      splats.push({ c: new THREE.Vector3(3 + (k % 5) * 0.1, 25 + (k % 7) * 0.05, -10 + Math.floor(k / 5) * 0.1), s: 0.05, o: 0.9 });
    const grid = groundFromSplats(fakeMesh(splats, { lod: true }), { halfExtent: 20, cellSize: 0.75 });
    expect(grid.sampled!).toBeGreaterThan(2000);
    for (const z of [-15, -5, 0, 5, 15]) expect(groundHeightAt(grid, 0, z)).toBeCloseTo(0.5 * z, 0); // within ±0.5 m
    expect(groundHeightAt(grid, 3.2, -9.8)).toBeLessThan(0); // the sky cluster did not become the ground
    expect(grid.coverage!.minZ).toBeLessThan(-18);
    expect(grid.coverage!.maxZ).toBeGreaterThan(18);
  });

  it('reads the LoD set when the base set is empty (Spark moves the data with lod: true)', () => {
    const noLod = groundFromSplats(fakeMesh(terrain(), { lod: false }), { halfExtent: 10, cellSize: 1 });
    const lod = groundFromSplats(fakeMesh(terrain(), { lod: true }), { halfExtent: 10, cellSize: 1 });
    expect(lod.sampled).toBe(noLod.sampled);
    expect(groundHeightAt(lod, 2, 4)).toBeCloseTo(groundHeightAt(noLod, 2, 4), 6);
  });

  it('applies the mesh world matrix (rotate, never mirror) and ignores oversized / transparent splats', () => {
    const rot = new THREE.Matrix4().makeRotationX(Math.PI).scale(new THREE.Vector3(0.5, 0.5, 0.5)); // Spark sample convention
    const splats: Splat[] = [];
    for (let x = -10; x <= 10; x += 0.5)
      for (let z = -10; z <= 10; z += 0.5) splats.push({ c: new THREE.Vector3(x, -4, z), s: 0.05, o: 0.9 }); // y = −4 local → +2 world
    for (let x = -10; x <= 10; x += 0.5) splats.push({ c: new THREE.Vector3(x, -8, 0), s: 2, o: 0.9 }); // huge blobs: skipped
    for (let x = -10; x <= 10; x += 0.5) splats.push({ c: new THREE.Vector3(x, -12, 2), s: 0.05, o: 0.1 }); // ghosts: skipped
    const mesh = fakeMesh(splats, { matrix: rot });
    (mesh as unknown as { scale: THREE.Vector3 }).scale.setScalar(0.5);
    const grid = groundFromSplats(mesh, { halfExtent: 6, cellSize: 0.5 });
    expect(groundHeightAt(grid, 0, 0)).toBeCloseTo(2, 1);
    expect(groundHeightAt(grid, 2, -1)).toBeCloseTo(2, 1);
  });
});
