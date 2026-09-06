/**
 * Procedural SFX (goal.md AUD-3 placeholders until the ElevenLabs / library catalogue lands): everything is synthesised
 * on one WebAudio graph — no assets, ~4 kB — so footsteps, the lowrider's engine and hydraulics, the spray can, the
 * clapper and a wind bed all exist from the first build on every tier. Spatial sounds go through three's
 * PositionalAudio (the listener rides the camera), so the idling car is audibly *over there*.
 *
 * The context starts on the first user gesture (autoplay policy); everything before that is silently dropped.
 */
import * as THREE from 'three';

export type Surface = 'grass' | 'dirt' | 'concrete';

export class Sfx {
  readonly listener = new THREE.AudioListener();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engine: {
    osc: OscillatorNode;
    sub: OscillatorNode;
    gain: GainNode;
    filter: BiquadFilterNode;
    audio: THREE.PositionalAudio;
  } | null = null;
  private sprayNode: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private wind: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private muted: boolean;
  volume = 0.8;

  constructor(camera: THREE.Camera, opts: { muted?: boolean } = {}) {
    camera.add(this.listener);
    this.muted = opts.muted ?? false;
  }

  get isMuted() {
    return this.muted;
  }

  get ready() {
    return !!this.ctx;
  }

  /** Call from a user-gesture handler (keydown / pointerdown / touchstart / XR select). Idempotent. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const ctx = this.listener.context;
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(ctx.destination);
      this.noise = this.makeNoise(ctx, 2);
      if (ctx.state === 'suspended') void ctx.resume();
      this.startWind();
    } catch (e) {
      console.warn('sfx unavailable', e);
      this.ctx = null;
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.02);
  }

  toggleMuted() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  // ── One-shots ───────────────────────────────────────────────────────────────────────────────────────────────

  /** A footfall: filtered noise burst, pitched by surface, louder with speed. */
  footstep(surface: Surface, speed: number, foot: 0 | 1) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    const base = surface === 'concrete' ? 1800 : surface === 'dirt' ? 700 : 500;
    filter.type = surface === 'concrete' ? 'bandpass' : 'lowpass';
    filter.frequency.value = base * (foot ? 1.08 : 0.94);
    filter.Q.value = surface === 'concrete' ? 2.5 : 0.8;
    const env = ctx.createGain();
    const amp = THREE.MathUtils.clamp(0.12 + speed * 0.05, 0.1, 0.45);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(amp, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, t + (surface === 'grass' ? 0.11 : 0.07));
    src.connect(filter).connect(env).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.15);
  }

  /** Jump take-off (whoosh) and landing (thud). */
  jump() {
    this.burst({ from: 400, to: 1400, ms: 140, gain: 0.12, type: 'bandpass', q: 1.2 });
  }
  land(hard = false) {
    this.thump(hard ? 70 : 90, hard ? 0.35 : 0.22, 0.14);
    this.burst({ from: 900, to: 300, ms: 90, gain: 0.18, type: 'lowpass', q: 0.7 });
  }

  /** Hydraulic hop: the pump's hiss, then the chassis thump. */
  hydraulic(corners: number) {
    this.burst({ from: 2500, to: 600, ms: 160 + corners * 20, gain: 0.22, type: 'bandpass', q: 3 });
    setTimeout(() => this.thump(55, 0.3, 0.16), 120);
  }

  /** Clapperboard on action / cut. */
  clapper() {
    this.thump(220, 0.3, 0.04);
    this.burst({ from: 3000, to: 3000, ms: 35, gain: 0.25, type: 'bandpass', q: 6 });
  }

  /** Grab / drop / throw ticks. */
  tick(pitch = 1200) {
    this.burst({ from: pitch, to: pitch * 0.7, ms: 40, gain: 0.1, type: 'bandpass', q: 5 });
  }

  // ── Continuous ──────────────────────────────────────────────────────────────────────────────────────────────

  /** Start the lowrider's engine hum on an object (positional). Safe to call repeatedly. */
  engineStart(anchor: THREE.Object3D) {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.engine) return;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 42;
    const sub = ctx.createOscillator();
    sub.type = 'triangle';
    sub.frequency.value = 21;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 220;
    filter.Q.value = 1.5;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(filter);
    sub.connect(filter);
    filter.connect(gain);
    const audio = new THREE.PositionalAudio(this.listener);
    audio.setNodeSource(gain as unknown as AudioBufferSourceNode);
    audio.setRefDistance(3);
    audio.setRolloffFactor(1.2);
    audio.setDistanceModel('inverse');
    anchor.add(audio);
    // PositionalAudio routes into the listener's gain → destination; route it through the master for mute instead.
    audio.gain.disconnect();
    audio.gain.connect(this.master);
    osc.start();
    sub.start();
    this.engine = { osc, sub, gain, filter, audio };
  }

  /** Per frame: pitch and loudness follow speed and throttle. */
  engineUpdate(speedMs: number, throttle: number, running: boolean) {
    const e = this.engine;
    const ctx = this.ctx;
    if (!e || !ctx) return;
    const t = ctx.currentTime;
    const s = Math.abs(speedMs);
    const rpm = 42 + s * 6 + Math.abs(throttle) * 14;
    e.osc.frequency.setTargetAtTime(rpm, t, 0.08);
    e.sub.frequency.setTargetAtTime(rpm / 2, t, 0.08);
    e.filter.frequency.setTargetAtTime(180 + s * 40 + Math.abs(throttle) * 200, t, 0.1);
    const g = running ? 0.05 + Math.abs(throttle) * 0.12 + Math.min(s, 12) * 0.006 : 0.03;
    e.gain.gain.setTargetAtTime(g, t, 0.06);
  }

  engineStop() {
    const e = this.engine;
    if (!e) return;
    try {
      e.osc.stop();
      e.sub.stop();
    } catch {
      /* already stopped */
    }
    e.audio.removeFromParent();
    this.engine = null;
  }

  /** Spray can hiss while the trigger is held. */
  spraySet(on: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    if (on && !this.sprayNode) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 3200;
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      gain.gain.setTargetAtTime(0.16, ctx.currentTime, 0.02);
      src.connect(filter).connect(gain).connect(this.master);
      src.start();
      this.sprayNode = { src, gain };
    } else if (!on && this.sprayNode) {
      const n = this.sprayNode;
      this.sprayNode = null;
      n.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.03);
      setTimeout(() => {
        try {
          n.src.stop();
        } catch {
          /* already stopped */
        }
      }, 200);
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────────────────────────

  private startWind() {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.wind) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 380;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.11;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 140;
    lfo.connect(lfoGain).connect(filter.frequency);
    const gain = ctx.createGain();
    gain.gain.value = 0.035;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    lfo.start();
    this.wind = { src, gain };
  }

  private burst(o: { from: number; to: number; ms: number; gain: number; type: BiquadFilterType; q: number }) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type;
    filter.Q.value = o.q;
    filter.frequency.setValueAtTime(o.from, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + o.ms / 1000);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(o.gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + o.ms / 1000);
    src.connect(filter).connect(env).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + o.ms / 1000 + 0.05);
  }

  private thump(freq: number, gain: number, seconds: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * 0.4), t + seconds);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + seconds + 0.02);
  }

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
}
