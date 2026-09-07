import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CellStreamer, LevelGraph, distanceToAabbXZ, insideAabb, type LevelCellInput } from '../../packages/engine/src/world/level';
import type { Level } from '../../packages/engine/src/world/cell';
import { fenceWalls, groundHeightAt, type GroundGrid } from '../../packages/engine/src/physics/world';
import { corridorFrame, cutGroundForCorridor } from '../../packages/engine/src/world/transition';

/**
 * goal.md W-3 (ADR-0009): a chain garage ↔ pier ↔ alley. Each cell is 40 m square in its own frame with doorways on
 * the sides that face a neighbour; placements string them along +X, 60 m apart.
 */
const LEVEL: Level = {
  id: 'test-block',
  version: '1',
  hub: 'garage',
  cells: ['garage', 'pier', 'alley'],
  edges: [
    ['garage', 'pier'],
    ['pier', 'alley'],
  ],
  placements: { garage: { origin: [0, 0, 0] }, pier: { origin: [60, 2, 0] }, alley: { origin: [120, 0, 0] } },
};
const door = (x: number): [[number, number, number], [number, number, number]] => [
  [x - 1, 0, -3],
  [x + 1, 3, 3],
];
const CELLS: Record<string, LevelCellInput> = {
  garage: { id: 'garage', transitions: [{ to: 'pier', portal: door(18), streamAt_m: 15 }] },
  pier: {
    id: 'pier',
    transitions: [
      { to: 'garage', portal: door(-18), streamAt_m: 15 },
      { to: 'alley', portal: door(18), streamAt_m: 15 },
    ],
  },
  alley: { id: 'alley', transitions: [{ to: 'pier', portal: door(-18), streamAt_m: 15 }] },
};

describe('LevelGraph', () => {
  it('moves each cell’s doorways into the world by its placement and knows both directions of every edge', () => {
    const g = new LevelGraph(LEVEL, CELLS);
    const out = g.portal('garage', 'pier')!;
    expect(out.aabb).toEqual([
      [17, 0, -3],
      [19, 3, 3],
    ]);
    expect(out.floor).toEqual([18, 0, 0]);
    const back = g.portal('pier', 'garage')!;
    expect(back.aabb[0]).toEqual([41, 2, -3]); // pier's frame sits at (60, 2, 0)
    expect(g.neighbours('pier').sort()).toEqual(['alley', 'garage']);
    expect(g.neighbours('garage')).toEqual(['pier']);
    expect(g.toWorld('alley', [1, 1, 1])).toEqual([121, 1, 1]);
  });

  it('rejects one-sided edges and unknown cells', () => {
    const oneSided = { ...CELLS, alley: { id: 'alley', transitions: [] } };
    expect(() => new LevelGraph(LEVEL, oneSided)).toThrow(/alley has no transition to pier/);
    expect(() => new LevelGraph({ ...LEVEL, edges: [['garage', 'rooftop']] }, CELLS)).toThrow(/unknown cell/);
    expect(() => new LevelGraph({ ...LEVEL, hub: 'rooftop' }, CELLS)).toThrow(/hub/);
  });

  it('measures XZ distance to a doorway and containment with vertical slack', () => {
    const box: [[number, number, number], [number, number, number]] = [
      [17, 0, -3],
      [19, 3, 3],
    ];
    expect(distanceToAabbXZ({ x: 18, z: 0 }, box)).toBe(0);
    expect(distanceToAabbXZ({ x: 10, z: 0 }, box)).toBe(7);
    expect(distanceToAabbXZ({ x: 22, z: 7 }, box)).toBeCloseTo(5, 6);
    expect(insideAabb({ x: 18, y: 4, z: 0 }, box)).toBe(false);
    expect(insideAabb({ x: 18, y: 4, z: 0 }, box, 2)).toBe(true);
    expect(insideAabb({ x: 20, y: 1, z: 0 }, box, 2)).toBe(false);
  });
});

describe('CellStreamer (W-3)', () => {
  const walk = (s: CellStreamer, x: number, y = 0, z = 0) => s.update({ x, y, z });

  it('streams the neighbour from 15 m before its doorway, arrives in its return doorway, never holds more than 2 cells', () => {
    const g = new LevelGraph(LEVEL, CELLS);
    const s = new CellStreamer(g, 'garage');
    expect(walk(s, 0)).toEqual([]); // 17 m from the doorway's near face: nothing yet
    expect(walk(s, 1.9)).toEqual([]); // 15.1 m
    const ev = walk(s, 2.2); // 14.8 m
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'load', cell: 'pier' });
    expect(s.residentIds).toEqual(['garage', 'pier']);
    expect(walk(s, 10)).toEqual([]); // already resident: no repeat
    // Walking into the pier's doorway before its ground is in does nothing (the gate holds you anyway).
    expect(walk(s, 42, 2)).toEqual([]);
    s.markLoaded('pier');
    const arrive = walk(s, 42, 2);
    expect(arrive[0]).toMatchObject({ kind: 'arrive', cell: 'pier', from: 'garage' });
    expect(s.active).toBe('pier');
    expect(s.residentIds).toEqual(['garage', 'pier']); // arrival unloads nothing by itself
    // Crossing the pier towards the alley: the alley loads and the garage (farther) goes.
    expect(walk(s, 60, 2)).toEqual([]);
    const next = walk(s, 64, 2); // 13 m from the alley doorway's near face at x = 77
    expect(next.map((e) => e.kind)).toEqual(['unload', 'load']);
    expect(next[0]).toMatchObject({ kind: 'unload', cell: 'garage' });
    expect(next[1]).toMatchObject({ kind: 'load', cell: 'alley' });
    expect(s.residentIds).toEqual(['pier', 'alley']);
    expect(s.isLoaded('garage')).toBe(false);
  });

  it('turning back reloads the cell you came from and evicts the one you were heading to', () => {
    const g = new LevelGraph(LEVEL, CELLS);
    const s = new CellStreamer(g, 'pier');
    expect(walk(s, 64, 2)[0]).toMatchObject({ kind: 'load', cell: 'alley' });
    const back = walk(s, 55, 2); // 12 m from the garage doorway's far face at x = 43
    expect(back.map((e) => `${e.kind}:${e.cell}`)).toEqual(['unload:alley', 'load:garage']);
  });

  it('reports the nearest exit for the HUD and honours residentCells', () => {
    const g = new LevelGraph(LEVEL, CELLS);
    const s = new CellStreamer(g, 'pier', { residentCells: 3 });
    const n = s.nearest({ x: 70, z: 0 })!;
    expect(n.portal.to).toBe('alley');
    expect(n.distance).toBeCloseTo(7, 6);
    walk(s, 64, 2);
    walk(s, 55, 2);
    expect(s.residentIds.sort()).toEqual(['alley', 'garage', 'pier']); // room for all three
  });

  it('is deterministic in the path: the same walk yields the same events', () => {
    const run = () => {
      const s = new CellStreamer(new LevelGraph(LEVEL, CELLS), 'garage');
      const log: string[] = [];
      for (let x = 0; x <= 140; x += 0.5) {
        for (const e of s.update({ x, y: x >= 41 && x < 101 ? 2 : 0, z: 0 })) log.push(`${x}:${e.kind}:${e.cell}`);
        if (s.isResident('pier') && !s.isLoaded('pier') && x > 20) s.markLoaded('pier');
        if (s.isResident('alley') && !s.isLoaded('alley') && x > 80) s.markLoaded('alley');
      }
      return log;
    };
    const a = run();
    expect(a).toEqual(run());
    expect(a).toEqual(['2:load:pier', '41:arrive:pier', '62:unload:garage', '62:load:alley', '101:arrive:alley']);
  });
});

describe('fence openings', () => {
  const rect = { minX: -10, minZ: -10, maxX: 10, maxZ: 10 };

  it('four whole walls without openings', () => {
    const walls = fenceWalls(rect, [], 0.25);
    expect(walls).toHaveLength(4);
    expect(walls).toContainEqual({ x: 0, z: -10.25, ex: 10.25, ez: 0.25 });
    expect(walls).toContainEqual({ x: 10.25, z: 0, ex: 0.25, ez: 10.25 });
  });

  it('a doorway that reaches the +X wall splits it in two and leaves the others whole', () => {
    const walls = fenceWalls(rect, [{ minX: 8, maxX: 14, minZ: -2, maxZ: 2 }], 0.25);
    expect(walls).toHaveLength(5);
    const px = walls.filter((w) => w.x === 10.25).sort((a, b) => a.z - b.z);
    expect(px).toHaveLength(2);
    expect(px[0]!.z + px[0]!.ez).toBeCloseTo(-2, 6); // ends at the opening
    expect(px[1]!.z - px[1]!.ez).toBeCloseTo(2, 6); // resumes after it
  });

  it('an opening that does not reach a wall changes nothing; one across a corner cuts both walls', () => {
    expect(fenceWalls(rect, [{ minX: -2, maxX: 2, minZ: -2, maxZ: 2 }])).toHaveLength(4);
    expect(fenceWalls(rect, [{ minX: 8, maxX: 12, minZ: 8, maxZ: 12 }])).toHaveLength(4); // two walls each lose an end
  });
});

describe('corridor geometry', () => {
  it('a road from a low doorway to a high one tilts, keeps its width, and reports the surface height along it', () => {
    const f = corridorFrame([0, 0, 0], [0, 4, 30], 6, 1);
    expect(f.run).toBeCloseTo(30, 6);
    expect(f.rise).toBe(4);
    expect(f.pitch).toBeCloseTo(Math.atan2(4, 30), 6);
    expect(f.yaw).toBeCloseTo(0, 6);
    expect(f.heightAt(0, 0)).toBeCloseTo(0, 6);
    expect(f.heightAt(2, 15)).toBeCloseTo(2, 6);
    expect(f.heightAt(0, 30)).toBeCloseTo(4, 6);
    expect(f.heightAt(0, 31)).toBeCloseTo(4, 6); // within the end margin, clamped
    expect(f.heightAt(0, 32)).toBeNull();
    expect(f.heightAt(4.5, 15)).toBeNull(); // beyond half width + margin
    // Local +Z maps onto the road direction, local +Y onto its normal.
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(f.quaternion);
    expect(fwd.x).toBeCloseTo(0, 6);
    expect(fwd.y).toBeCloseTo(4 / Math.hypot(4, 30), 6);
    expect(fwd.z).toBeCloseTo(30 / Math.hypot(4, 30), 6);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(f.quaternion);
    expect(up.y).toBeGreaterThan(0.99);
    expect(f.footprint).toEqual({ minX: -4, maxX: 4, minZ: -4, maxZ: 34 });
  });

  it('a diagonal road’s footprint holds both doorways and the height query follows the yaw', () => {
    const f = corridorFrame([10, 1, 10], [40, 1, 40], 6, 1);
    expect(f.yaw).toBeCloseTo(Math.PI / 4, 6);
    expect(f.heightAt(25, 25)).toBeCloseTo(1, 6);
    expect(f.heightAt(25, 30)).toBeCloseTo(1, 6); // 3.5 m off the centre line: inside half width + margin
    expect(f.heightAt(25, 32)).toBeNull(); // 4.9 m off: outside
    expect(f.heightAt(26, 27)).toBeCloseTo(1, 6);
  });

  it('the road cut lowers only the ground standing above the road, inside the footprint', () => {
    const cols = 41;
    const grid: GroundGrid = { heights: new Float32Array(cols * cols), cols, rows: cols, minX: -20, minZ: -20, cellSize: 1 };
    // A hill along +Z: ground rises 0.5 m per metre past z = 5.
    for (let z = 0; z < cols; z++) for (let x = 0; x < cols; x++) grid.heights[z * cols + x] = Math.max(0, (-20 + z - 5) * 0.5);
    const f = corridorFrame([0, 0, 0], [0, 1, 20], 6, 1);
    const cut = cutGroundForCorridor(grid, f, 0.05);
    expect(cut).toBeGreaterThan(0);
    expect(groundHeightAt(grid, 0, 15)).toBeCloseTo(0.75 - 0.05, 6); // on the road: cut to just under it
    expect(groundHeightAt(grid, 0, 2)).toBe(0); // below the road already: untouched
    expect(groundHeightAt(grid, 10, 15)).toBeCloseTo(5, 6); // beside the road: untouched
    expect(groundHeightAt(grid, 3.9, 15)).toBeCloseTo(0.7, 6); // margin: still cut
    expect(groundHeightAt(grid, 5, 15)).toBeCloseTo(5, 6);
  });
});
