import { describe, it, expect, vi } from 'vitest';

// Spark boots its WASM at import time; the level definitions only need the `SplatFileType` enum.
vi.mock('@sparkjsdev/spark', () => ({ SplatFileType: { PCSOGSZIP: 'pcsogszip' } }));

import { LEVELS, RUN, STRIP, hubKit, soloLevel, worldDef, LOCAL_BUTTERFLY } from '../../apps/web/src/world/levels';
import { LevelGraph } from '../../packages/engine/src/world/level';
import type { CellContent } from '../../packages/engine/src/world/cell';

/** goal.md W-3 "content follows the cell" (ADR-0011): each cell names its props, NPCs and car in its own frame. */
const contentOf = (level: (typeof LEVELS)[string], id: string): CellContent | null => {
  const def = level.cells[id]!;
  if (def.content) return def.content;
  return id === level.level.hub ? hubKit(def.spawn ?? [0, 0, 0]) : null;
};

describe('cell content (W-3, ADR-0011)', () => {
  it('the hub kit is what the hub had before: five props, the Photographer and three extras, the lowrider — around the spawn, looking down −Z', () => {
    const kit = hubKit([0, 0, -1]);
    expect(kit.props!.map((p) => p.id)).toEqual(['crate_1', 'crate_2', 'can_3', 'can_4', 'ball_5']);
    expect(kit.npcs!.map((n) => n.id)).toEqual(['photographer', 'npc_a', 'npc_b', 'npc_c']);
    expect(kit.props![0]!.pos).toEqual([-1.2, 0.9, -3.5]); // 2.5 m ahead (−Z), 1.2 m to the left, 0.9 m up
    expect(kit.npcs![0]).toMatchObject({ approaches: true, speed: 1.5, pos: [1.6, 0, -5] });
    expect(kit.props!.filter((p) => p.tags?.includes('spray'))).toHaveLength(2);
    expect(kit.vehicle).toEqual({ pos: [-3.5, 0, -6], yaw: 0 });
    for (const p of kit.props!) expect(p.pos[1]).toBe(0.9); // props drop onto the ground from 0.9 m
  });

  it('every level names unique ids across its cells; every cell with a doorway is in the graph', () => {
    for (const [name, level] of Object.entries(LEVELS)) {
      const props = new Set<string>();
      const npcs = new Set<string>();
      for (const id of level.level.cells) {
        const c = contentOf(level, id);
        for (const p of c?.props ?? []) {
          expect(props.has(p.id), `${name}: prop ${p.id} twice`).toBe(false);
          props.add(p.id);
        }
        for (const n of c?.npcs ?? []) {
          expect(npcs.has(n.id), `${name}: npc ${n.id} twice`).toBe(false);
          npcs.add(n.id);
        }
      }
      expect(() => new LevelGraph(level.level, level.cells)).not.toThrow();
    }
    // The strip: the hub's kit, then a guide and something to throw in each of the other two, under their own light.
    expect(contentOf(STRIP, 'valley')!.npcs!.map((n) => n.id)).toContain('photographer');
    expect(contentOf(STRIP, 'street')!.npcs!.map((n) => n.name)).toEqual(['Nova', 'Kai']);
    expect(contentOf(STRIP, 'sutro')!.props!.map((p) => p.id)).toEqual(['ball_sutro']);
    expect(STRIP.cells.street!.lighting).toBe('blue');
    expect(STRIP.cells.sutro!.lighting).toBe('fog_noon');
    expect(STRIP.cells.valley!.lighting).toBeUndefined(); // the missions ask for golden hour themselves
    // The run: the hub kit in the first butterfly, one guide + one prop in each of the others (the e2e counts them).
    expect(contentOf(RUN, 'butterfly')!.props).toHaveLength(5);
    expect(contentOf(RUN, 'butterfly-2')).toMatchObject({ props: [{ id: 'cone_2' }], npcs: [{ id: 'nova' }] });
    expect(contentOf(RUN, 'butterfly-3')).toMatchObject({ props: [{ id: 'ball_3' }], npcs: [{ id: 'kai' }] });
  });

  it('a solo level makes its one cell the hub (so it gets the kit) and worldDef keeps content in the cell frame', () => {
    const solo = soloLevel('butterfly', LOCAL_BUTTERFLY);
    expect(solo.level.hub).toBe('butterfly');
    expect(contentOf(solo, 'butterfly')!.props).toHaveLength(5);
    const street = worldDef(STRIP, 'street');
    expect(street.origin).toEqual([2, -1.2, 92]);
    expect(street.spawn).toEqual([2, -1.2, 93]); // moved into the world
    expect(street.content!.props![0]!.pos).toEqual([-2.5, 0.9, -3]); // still the cell's own frame: the game adds the origin
  });
});
