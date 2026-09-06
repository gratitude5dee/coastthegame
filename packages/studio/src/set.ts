/**
 * The set (goal.md ACT-2 "multiple actors can replay concurrently — multi-take blocking", §3.1 step 5): the takes shot
 * so far for the current mission, replayed *together*. Every earlier take performs again, in sync with the take clock,
 * while the next one rolls — so one player builds a scene role by role: take 1 as $COAST, take 2 as the Photographer
 * framing them, take 3 driving past both (the 3-take demo). After the cut the whole set loops.
 *
 * Pure: no three.js, no DOM. The game gives each layer a ghost body and asks for poses; a layer whose take is shorter
 * than the set holds its last pose (an actor holding the mark), it never disappears mid-shot.
 */
import { TakePlayer, type TakePose, type TakeV1, type WorldEdit } from './takes';

export interface SetLayer {
  readonly take: TakeV1;
  readonly player: TakePlayer;
  /** Set time the layer's edits were last pulled up to (see `editsSince`). */
  lastT: number;
}

export class TakeSet {
  readonly layers: SetLayer[] = [];

  /** `maxLayers` bounds the ghosts on screen (and the CPU): beyond it the oldest take drops off the set. */
  constructor(readonly maxLayers = 3) {}

  get size() {
    return this.layers.length;
  }

  /** Length of the longest take — the loop length when the set plays back on its own. */
  get durationS(): number {
    let d = 0;
    for (const l of this.layers) d = Math.max(d, l.take.durationS);
    return d;
  }

  add(take: TakeV1): SetLayer {
    const layer: SetLayer = { take, player: new TakePlayer(take), lastT: 0 };
    this.layers.push(layer);
    while (this.layers.length > this.maxLayers) this.layers.shift();
    return layer;
  }

  /** Forget a take (a retake the player scrapped, or a mission change). */
  remove(takeId: string): boolean {
    const i = this.layers.findIndex((l) => l.take.id === takeId);
    if (i < 0) return false;
    this.layers.splice(i, 1);
    return true;
  }

  clear() {
    this.layers.length = 0;
  }

  /** Pose of layer `i` at set time `tS` (seconds from the set's start). Holds at the take's end. */
  poseAt(i: number, tS: number, out?: TakePose): TakePose | null {
    const l = this.layers[i];
    return l ? l.player.poseAt(tS, out) : null;
  }

  /**
   * World edits of layer `i` that fall in (lastT, tS] — call once per frame with the set time; a time that went backwards
   * (the loop restarted) replays from the start, so a looping set repaints every lap.
   */
  editsSince(i: number, tS: number): WorldEdit[] {
    const l = this.layers[i];
    if (!l) return [];
    const from = tS < l.lastT ? -Infinity : l.lastT;
    l.lastT = tS;
    return l.player.editsBetween(from, tS);
  }

  /** Reset the edit cursors (a new playback run). */
  rewind() {
    for (const l of this.layers) l.lastT = -Infinity;
  }
}

/** Set time for a playback that started at `startMs`: looping wraps at the set length, a rolling take just counts up. */
export function setTime(nowMs: number, startMs: number, durationS: number, loop: boolean): number {
  const t = Math.max(0, (nowMs - startMs) / 1000);
  if (!loop) return t;
  const d = Math.max(durationS, 0.001);
  return t % d;
}
