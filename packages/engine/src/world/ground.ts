/**
 * Ground estimation from a Gaussian splat (goal.md PHY-1/PHY-5 fallback): for cells without a collider mesh
 * (Spark sample worlds, raw phone scans) we derive a walkable height grid from the splats themselves —
 * a low percentile of splat heights per XZ cell approximates the ground surface; empty cells are filled from
 * neighbours and the grid is lightly smoothed. Marble cells use their exported collider GLB instead (W-2).
 */
import * as THREE from 'three';
import type { SplatMesh } from '@sparkjsdev/spark';
import type { GroundGrid } from '../physics/world';

export interface GroundOptions {
  /** Half-size of the square region around `center` to cover, in metres. */
  halfExtent?: number;
  cellSize?: number;
  /** Which percentile of per-cell splat heights counts as ground (0.05–0.15 works for scans). */
  percentile?: number;
  minOpacity?: number;
  /** Ignore splats larger than this (sky/background blobs). */
  maxScale?: number;
  center?: THREE.Vector3;
  /** Discard cells whose ground is farther than this from their neighbourhood's median (sky, floating debris). */
  maxDeviation?: number;
}

/**
 * Where the splats actually live: with `lod: true` Spark moves the data into `packedSplats.lodSplats` (the LoD tree —
 * leaves plus merged parents) and the base set reports 0 splats, so `mesh.forEachSplat` iterates nothing. The merged
 * parents are large and get dropped by `maxScale`.
 */
function splatSource(splat: SplatMesh): Pick<SplatMesh, 'forEachSplat'> {
  return splat.packedSplats?.lodSplats ?? splat.extSplats?.lodSplats ?? splat;
}

/** Number of splats the ground estimator will see (0 means the mesh is not loaded yet or the LoD data moved). */
export function countSplats(splat: SplatMesh): number {
  let n = 0;
  splatSource(splat).forEachSplat(() => n++);
  return n;
}

/**
 * Whether the estimator would see any splats right now — cheap (no iteration). With `lod: true`, `onLoad` can fire
 * before the LoD tree exists and the base set reads 0 until the data moves into `lodSplats`; a ground derived in
 * that window is empty, so callers wait for this (W-3 streamed cells, scene switches with Rapier already loaded).
 */
export function splatsReady(splat: SplatMesh): boolean {
  const src = splatSource(splat) as { numSplats?: number };
  return (src.numSplats ?? 0) > 0;
}

export function groundFromSplats(splat: SplatMesh, opts: GroundOptions = {}): GroundGrid {
  const halfExtent = opts.halfExtent ?? 24;
  const cellSize = opts.cellSize ?? 0.75;
  const percentile = opts.percentile ?? 0.08;
  const minOpacity = opts.minOpacity ?? 0.35;
  const maxScale = opts.maxScale ?? 0.6;
  const center = opts.center ?? new THREE.Vector3();
  const maxDeviation = opts.maxDeviation ?? 5;

  const cols = Math.max(2, Math.round((halfExtent * 2) / cellSize) + 1);
  const rows = cols;
  const minX = center.x - halfExtent;
  const minZ = center.z - halfExtent;

  splat.updateMatrixWorld(true);
  const m = splat.matrixWorld;
  const buckets: number[][] = new Array(cols * rows);
  const p = new THREE.Vector3();
  splatSource(splat).forEachSplat((_i, c, scales, _q, opacity) => {
    if (opacity < minOpacity) return;
    const s = Math.max(scales.x, scales.y, scales.z) * splat.scale.x;
    if (s > maxScale) return;
    p.copy(c).applyMatrix4(m);
    const gx = Math.round((p.x - minX) / cellSize);
    const gz = Math.round((p.z - minZ) / cellSize);
    if (gx < 0 || gz < 0 || gx >= cols || gz >= rows) return;
    const idx = gz * cols + gx;
    (buckets[idx] ??= []).push(p.y);
  });

  const heights = new Float32Array(cols * rows).fill(Number.NaN);
  const samples: number[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (!b || b.length < 4) continue;
    b.sort((a, c) => a - c);
    const h = b[Math.min(b.length - 1, Math.floor(b.length * percentile))]!;
    heights[i] = h;
    samples.push(h);
  }
  samples.sort((a, b) => a - b);
  const median = samples.length ? samples[Math.floor(samples.length / 2)]! : 0;
  // Outliers (sky, floating debris) are judged against the LOCAL neighbourhood, not the whole scan: real terrain can
  // rise 10+ m across a block (the valley sample does), and a global ±maxDeviation test threw its floor away.
  const raw = heights.slice();
  const reach = 4;
  const neigh: number[] = [];
  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      const i = z * cols + x;
      const h = raw[i]!;
      if (Number.isNaN(h)) continue;
      neigh.length = 0;
      for (let dz = -reach; dz <= reach; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= rows) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= cols || (dx === 0 && dz === 0)) continue;
          const v = raw[zz * cols + xx]!;
          if (!Number.isNaN(v)) neigh.push(v);
        }
      }
      if (neigh.length < 3) continue; // lonely cell: nothing to compare against, keep it
      neigh.sort((a, b) => a - b);
      const local = neigh[Math.floor(neigh.length / 2)]!;
      if (Math.abs(h - local) > maxDeviation) heights[i] = Number.NaN;
    }
  }

  // Coverage: where the scan actually has ground (2nd–98th percentile of sampled cells, so a few stray splats at the
  // horizon do not stretch it). The fence hugs this; beyond it the grid is hole-filled guesswork.
  const xs: number[] = [];
  const zs: number[] = [];
  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      if (Number.isNaN(heights[z * cols + x]!)) continue;
      xs.push(x);
      zs.push(z);
    }
  }
  let coverage: GroundGrid['coverage'];
  if (xs.length >= 8) {
    xs.sort((a, b) => a - b);
    zs.sort((a, b) => a - b);
    const q = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * f)))]!;
    coverage = {
      minX: minX + q(xs, 0.02) * cellSize,
      maxX: minX + q(xs, 0.98) * cellSize,
      minZ: minZ + q(zs, 0.02) * cellSize,
      maxZ: minZ + q(zs, 0.98) * cellSize,
    };
  }

  // Fill holes by iterative neighbour averaging (bounded passes), then fall back to the median.
  for (let pass = 0; pass < 64; pass++) {
    let filled = 0;
    const next = heights.slice();
    for (let z = 0; z < rows; z++) {
      for (let x = 0; x < cols; x++) {
        const i = z * cols + x;
        if (!Number.isNaN(heights[i]!)) continue;
        let sum = 0;
        let n = 0;
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const xx = x + dx;
          const zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= cols || zz >= rows) continue;
          const h = heights[zz * cols + xx]!;
          if (!Number.isNaN(h)) {
            sum += h;
            n++;
          }
        }
        if (n) {
          next[i] = sum / n;
          filled++;
        }
      }
    }
    heights.set(next);
    if (!filled) break;
  }
  for (let i = 0; i < heights.length; i++) if (Number.isNaN(heights[i]!)) heights[i] = median;

  // Light 3×3 smoothing to remove single-cell spikes from foliage.
  const smooth = heights.slice();
  for (let z = 1; z < rows - 1; z++) {
    for (let x = 1; x < cols - 1; x++) {
      let sum = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) sum += heights[(z + dz) * cols + (x + dx)]!;
      smooth[z * cols + x] = sum / 9;
    }
  }

  return { heights: smooth, cols, rows, minX, minZ, cellSize, sampled: xs.length, ...(coverage ? { coverage } : {}) };
}
