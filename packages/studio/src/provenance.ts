/**
 * Provenance manifest for a Coast Cut (goal.md STU-5, SCH-7): what went into the clip — cells and their versions,
 * the takes (who performed, how long, what they touched), the shot (camera take, fps, size, bar range, look,
 * captions), generative spans (engine, model, prompt, seed — empty until the fal jobs), user-supplied references,
 * cost, and the app that made it. Uploaded next to the video; shown on the share page; becomes the NFT metadata
 * (ID-*, M8). Pure data with no imports at all — the Worker validates manifests with this same file.
 */

/** What the builder needs from a take (structurally `TakeV1`). */
export interface ManifestTakeInput {
  id: string;
  actorId: string;
  cellVersion: string;
  durationS: number;
  startedAt: string;
  samples: { length: number };
  worldEdits: { length: number };
  props?: { length: number };
}

/** What the builder needs from a cut plan (structurally `CutPlan`). */
export interface ManifestPlanInput {
  fps: number;
  width: number;
  height: number;
  startS: number;
  endS: number;
  frameCount: number;
  cameraLayer: number;
  bars?: [number, number];
}

export const MANIFEST_VERSION = 1 as const;

/** The seed's provenance record (goal.md STU-5): the manifest below is its concrete, versioned document. */
export interface Provenance {
  cells: { id: string; version: string }[];
  takes: string[];
  shots: string[];
  missions: string[];
  trackId: string;
  barRange: [number, number];
  prompts: string[];
  models: string[]; // e.g. "minimax/h3-max-turbo", "gpt-realtime-2.1-mini"
  seeds: number[];
  userRefs: string[]; // R2 keys of user-supplied reference media (GEN-4), labelled in the mint metadata
  costUsd: number;
  createdAt: string;
  author: { userId: string; wallet?: string };
}

export interface ManifestTake {
  id: string;
  actorId: string;
  cellVersion: string;
  durationS: number;
  startedAt: string;
  samples: number;
  /** World edits logged in the take (grabs, throws, paint, markers). */
  edits: number;
  /** Props with pose tracks (replayed kinematically). */
  props: number;
}

export interface ManifestShot {
  /** The take whose recorded camera drives the picture. */
  cameraTake: string;
  fps: number;
  width: number;
  height: number;
  aspect: '16:9' | '9:16' | 'other';
  startS: number;
  endS: number;
  frames: number;
  bars?: [number, number];
  look?: string;
  captions: number;
}

export interface ManifestGenerative {
  engine: 'fal' | 'decart' | 'worldlabs';
  model: string;
  prompt?: string;
  seed?: number;
  /** Set time span the render replaces, seconds. */
  span?: [number, number];
  costUsd?: number;
}

export interface ManifestReference {
  kind: 'image' | 'video' | 'audio';
  sha256: string;
  name?: string;
  bytes?: number;
}

export interface CutManifest extends Provenance {
  v: typeof MANIFEST_VERSION;
  kind: 'coast-cut';
  id: string;
  title: string;
  app: { name: 'coast-the-game'; version: string; commit?: string };
  level?: { id: string; version: string };
  takeDetails: ManifestTake[];
  shot: ManifestShot;
  generative: ManifestGenerative[];
  references: ManifestReference[];
  audio: { trackId: string; bpm?: number; muxed: boolean };
  video?: { bytes: number; mime: string; codec: string; sha256?: string };
}

export interface ManifestInput {
  id: string;
  title: string;
  missionId: string;
  trackId: string;
  barRange: [number, number];
  bpm?: number;
  look?: string;
  takes: ManifestTakeInput[];
  plan: ManifestPlanInput;
  captions: { length: number };
  /** What drove the camera when it was not a take's recorded track (a keyframed path, CAM-7): `'path'`. */
  cameraTake?: string;
  video?: { bytes: number; mime: string; codec: string; sha256?: string };
  level?: { id: string; version: string };
  /** Cells resident at export time (the takes' own cell versions are always included). */
  cells?: { id: string; version: string }[];
  author: { userId: string; wallet?: string };
  app: { version: string; commit?: string };
  generative?: ManifestGenerative[];
  references?: ManifestReference[];
  costUsd?: number;
  createdAt?: string;
}

function aspectOf(w: number, h: number): ManifestShot['aspect'] {
  const r = w / h;
  if (Math.abs(r - 16 / 9) < 0.02) return '16:9';
  if (Math.abs(r - 9 / 16) < 0.02) return '9:16';
  return 'other';
}

export function buildCutManifest(i: ManifestInput): CutManifest {
  const takes = i.takes.map<ManifestTake>((t) => ({
    id: t.id,
    actorId: t.actorId,
    cellVersion: t.cellVersion,
    durationS: Math.round(t.durationS * 1000) / 1000,
    startedAt: t.startedAt,
    samples: t.samples.length,
    edits: t.worldEdits.length,
    props: t.props?.length ?? 0,
  }));
  const cellMap = new Map<string, string>();
  for (const c of i.cells ?? []) cellMap.set(c.id, c.version);
  for (const t of i.takes) if (!cellMap.has(t.cellVersion)) cellMap.set(t.cellVersion, t.cellVersion);
  const cells = [...cellMap].map(([id, version]) => ({ id, version }));
  const camera = i.takes[Math.min(Math.max(0, i.plan.cameraLayer), Math.max(0, i.takes.length - 1))];
  const generative = i.generative ?? [];
  const cost = i.costUsd ?? generative.reduce((s, g) => s + (g.costUsd ?? 0), 0);
  return {
    v: MANIFEST_VERSION,
    kind: 'coast-cut',
    id: i.id,
    title: i.title,
    app: { name: 'coast-the-game', version: i.app.version, ...(i.app.commit ? { commit: i.app.commit } : {}) },
    ...(i.level ? { level: i.level } : {}),
    cells,
    takes: takes.map((t) => t.id),
    takeDetails: takes,
    shots: [`${i.id}:shot`],
    shot: {
      cameraTake: i.cameraTake ?? camera?.id ?? '',
      fps: i.plan.fps,
      width: i.plan.width,
      height: i.plan.height,
      aspect: aspectOf(i.plan.width, i.plan.height),
      startS: i.plan.startS,
      endS: i.plan.endS,
      frames: i.plan.frameCount,
      ...(i.plan.bars ? { bars: i.plan.bars } : {}),
      ...(i.look ? { look: i.look } : {}),
      captions: i.captions.length,
    },
    missions: [i.missionId],
    trackId: i.trackId,
    barRange: i.barRange,
    audio: { trackId: i.trackId, ...(i.bpm ? { bpm: i.bpm } : {}), muxed: false },
    generative,
    prompts: generative.map((g) => g.prompt ?? '').filter(Boolean),
    models: [...new Set(generative.map((g) => `${g.engine}/${g.model}`))],
    seeds: generative.map((g) => g.seed).filter((s): s is number => typeof s === 'number'),
    references: i.references ?? [],
    userRefs: (i.references ?? []).map((r) => r.sha256),
    costUsd: Math.round(cost * 1e4) / 1e4,
    createdAt: i.createdAt ?? new Date().toISOString(),
    author: i.author,
    ...(i.video ? { video: i.video } : {}),
  };
}

/** One line for the share page / the card: "2 takes · valley · 1080p30 · bars 9–16 · 35mm-dusk". */
export function manifestSummary(m: CutManifest): string {
  const parts = [
    `${m.takeDetails.length} take${m.takeDetails.length === 1 ? '' : 's'}`,
    m.cells.map((c) => c.id).join(' + '),
    `${m.shot.height}p${m.shot.fps}${m.shot.aspect === '9:16' ? ' portrait' : ''}`,
  ];
  if (m.shot.bars) parts.push(`bars ${m.shot.bars[0]}–${m.shot.bars[1]}`);
  if (m.shot.look) parts.push(m.shot.look);
  if (m.generative.length) parts.push(`${m.generative.length} generative span${m.generative.length === 1 ? '' : 's'}`);
  return parts.filter(Boolean).join(' · ');
}

/**
 * Shape check for a manifest that arrived over the wire (the Worker runs this before storing; the client before
 * minting). Returns the problems found, empty when it is a manifest we understand.
 */
export function validateManifest(x: unknown): string[] {
  const errors: string[] = [];
  const m = x as Partial<CutManifest> | null;
  if (!m || typeof m !== 'object') return ['not an object'];
  if (m.v !== MANIFEST_VERSION) errors.push(`v must be ${MANIFEST_VERSION}`);
  if (m.kind !== 'coast-cut') errors.push('kind must be coast-cut');
  if (typeof m.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(m.id)) errors.push('id');
  if (typeof m.title !== 'string' || m.title.length > 120) errors.push('title');
  if (!Array.isArray(m.cells) || !m.cells.every((c) => c && typeof c.id === 'string' && typeof c.version === 'string'))
    errors.push('cells');
  if (!Array.isArray(m.takeDetails) || m.takeDetails.length > 16) errors.push('takeDetails');
  if (!m.shot || typeof m.shot.fps !== 'number' || typeof m.shot.width !== 'number' || typeof m.shot.height !== 'number')
    errors.push('shot');
  if (!Array.isArray(m.generative)) errors.push('generative');
  if (!Array.isArray(m.references)) errors.push('references');
  if (!m.author || typeof m.author.userId !== 'string') errors.push('author');
  if (typeof m.createdAt !== 'string' || Number.isNaN(Date.parse(m.createdAt))) errors.push('createdAt');
  if (!m.app || m.app.name !== 'coast-the-game') errors.push('app');
  return errors;
}
