/**
 * Studio data model (goal.md §7.7 STU-*, §7.8 GEN-*). Takes (ACT-2/ACT-4, SCH-4 v0: `TakeV1`, recorder, player, codec,
 * session store) live in ./takes; the set (multi-take blocking) in ./set; shots/export land in M6.
 */
export * from './takes';
export * from './set';
export * from './export';
export * from './reel';
export * from './captions';

export type PassName = 'beauty' | 'depth' | 'normal' | 'id' | 'pose';

export interface CameraKey {
  t: number;
  pos: [number, number, number];
  quat: [number, number, number, number];
  fovDeg: number;
}

export interface Shot {
  id: string;
  cellId: string;
  fps: 24 | 30;
  durationS: number;
  camera: CameraKey[]; // CatmullRom through keys (CAM-7)
  takes: string[]; // Take ids replayed during the shot
  passes: PassName[];
  timePreset: 'golden' | 'blue' | 'night' | 'fog_noon';
  weather: 'fog' | 'clear' | 'rain';
}

export * from './missions';
export * from './beats';

/** Queued (async) generative renders (GEN table). Dream (live restyle) is NOT a job — it is a WebRTC session, see DreamSession. */
export type GenMode = 'draft_turbo' | 'faithful_vace' | 'hero_h3';

export interface DreamSession {
  id: string;
  preset: '35mm-dusk' | 'vhs-1994' | 'noir';
  startedAt: string;
  secondsBilled: number; // cost meter (GEN-5)
  provider: 'decart' | 'fal';
}

export interface GenJob {
  id: string;
  shotId: string;
  mode: GenMode;
  prompt: string; // composed (GEN-2), never free-typed
  refs: string[]; // R2 keys of reference images/videos (GEN-3/4)
  sync: boolean; // true only for draft_turbo inside a session (GEN-6); faithful/hero run post-session
  status: 'queued' | 'running' | 'done' | 'failed';
  resultKey?: string; // R2 key of the MP4
  costUsd?: number;
}

export interface Cut {
  id: string;
  trackId: string;
  barRange: [number, number];
  clips: { shotId: string; genJobId?: string; startBar: number; lengthBars: number }[];
  aspect: '16:9' | '9:16';
  captions: boolean;
  lut?: string;
  provenance: Provenance; // STU-5 → NFT metadata
}

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
