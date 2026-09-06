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
  /** Discard cells whose ground is farther than this from the median (sky, floating debris). */
  maxDeviation?: number;
}

export function groundFromSplats(splat: SplatMesh, opts: GroundOptions = {}): GroundGrid {
  const halfExtent = opts.halfExtent ?? 24;
  const cellSize = opts.cellSize ?? 0.75;
  const percentile = opts.percentile ?? 0.08;
  const minOpacity = opts.minOpacity ?? 0.35;
  const maxScale = opts.maxScale ?? 0.6;
  const center = opts.center ?? new THREE.Vector3();
  const maxDeviation = opts.maxDeviation ?? 6;

  const cols = Math.max(2, Math.round((halfExtent * 2) / cellSize) + 1);
  const rows = cols;
  const minX = center.x - halfExtent;
  const minZ = center.z - halfExtent;

  splat.updateMatrixWorld(true);
  const m = splat.matrixWorld;
  const buckets: number[][] = new Array(cols * rows);
  const p = new THREE.Vector3();
  splat.forEachSplat((_i, c, scales, _q, opacity) => {
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
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i]!;
    if (!Number.isNaN(h) && Math.abs(h - median) > maxDeviation) heights[i] = Number.NaN;
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

  return { heights: smooth, cols, rows, minX, minZ, cellSize };
}
