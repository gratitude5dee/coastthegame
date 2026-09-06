/**
 * Cut planning (goal.md STU-1/STU-3): an export is a fixed-step re-render of the set — every take performing, the
 * camera from one of them — at 30 fps (24 by re-timing), never a real-time capture. This module decides *which
 * frames*: the time range (the whole set, or a bar range of the track), the frame count and each frame's set time.
 * Pure numbers; the exporter (apps/web) renders and encodes them.
 */
import { DEFAULT_BEAT_GRID, type BeatGrid } from './beats';

/** 30 is the export rate (STU-1); 24 is derived by re-timing; anything lower is for QA runs. */
export type CutFps = number;

export interface CutOptions {
  /** Length of the set (its longest take), seconds. */
  durationS: number;
  fps?: CutFps;
  /** Bar range [first, last] (1-based, inclusive) on the beat grid; omit for the whole set. */
  bars?: [number, number];
  grid?: BeatGrid;
  width?: number;
  height?: number;
  /** Hard cap on the clip (STU: a Coast Cut is 15–60 s). */
  maxSeconds?: number;
  /** Which set layer's camera track drives the shot (default: the newest). */
  cameraLayer?: number;
}

export interface CutPlan {
  fps: CutFps;
  width: number;
  height: number;
  startS: number;
  endS: number;
  frameCount: number;
  cameraLayer: number;
}

export const CUT_MAX_SECONDS = 60;

/** Seconds from the track start to the beginning of `bar` (1-based). */
export function barStartS(bar: number, grid: BeatGrid = DEFAULT_BEAT_GRID): number {
  const secPerBeat = 60 / grid.bpm;
  return grid.offsetMs / 1000 + (bar - 1) * grid.beatsPerBar * secPerBeat;
}

export function planCut(o: CutOptions): CutPlan {
  const fps = Math.max(1, Math.min(60, o.fps ?? 30));
  const maxS = o.maxSeconds ?? CUT_MAX_SECONDS;
  let startS = 0;
  let endS = Math.max(0, o.durationS);
  if (o.bars) {
    const grid = o.grid ?? DEFAULT_BEAT_GRID;
    const [a, b] = o.bars;
    startS = Math.min(endS, Math.max(0, barStartS(Math.min(a, b), grid)));
    endS = Math.min(endS, barStartS(Math.max(a, b) + 1, grid));
  }
  endS = Math.min(endS, startS + maxS);
  const frameCount = Math.max(0, Math.round((endS - startS) * fps));
  return {
    fps,
    width: o.width ?? 1920,
    height: o.height ?? 1080,
    startS,
    endS: startS + frameCount / fps,
    frameCount,
    cameraLayer: o.cameraLayer ?? -1,
  };
}

/** Set time of frame `i` of the plan. */
export function frameTime(plan: CutPlan, i: number): number {
  return plan.startS + i / plan.fps;
}
