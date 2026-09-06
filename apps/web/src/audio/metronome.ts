/**
 * Metronome (goal.md AUD-2 stand-in until the $COAST tracks land): WebAudio clicks scheduled ahead of time from the
 * BeatClock (accent on the one), so hop-on-the-beat has something to hop to. Created lazily on a user gesture
 * (autoplay policy); `tick()` once per frame keeps ~200 ms of clicks queued. No audio assets, ~1 kB.
 */
import * as THREE from 'three';
import type { BeatClock } from '@coast/studio';

export class Metronome {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nextBeat = 0;
  private enabled = false;
  volume = 0.35;

  constructor(private readonly clock: BeatClock) {}

  get isEnabled() {
    return this.enabled;
  }

  /** Enable on a user gesture (keydown / pointerdown handler) — resumes or creates the AudioContext. */
  enable(nowMs: number) {
    try {
      if (!this.ctx) {
        this.ctx = THREE.AudioContext.getContext(); // one context for the whole game (three's listener shares it)
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this.volume;
        this.gain.connect(this.ctx.destination);
      }
      void this.ctx.resume();
      this.enabled = true;
      this.nextBeat = Math.floor(this.clock.beatAt(nowMs)) + 1;
    } catch (e) {
      console.warn('metronome unavailable', e);
      this.enabled = false;
    }
  }

  disable() {
    this.enabled = false;
  }

  toggle(nowMs: number) {
    if (this.enabled) this.disable();
    else this.enable(nowMs);
    return this.enabled;
  }

  /** Per frame: schedule every beat that starts within the next 200 ms. */
  tick(nowMs: number) {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || !this.gain || !this.clock.isRunning) return;
    const horizonMs = nowMs + 200;
    const current = Math.floor(this.clock.beatAt(nowMs));
    if (this.nextBeat < current) this.nextBeat = current + 1; // fell behind (tab hidden): skip, never burst
    while (this.clock.timeOf(this.nextBeat) <= horizonMs) {
      const wallMs = this.clock.timeOf(this.nextBeat);
      const at = Math.max(ctx.currentTime, ctx.currentTime + (wallMs - nowMs) / 1000);
      const bpb = this.clock.grid.beatsPerBar;
      const accent = ((this.nextBeat % bpb) + bpb) % bpb === 0;
      this.click(ctx, at, accent);
      this.nextBeat++;
    }
  }

  private click(ctx: AudioContext, at: number, accent: boolean) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1320 : 880;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(accent ? 1 : 0.6, at + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0001, at + (accent ? 0.07 : 0.045));
    osc.connect(env).connect(this.gain!);
    osc.start(at);
    osc.stop(at + 0.09);
  }
}
