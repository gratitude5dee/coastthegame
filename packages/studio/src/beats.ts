/**
 * Beat grid + clock (goal.md AUD-2, MIS-2 beatSync): the track's `.beats.json` describes a constant-tempo grid; the
 * clock maps wall time to beats/bars, reports the signed distance to the nearest beat (for hop/jump/cut judging) and
 * hands out the beats crossed since the last poll (for beat-driven hydraulics, NPC dance, reveal effects).
 *
 * Plain numbers, no DOM/audio: the metronome and the track player live in the app. Variable-tempo grids (an explicit
 * `beats[]` array of ms) drop in later behind the same interface — v0 is constant tempo, which covers the $COAST catalogue.
 */

export interface BeatGrid {
  trackId: string;
  bpm: number;
  /** Time of beat 0 inside the track (ms). 0 when the track starts on the one. */
  offsetMs: number;
  beatsPerBar: number;
  /** Total bars in the track (for the reel / bar ranges); optional for loops. */
  bars?: number;
}

export interface BeatPhase {
  /** Fractional beat position since beat 0 (may be negative before the track starts). */
  beat: number;
  /** Index of the beat that most recently passed (floor). */
  beatIndex: number;
  /** 0-based beat within the bar. */
  beatInBar: number;
  /** 0-based bar index. */
  bar: number;
  /** Progress inside the current beat, 0..1. */
  progress: number;
  /** Signed ms to the nearest beat: negative = early (the beat is still coming), positive = late. |x| ≤ half a beat. */
  msToNearest: number;
  /** Index of that nearest beat. */
  nearestIndex: number;
}

export const DEFAULT_BEAT_GRID: BeatGrid = { trackId: 'coast-demo', bpm: 92, offsetMs: 0, beatsPerBar: 4, bars: 64 };

export class BeatClock {
  readonly grid: BeatGrid;
  /** Wall-clock ms (performance.now domain) at which the track's t=0 sits. */
  private startMs = 0;
  private lastPolledBeat = -1;
  private running = false;

  constructor(grid: BeatGrid = DEFAULT_BEAT_GRID) {
    if (!(grid.bpm > 0) || !(grid.beatsPerBar > 0)) throw new Error('BeatGrid needs bpm > 0 and beatsPerBar > 0');
    this.grid = { ...grid };
  }

  /** Beat period (ms). */
  get beatMs() {
    return 60_000 / this.grid.bpm;
  }

  get isRunning() {
    return this.running;
  }

  /** Start (or restart) the grid so that the track's t=0 is at `nowMs` (minus an optional playhead offset into the track). */
  start(nowMs: number, playheadMs = 0) {
    this.startMs = nowMs - playheadMs;
    this.running = true;
    this.lastPolledBeat = Math.floor(this.beatAt(nowMs));
  }

  stop() {
    this.running = false;
  }

  /** Fractional beat at a wall time. */
  beatAt(nowMs: number): number {
    return (nowMs - this.startMs - this.grid.offsetMs) / this.beatMs;
  }

  /** Wall time (ms) of a beat index. */
  timeOf(beatIndex: number): number {
    return this.startMs + this.grid.offsetMs + beatIndex * this.beatMs;
  }

  phase(nowMs: number): BeatPhase {
    const beat = this.beatAt(nowMs);
    const beatIndex = Math.floor(beat);
    const progress = beat - beatIndex;
    const nearestIndex = Math.round(beat);
    const msToNearest = (beat - nearestIndex) * this.beatMs;
    const bpb = this.grid.beatsPerBar;
    const beatInBar = ((beatIndex % bpb) + bpb) % bpb;
    return { beat, beatIndex, beatInBar, bar: Math.floor(beatIndex / bpb), progress, msToNearest, nearestIndex };
  }

  /**
   * Beat indices crossed since the previous call (empty when stopped). Call once per frame; the first call after
   * `start()` returns nothing. Long stalls (tab hidden) return at most the last 8 beats so the world doesn't replay a
   * minute of hops.
   */
  crossed(nowMs: number): number[] {
    if (!this.running) return [];
    const b = Math.floor(this.beatAt(nowMs));
    if (b <= this.lastPolledBeat) return [];
    const from = Math.max(this.lastPolledBeat + 1, b - 7);
    const out: number[] = [];
    for (let i = from; i <= b; i++) out.push(i);
    this.lastPolledBeat = b;
    return out;
  }
}

/** Bar range (1-based, inclusive) → beat index range [first, lastExclusive). */
export function beatsForBars(grid: BeatGrid, barRange: [number, number]): [number, number] {
  const [a, b] = barRange;
  return [(a - 1) * grid.beatsPerBar, b * grid.beatsPerBar];
}
