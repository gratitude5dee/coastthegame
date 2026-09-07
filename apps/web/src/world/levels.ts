/**
 * Levels on the sample worlds (goal.md W-3, ADR-0009). A level = SCH-2 `level.json` (+ `placements`) and, per cell,
 * a `SceneDef` with SCH-1 `transitions` in the cell's frame. Two ship in code until the Marble cells (M2) land:
 *
 *  - `strip` — valley ↔ snow street ↔ sutro over the network: the default when `?scene=valley|street|sutro`.
 *  - `run`   — three copies of the local butterfly sample 16 m apart: the e2e harness and offline QA (`?level=run`).
 *
 * Doorway floors were measured from the derived ground grids (`docs/cells.md` will carry the Marble cells' data);
 * doorways are as wide as the road plus its kerbs (8 m), so nobody walks past one along the edge.
 */
import { SplatFileType } from '@sparkjsdev/spark';
import type { CellContent, CellTransition, Level, TimeOfDay, Vec3 } from '@coast/engine';

export interface SceneDef {
  title: string;
  url: string;
  fileType?: SplatFileType;
  /** Splat mesh offset in the cell's frame (re-centres a scan on the cell origin). */
  position: Vec3;
  scale: number;
  camera: { pos: Vec3; lookAt: Vec3 };
  /** Walkable world vs. object on a table. */
  world: boolean;
  spawn?: Vec3;
  /** Half size (m) of the splat-derived ground grid around the spawn (PHY-1 fallback); default 40. */
  groundHalfExtent?: number;
  /** Build Spark's LoD tree for this scan (default on; `?lod=0` turns it off everywhere). */
  lod?: boolean;
  /** Doorways to neighbouring cells, in this cell's frame (SCH-1). */
  transitions?: CellTransition[];
  /** Props / NPCs / the car this cell hosts, in its frame (SCH-1 `content`, ADR-0011); the level's hub gets the kit when absent. */
  content?: CellContent;
  /** The grade the cell arrives under (SCH-1 `lighting.preset`) unless the player or the director picked a time. */
  lighting?: TimeOfDay;
  /** World position of the cell's frame (set from the level's placements). */
  origin?: Vec3;
}

export interface LevelDef {
  level: Level;
  cells: Record<string, SceneDef>;
}

/**
 * The hub kit: what the level's hub puts down when it has no authored content — two crates, two spray cans, a ball,
 * the lowrider, the Photographer and three extras (goal.md §3.1 steps 2–3; PHY-2/3/4), laid out around the spawn
 * for a camera that looks down −Z (every sample world's does). Props sit 0.9 m up and drop onto the ground.
 */
export function hubKit(spawn: Vec3): CellContent {
  const at = (side: number, fwd: number, up = 0): Vec3 => [spawn[0] + side, up, spawn[2] - fwd];
  return {
    props: [
      { id: 'crate_1', shape: 'box', size: [0.35, 0.35, 0.35], color: 0xd9743a, mass: 3, pos: at(-1.2, 2.5, 0.9) },
      { id: 'crate_2', shape: 'box', size: [0.25, 0.25, 0.25], color: 0x4fa3d9, mass: 2, pos: at(0.6, 3.2, 0.9) },
      // Spray cans (W-4): grab one, then click / pull the trigger at the splats to tag them in the can's colour.
      { id: 'can_3', shape: 'cylinder', size: [0.12, 0.2], color: 0xff3fa4, mass: 0.6, pos: at(1.4, 2.0, 0.9), tags: ['spray'] },
      { id: 'can_4', shape: 'cylinder', size: [0.12, 0.2], color: 0x3fd0ff, mass: 0.6, pos: at(1.9, 1.6, 0.9), tags: ['spray'] },
      { id: 'ball_5', shape: 'ball', size: [0.3], color: 0x9be34a, mass: 1.5, pos: at(-0.3, 4.5, 0.9) },
    ],
    npcs: [
      {
        id: 'photographer',
        name: 'Photographer',
        color: 0x4fa3d9,
        pos: at(1.6, 4),
        approaches: true,
        speed: 1.5,
        lines: [
          'Say: camera low, follow me.',
          'Roll it — Enter is action. Get low, keep the crate in frame.',
          'Golden hour is on T. Sunset sells.',
        ],
      },
      { id: 'npc_a', name: 'Rico', color: 0xd9a03a, pos: at(-5, 9), lines: ['Yo $COAST!', 'Nice ride.'] },
      { id: 'npc_b', name: 'Mari', color: 0xb35cd9, pos: at(6, -3), lines: ['Tag that wall.', 'Hop it on the one.'] },
      { id: 'npc_c', name: 'Dee', color: 0x3ad98a, pos: at(7, 7), lines: ['Low and slow.', 'That your cut on the billboard?'] },
    ],
    // The lowrider idles nearby, facing the same way (PHY-3); the game parks it on the flattest patch around here.
    vehicle: { pos: at(-3.5, 5), yaw: 0 },
  };
}

export const LOCAL_BUTTERFLY: SceneDef = {
  title: 'Butterfly (local sample)',
  url: '/samples/butterfly.spz',
  position: [0, 0, -3],
  scale: 1,
  camera: { pos: [0, 0.2, 0.5], lookAt: [0, 0, -3] },
  world: false,
};

// Spark sample assets are stored Y-down: rotate 180° about X — rotate, never mirror (W-2).
export const SCENES: Record<string, SceneDef> = {
  valley: {
    title: 'Valley (Spark sample world)',
    url: 'https://sparkjs.dev/assets/splats/valley.spz',
    position: [0, 0, 0],
    scale: 0.5,
    camera: { pos: [0, 2.2, -0.5], lookAt: [0, 1.6, -8] },
    world: true,
    spawn: [0, 0, -1],
    // The floor is flat to z ≈ 30 (y ≈ −0.6), then the far hillside rises: the road to the street leaves from the
    // floor and cuts through the rim (ADR-0009).
    transitions: [
      {
        to: 'street',
        portal: [
          [0, -0.6, 27],
          [8, 2.4, 29],
        ],
        streamAt_m: 15,
      },
    ],
  },
  street: {
    title: 'Snow street (Spark sample world)',
    url: 'https://sparkjs.dev/assets/splats/snow-street.spz',
    // The scan's street runs along +Z (x ≈ −8…12, z ≈ −30…9 once re-centred), climbing ~10 % towards −Z; the file
    // has it at x ≈ 0…12, y ≈ 8, z ≈ 55…100.
    position: [-5, -8.3, -92],
    scale: 1,
    // 21 % of this scan's splats have non-finite centres, which hangs Spark's Tiny LoD build forever: no LoD here
    // (982k splats, well inside the desktop budget).
    lod: false,
    camera: { pos: [0, 1.6, 2], lookAt: [0, 1.4, -5] },
    world: true,
    spawn: [0, 0, 1],
    lighting: 'blue', // a snowy street at blue hour
    content: {
      props: [
        { id: 'cone_street', shape: 'cylinder', size: [0.22, 0.6], color: 0xff7a1a, mass: 1, pos: [-2.5, 0.9, -3] },
        { id: 'crate_street', shape: 'box', size: [0.4, 0.4, 0.4], color: 0x7a5230, mass: 4, pos: [3, 0.9, -1] },
      ],
      npcs: [
        {
          id: 'nova',
          name: 'Nova',
          color: 0xe8e4ff,
          pos: [-3, 0, -7],
          lines: ['Snow on the block tonight.', 'The valley is back up the hill.'],
        },
        {
          id: 'kai',
          name: 'Kai',
          color: 0xffb54a,
          pos: [5, 0, 1],
          approaches: true,
          lines: ['Downhill takes you to the tower.', 'Blue hour. Perfect.'],
        },
      ],
    },
    transitions: [
      {
        to: 'valley',
        portal: [
          [-2, 2.5, -25],
          [6, 5.5, -23],
        ],
        streamAt_m: 15,
      }, // the uphill end
      {
        to: 'sutro',
        portal: [
          [-4, -0.1, 7],
          [4, 2.9, 9],
        ],
        streamAt_m: 15,
      }, // the downhill end
    ],
  },
  sutro: {
    title: 'Sutro Tower, SF (SOGS)',
    url: 'https://sparkjs.dev/assets/splats/sutro.zip',
    fileType: SplatFileType.PCSOGSZIP,
    position: [0, 0, 0],
    scale: 1,
    camera: { pos: [0, 1.5, 4], lookAt: [0, 1.5, 0] },
    world: true,
    spawn: [0, 0, 3],
    lighting: 'fog_noon', // the tower in the fog
    content: {
      props: [{ id: 'ball_sutro', shape: 'ball', size: [0.3], color: 0xff3fa4, mass: 1.5, pos: [-2, 0.9, 0] }],
      npcs: [
        {
          id: 'sky',
          name: 'Sky',
          color: 0x9be34a,
          pos: [3, 0, -3],
          lines: ['Fog rolls in from the ocean side.', 'You can see the whole city on a clear day.'],
        },
      ],
    },
    // A wide, low hilltop: −0.2 at the centre, −1.5 at the edges.
    transitions: [
      {
        to: 'street',
        portal: [
          [-4, -1.4, -26],
          [4, 1.6, -24],
        ],
        streamAt_m: 15,
      },
    ],
  },
  butterfly: LOCAL_BUTTERFLY,
};
export const SCENE_ORDER = ['valley', 'street', 'sutro', 'butterfly'] as const;

/** valley ↔ street ↔ sutro strung along +Z, 40 m roads between the doorways. */
export const STRIP: LevelDef = {
  level: {
    id: 'sample-strip',
    version: '2026-09-07.1',
    hub: 'valley',
    cells: ['valley', 'street', 'sutro'],
    edges: [
      ['valley', 'street'],
      ['street', 'sutro'],
    ],
    placements: {
      valley: { origin: [0, 0, 0] },
      street: { origin: [2, -1.2, 92] }, // its doorway floor (2, 2.5, −24) lands at (4, 1.3, 68): +1.9 m over 40 m
      sutro: { origin: [2, 1.1, 165] }, // its doorway floor (0, −1.4, −25) lands at (2, −0.3, 140): +1 m over 40 m
    },
  },
  cells: { valley: SCENES.valley!, street: SCENES.street!, sutro: SCENES.sutro! },
};

/** Three butterflies 16 m apart on 4 m roads (local data, no LoD to speak of) — the streaming test bed. */
const runCell = (title: string, west: string | null, east: string | null, content?: CellContent): SceneDef => ({
  ...LOCAL_BUTTERFLY,
  title,
  world: true,
  spawn: [0, 0, 0],
  groundHalfExtent: 7,
  ...(content ? { content } : {}),
  transitions: [
    ...(west
      ? [
          {
            to: west,
            portal: [
              [-7, 0, -4],
              [-5, 3, 4],
            ] as CellTransition['portal'],
            streamAt_m: 4,
          },
        ]
      : []),
    ...(east
      ? [
          {
            to: east,
            portal: [
              [5, 0, -4],
              [7, 3, 4],
            ] as CellTransition['portal'],
            streamAt_m: 4,
          },
        ]
      : []),
  ],
});
export const RUN: LevelDef = {
  level: {
    id: 'butterfly-run',
    version: '2026-09-07.1',
    hub: 'butterfly',
    cells: ['butterfly', 'butterfly-2', 'butterfly-3'],
    edges: [
      ['butterfly', 'butterfly-2'],
      ['butterfly-2', 'butterfly-3'],
    ],
    placements: { butterfly: { origin: [0, 0, 0] }, 'butterfly-2': { origin: [16, 0, 0] }, 'butterfly-3': { origin: [32, 0, 0] } },
  },
  cells: {
    butterfly: runCell('Butterfly (run: 1 of 3)', null, 'butterfly-2'), // the hub: the kit
    'butterfly-2': runCell('Butterfly (run: 2 of 3)', 'butterfly', 'butterfly-3', {
      props: [{ id: 'cone_2', shape: 'cylinder', size: [0.22, 0.6], color: 0xff7a1a, mass: 1, pos: [-2, 0.9, 2] }],
      npcs: [{ id: 'nova', name: 'Nova', color: 0xe8e4ff, pos: [2, 0, -3], lines: ['Second stop.'] }],
    }),
    'butterfly-3': runCell('Butterfly (run: 3 of 3)', 'butterfly-2', null, {
      props: [{ id: 'ball_3', shape: 'ball', size: [0.3], color: 0xff3fa4, mass: 1.5, pos: [2, 0.9, 2] }],
      npcs: [{ id: 'kai', name: 'Kai', color: 0xffb54a, pos: [-2, 0, -3], lines: ['End of the run.'] }],
    }),
  },
};

export const LEVELS: Record<string, LevelDef> = { strip: STRIP, run: RUN };

/** A one-cell level around any scene (no transitions): the butterfly on its table, a Marble cell on its own. */
export function soloLevel(id: string, def: SceneDef): LevelDef {
  return {
    level: { id: `solo-${id}`, version: '1', hub: id, cells: [id], edges: [], placements: { [id]: { origin: [0, 0, 0] } } },
    cells: { [id]: { ...def, transitions: [] } },
  };
}

/** Which level a `?scene=` belongs to when `?level=` is not given. */
export function levelForScene(sceneId: string): LevelDef {
  if (STRIP.level.cells.includes(sceneId)) return STRIP;
  return soloLevel(sceneId, SCENES[sceneId] ?? LOCAL_BUTTERFLY);
}

/** The cell's definition with every position moved into the world by its placement. */
export function worldDef(levelDef: LevelDef, cellId: string): SceneDef {
  const def = levelDef.cells[cellId];
  if (!def) throw new Error(`level ${levelDef.level.id} has no cell ${cellId}`);
  const o: Vec3 = levelDef.level.placements?.[cellId]?.origin ?? [0, 0, 0];
  const add = (p: Vec3): Vec3 => [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
  return {
    ...def,
    origin: o,
    position: add(def.position),
    camera: { pos: add(def.camera.pos), lookAt: add(def.camera.lookAt) },
    ...(def.spawn ? { spawn: add(def.spawn) } : {}),
  };
}
