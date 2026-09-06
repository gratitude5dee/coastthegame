/**
 * Studio data model (goal.md §7.7 STU-*, §7.8 GEN-*). Implementation lands in M4 (takes) and M6 (shots/export).
 */
import type { Intent } from '@coast/engine';

export interface PoseFrame {
  t: number; // seconds from take start
  root: [number, number, number, number, number, number, number]; // pos xyz + quat xyzw
  bones?: Float32Array; // optional compact bone quats for exact replay
  intents?: Intent[];
}

export interface Take {
  id: string;
  actorId: string;
  worldVersion: string; // cell.json version — replays are only valid against it (ACT-4)
  fps: 30;
  frames: PoseFrame[];
  durationS: number;
}

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
