/**
 * Cell / level schemas (goal.md SCH-1, SCH-2, W-2, W-3). JSON files in R2 (`cell.json`, `level.json`) conform to these.
 */
export type TimePreset = 'golden' | 'blue' | 'night' | 'fog_noon';

export interface CellAssets {
  spz100k: string; // R2 URL — loading choreography step 1 (UX-3)
  spz500k: string; // runtime `lod: true` source for user-captured cells (CAP-2)
  spzFull: string;
  rad?: string; // shipped cells only: `build-lod --quality --rad-chunked`, loaded with `paged: true`
  collider: string; // GLB trimesh for Rapier (Marble export or tools/assets/blender/collider_proxy.py)
  pano: string; // 360° pano → skybox + env map
}

export interface CellTransform {
  metricScale: number; // Marble `metric_scale_factor` → metres
  groundOffset: number; // Marble `ground_plane_offset`
  rotationEuler: [number, number, number]; // degrees — rotate, NEVER mirror (W-2)
}

export interface AlignView {
  id: string;
  pos: [number, number, number];
  lookAt: [number, number, number];
}

export interface Cell {
  id: string;
  version: string; // Takes reference this (ACT-4)
  title: string;
  source: { kind: 'marble' | 'capture' | 'scan'; worldId?: string; model?: string; promptRef?: string };
  assets: CellAssets;
  transform: CellTransform;
  spawns: { id: string; pos: [number, number, number]; yaw: number }[];
  zones: { id: string; kind: 'poi' | 'nogo' | 'drive' | 'tag_wall'; aabb: [[number, number, number], [number, number, number]] }[];
  transitions: { to: string; portal: [[number, number, number], [number, number, number]]; streamAt_m: number }[];
  lighting: { preset: TimePreset; envmapFromPano: boolean };
  alignViews: AlignView[]; // 6 views for PHY-5
  budgetOverride?: Partial<Record<'desktop' | 'quest' | 'iphone' | 'visionpro' | 'android' | 'fallback', { lodSplatCount?: number }>>;
  extra?: Record<string, unknown>; // provider-specific provenance (e.g. `marble: { worldId, worldMarbleUrl, caption, thumbnailUrl }`) — never load-bearing at runtime
}

export interface Level {
  id: string;
  version: string;
  hub: string;
  cells: string[];
  edges: [string, string][];
  /** Where each cell's frame sits in the shared world (W-3, ADR-0009); a cell without one sits at the origin. */
  placements?: Record<string, { origin: [number, number, number] }>;
}
