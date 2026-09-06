/**
 * Input → Intents (goal.md INP-1). Devices produce Intents; gameplay never reads raw devices (PLT-2).
 */
export type Hand = 'left' | 'right';

export interface Ray {
  origin: [number, number, number];
  dir: [number, number, number];
}

export type Intent =
  | { type: 'move'; v: [number, number] }
  | { type: 'look'; v: [number, number] }
  | { type: 'jump' }
  | { type: 'sprint'; on: boolean }
  | { type: 'interact' }
  | { type: 'grab'; hand: Hand }
  | { type: 'release'; hand: Hand }
  | { type: 'point'; hand: Hand; ray: Ray }
  | { type: 'select'; ray: Ray }
  | { type: 'pinch'; hand: Hand; strength: number }
  | { type: 'gesture'; name: string }
  | { type: 'ptt'; on: boolean } // push-to-talk edge (DIR-1): left pinch-and-hold / T / thumbstick click
  | { type: 'menu' }
  | { type: 'modeCycle' }
  | { type: 'vehicle'; throttle?: number; steer?: number; brake?: number; hop?: boolean };

export interface IntentProvider {
  readonly id: string;
  /** Called once per fixed step; push intents into `out`. */
  poll(dtSeconds: number, out: Intent[]): void;
  dispose(): void;
}

/**
 * Deixis buffer sample (goal.md INP-3 / DIR-3). Recorded at ~30 Hz for the last 4 s.
 * "head" is a head ray — no platform exposes eye gaze to the page (Vision Pro included).
 */
export interface DeixisSample {
  t: number; // ms, performance.now()
  pointerHit?: string; // object id under the mouse/touch ray
  handHit?: { hand: Hand; id: string; point: [number, number, number] };
  headHit?: string;
  selection?: string;
  groundPoint?: [number, number, number]; // ground/navmesh hit of the best available ray
  pinchStrength?: number; // 0..1 (right hand)
  clickEdge?: boolean; // mouse/touch/trigger pressed this sample
}

export class DeixisBuffer {
  private samples: DeixisSample[] = [];
  constructor(private readonly windowMs = 4000) {}
  push(s: DeixisSample) {
    this.samples.push(s);
    const cutoff = s.t - this.windowMs;
    while (this.samples.length && (this.samples[0]?.t ?? 0) < cutoff) this.samples.shift();
  }
  /** Nearest sample to time t (ms). */
  at(t: number): DeixisSample | undefined {
    let best: DeixisSample | undefined;
    let bestD = Infinity;
    for (const s of this.samples) {
      const d = Math.abs(s.t - t);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }
  /** Samples with t in [from, to]. */
  between(from: number, to: number): DeixisSample[] {
    return this.samples.filter((s) => s.t >= from && s.t <= to);
  }
  clear() {
    this.samples.length = 0;
  }
}
