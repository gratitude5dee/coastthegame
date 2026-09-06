/**
 * Footstep cadence (goal.md AUD-3): steps fire on distance travelled, not on time, so they stay glued to the feet at
 * any frame rate — a stride every `walkStride` m, shorter when sprinting, and a landing step after air time.
 * Pure numbers; the game turns events into sounds.
 */
export type StepEvent = 'step' | 'land';

export interface StrideOptions {
  walkStride?: number; // m per footfall
  sprintStride?: number;
  sprintAbove?: number; // m/s above which the sprint stride applies
  minSpeed?: number; // below this the feet are considered still (no steps)
}

export class StrideTracker {
  readonly walkStride: number;
  readonly sprintStride: number;
  readonly sprintAbove: number;
  readonly minSpeed: number;
  private travelled = 0;
  private wasGrounded = true;
  private airTime = 0;
  /** 0 = left, 1 = right, alternating. */
  foot = 0;

  constructor(opts: StrideOptions = {}) {
    this.walkStride = opts.walkStride ?? 0.75;
    this.sprintStride = opts.sprintStride ?? 1.1;
    this.sprintAbove = opts.sprintAbove ?? 4.5;
    this.minSpeed = opts.minSpeed ?? 0.3;
  }

  /**
   * Feed one frame: horizontal speed (m/s), grounded flag and dt (s). Returns the events for this frame — at most one
   * 'step' (long frames never machine-gun) and a 'land' when the feet touch down after ≥ 120 ms in the air.
   */
  update(speed: number, grounded: boolean, dt: number): StepEvent[] {
    const out: StepEvent[] = [];
    if (!grounded) {
      this.airTime += dt;
      this.wasGrounded = false;
      return out;
    }
    if (!this.wasGrounded) {
      this.wasGrounded = true;
      if (this.airTime >= 0.12) {
        out.push('land');
        this.travelled = 0;
      }
      this.airTime = 0;
    }
    if (speed < this.minSpeed) {
      this.travelled = 0;
      return out;
    }
    this.travelled += speed * dt;
    const stride = speed >= this.sprintAbove ? this.sprintStride : this.walkStride;
    if (this.travelled >= stride) {
      this.travelled = this.travelled % stride;
      this.foot = 1 - this.foot;
      out.push('step');
    }
    return out;
  }

  reset() {
    this.travelled = 0;
    this.airTime = 0;
    this.wasGrounded = true;
  }
}
