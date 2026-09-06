/**
 * Studio session (M3.5 slice): mission → action → take → cut → verdict → billboard playback / download.
 * - Video: real-time capture of the beauty render via `canvas.captureStream(0)` + `requestFrame()` after every render
 *   (so every drawn frame reaches the encoder even at 2 fps on a weak GPU) + MediaRecorder (the offline fixed-step
 *   re-render with passes is M6, STU-1/2). The clip is the billboard texture and the download (STU-3 video-only).
 * - Poses: TakeRecorder at 30 Hz (ACT-2) → TakePlayer drives a ghost actor on playback.
 * - Judge: ShotMeter live scores → Verdict at cut (MIS-2/3).
 */
import * as THREE from 'three';
import {
  MISSIONS_V0,
  ShotMeter,
  TakePlayer,
  TakeRecorder,
  takeStore,
  type ConstraintResult,
  type MeterSample,
  type Mission,
  type TakeV1,
  type Verdict,
  type WorldEditInput,
} from '@coast/studio';
import { createMissionCard, type MissionCard } from '../ui/missionCard';

export type SessionState = 'idle' | 'briefed' | 'recording' | 'verdict';

/** Clip codecs in preference order; the first supported one records, the next takes over if it dies mid-take. */
const MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

export interface FrameContext {
  nowMs: number;
  feet: THREE.Vector3;
  yaw: number;
  speed: number;
  grounded: boolean;
  camera: THREE.PerspectiveCamera;
  cameraHeightM: number;
  /** The current mission's subject (see `StudioSession.subjectId`) is inside the frustum. */
  subjectInFrame: boolean;
  timePreset: MeterSample['timePreset'];
  cell: string;
  /** A judged event happened this frame (a manual hydraulic hop, a jump, a cut) and how far it was from the beat. */
  beatEvent?: MeterSample['beatEvent'];
  beatPhaseMs?: number;
}

export class StudioSession {
  state: SessionState = 'idle';
  /** The tutor's mission order; `mission` is the current one. */
  readonly missions: Mission[];
  missionIndex = 0;
  mission: Mission;
  takesUsed = 0;
  /** Stars earned per mission id (best take). */
  readonly stars = new Map<string, 0 | 1 | 2 | 3>();
  lastTake: TakeV1 | null = null;
  lastVerdict: Verdict | null = null;
  lastClipUrl: string | null = null;
  readonly card: MissionCard;
  /** Ghost actor driven by TakePlayer during playback (a translucent clone of the player placeholder). */
  readonly ghost: THREE.Group;
  private player: TakePlayer | null = null;
  private playbackStartMs = 0;
  playing = false;

  private meter: ShotMeter;
  private recorder: TakeRecorder;
  private media: MediaRecorder | null = null;
  private mediaCandidates: string[] = [];
  /** One capture stream per canvas, created on the first take and reused (re-capturing the same canvas is flaky). */
  private stream: MediaStream | null = null;
  private track: (MediaStreamTrack & { requestFrame?: () => void }) | null = null;
  private chunks: Blob[] = [];
  private startMs = 0;
  private readonly tmpQ = new THREE.Quaternion();
  private readonly ghostPose = {
    pos: [0, 0, 0] as [number, number, number],
    yaw: 0,
    speed: 0,
    camPos: [0, 0, 0] as [number, number, number],
    camQuat: [0, 0, 0, 1] as [number, number, number, number],
  };

  constructor(
    parent: HTMLElement,
    scene: THREE.Object3D,
    playerTemplate: THREE.Group,
    private readonly canvas: HTMLCanvasElement,
    private readonly cellVersion: string,
    missions: Mission[] = MISSIONS_V0,
    startIndex = 0,
  ) {
    this.card = createMissionCard(parent);
    this.missions = missions.length ? missions : MISSIONS_V0;
    this.missionIndex = Math.min(Math.max(0, startIndex), this.missions.length - 1);
    this.mission = this.missions[this.missionIndex]!;
    this.meter = new ShotMeter(this.mission);
    this.recorder = new TakeRecorder({ actorId: 'player', cellVersion });
    this.ghost = playerTemplate.clone(true);
    this.ghost.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.transparent = true;
        mat.opacity = 0.45;
        mat.color.setHex(0x9be34a);
        m.material = mat;
      }
    });
    this.ghost.visible = false;
    scene.add(this.ghost);
  }

  /** The mission's framing subject ('crate_1', 'lowrider', …) or null when it has no subjectInFrame constraint. */
  get subjectId(): string | null {
    const c = this.mission.constraints.find((k) => k.kind === 'subjectInFrame');
    return c && c.kind === 'subjectInFrame' ? c.subject : null;
  }

  /** The Photographer hands out the mission (or `?mission=n` auto-briefs for QA). */
  brief() {
    if (this.state !== 'idle') return;
    this.state = 'briefed';
    this.card.brief(this.mission);
    this.card.setStatus(
      this.takesUsed > 0
        ? `Take ${this.takesUsed + 1} of ${this.mission.takesMax} — Enter (or ACTION) to roll`
        : 'Press Enter (or ACTION) to roll',
    );
  }

  /**
   * The player walked away after a verdict: bank the stars and move on to the next mission when this one is earned
   * (≥ 1★) or out of takes; otherwise keep it so the tutor can brief it again. Returns the mission now on deck.
   */
  leave(): Mission {
    if (this.state !== 'verdict') return this.mission;
    this.stopPlayback();
    const best = this.stars.get(this.mission.id) ?? 0;
    const done = best >= 1 || this.takesUsed >= this.mission.takesMax;
    if (done && this.missionIndex < this.missions.length - 1) {
      this.missionIndex++;
      this.mission = this.missions[this.missionIndex]!;
      this.meter = new ShotMeter(this.mission);
      this.takesUsed = 0;
      this.card.hide();
    } else if (done) {
      this.card.setStatus('reel complete — replay any mission from the photographer');
      this.takesUsed = 0;
    }
    this.state = 'idle';
    return this.mission;
  }

  get canRoll() {
    return (this.state === 'briefed' || this.state === 'verdict') && this.takesUsed < this.mission.takesMax;
  }

  /** Enter / ACTION: roll if briefed, cut if recording. Returns what happened. */
  action(ctx: FrameContext): 'rolled' | 'cut' | 'ignored' {
    if (this.state === 'recording') {
      void this.cut(ctx.nowMs);
      return 'cut';
    }
    if (!this.canRoll) return 'ignored';
    this.roll(ctx);
    return 'rolled';
  }

  private roll(ctx: FrameContext) {
    this.stopPlayback();
    this.state = 'recording';
    this.startMs = ctx.nowMs;
    this.meter.reset();
    this.recorder.start(ctx.nowMs);
    this.chunks = [];
    this.media = null;
    this.mediaCandidates = MIME_CANDIDATES.filter((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
    this.startMedia();
    performance.mark('coast:take-start');
  }

  /**
   * Start (or restart) the clip recorder with the next codec candidate. A recorder that dies mid-take (some headless /
   * software-GL browsers kill the encoder after a few captures) is replaced once per candidate; when every candidate is
   * gone the take keeps recording poses and the verdict says so — the clip is a bonus, the judge never depends on it.
   */
  private startMedia() {
    const mime = this.mediaCandidates.shift();
    if (mime === undefined) {
      this.media = null;
      return;
    }
    try {
      const stream = this.captureStream();
      if (!stream) throw new Error('canvas.captureStream unavailable');
      const m = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
      m.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      // Not our stop: the encoder died. Try the next candidate while the take is still rolling.
      m.onstop = m.onerror = () => {
        if (this.media === m && this.state === 'recording') {
          console.warn(`clip recorder (${mime}) stopped early — trying the next codec`);
          this.startMedia();
        }
      };
      m.start(250);
      this.media = m;
    } catch (e) {
      console.warn(`clip recorder (${mime}) unavailable`, e);
      this.startMedia();
    }
  }

  /** Frame-driven capture when the browser has `requestFrame` (Chromium, Firefox), else a 30 fps auto-capture. */
  private captureStream(): MediaStream | null {
    if (this.stream) return this.stream;
    const canvas = this.canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream };
    if (!canvas.captureStream) return null;
    let stream = canvas.captureStream(0);
    let track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
    if (!track || typeof track.requestFrame !== 'function') {
      stream.getTracks().forEach((t) => t.stop());
      stream = canvas.captureStream(30);
      track = stream.getVideoTracks()[0] as typeof track;
    }
    this.stream = stream;
    this.track = track ?? null;
    return stream;
  }

  /** The game calls this right after `renderer.render()`: pushes the drawn frame into the clip while recording. */
  frameRendered() {
    if (this.state === 'recording' && this.media && this.track?.requestFrame) this.track.requestFrame();
  }

  /** Per-frame while recording: sample poses + judge. */
  tick(ctx: FrameContext) {
    if (this.playing) this.updatePlayback(ctx.nowMs);
    if (this.state !== 'recording') return;
    if (this.media && this.media.state === 'inactive') this.startMedia(); // died without firing stop/error
    const t = (ctx.nowMs - this.startMs) / 1000;
    const q = ctx.camera.quaternion;
    this.recorder.sample(ctx.nowMs, {
      pos: [ctx.feet.x, ctx.feet.y, ctx.feet.z],
      yaw: ctx.yaw,
      speed: ctx.speed,
      grounded: ctx.grounded,
      camPos: [ctx.camera.position.x, ctx.camera.position.y, ctx.camera.position.z],
      camQuat: [q.x, q.y, q.z, q.w],
    });
    const fwd = ctx.camera.getWorldDirection(new THREE.Vector3());
    const pitchDeg = (Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1)) * 180) / Math.PI;
    this.meter.push({
      t,
      cameraHeightM: ctx.cameraHeightM,
      cameraPitchDeg: pitchDeg,
      subjectInFrame: ctx.subjectInFrame,
      timePreset: ctx.timePreset,
      cell: ctx.cell,
      ...(ctx.beatEvent ? { beatEvent: ctx.beatEvent, beatPhaseMs: ctx.beatPhaseMs } : {}),
    });
    this.card.update(this.meter.live(t), t, true, this.takesUsed + 1, this.mission.takesMax); // the take being shot, 1-based
  }

  /** Record a world edit into the running take (put-that-there, grab, throw). */
  edit(nowMs: number, e: WorldEditInput) {
    if (this.state === 'recording') this.recorder.edit(nowMs, e);
  }

  private async cut(nowMs: number) {
    if (this.state !== 'recording') return;
    const elapsed = (nowMs - this.startMs) / 1000;
    const take = this.recorder.stop(nowMs);
    this.lastTake = take;
    this.takesUsed++;
    this.state = 'verdict';
    const verdict = this.meter.finish(elapsed, take.id);
    this.lastVerdict = verdict;
    if (verdict.stars > (this.stars.get(this.mission.id) ?? 0)) this.stars.set(this.mission.id, verdict.stars);
    performance.mark('coast:take-cut');
    void takeStore.save(take).catch(() => {});

    const clip = await this.stopMedia();
    if (this.lastClipUrl) URL.revokeObjectURL(this.lastClipUrl);
    this.lastClipUrl = clip ? URL.createObjectURL(clip) : null;
    const ext = clip?.type.includes('mp4') ? 'mp4' : 'webm';
    this.card.verdict(verdict, {
      downloadUrl: this.lastClipUrl ?? undefined,
      downloadName: `coast-${this.mission.id}-take${this.takesUsed}.${ext}`,
      onRetake: this.takesUsed < this.mission.takesMax ? () => this.retake() : undefined,
      onPlayback: () => this.startPlayback(performance.now()),
    });
    this.onClip?.(this.lastClipUrl, verdict);
    this.startPlayback(performance.now());
  }

  /** Hook for the game: show the clip on the billboard. */
  onClip: ((url: string | null, verdict: Verdict) => void) | null = null;

  private stopMedia(): Promise<Blob | null> {
    const m = this.media;
    this.media = null;
    if (!m) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = () => resolve(this.chunks.length ? new Blob(this.chunks, { type: m.mimeType || 'video/webm' }) : null);
      m.onstop = done;
      m.onerror = done;
      try {
        if (m.state !== 'inactive') m.stop();
        else done();
      } catch {
        done();
      }
    });
  }

  retake() {
    if (this.state !== 'verdict' || this.takesUsed >= this.mission.takesMax) return;
    this.stopPlayback();
    this.state = 'briefed';
    this.card.brief(this.mission);
    this.card.setStatus(`Take ${this.takesUsed + 1} of ${this.mission.takesMax} — Enter to roll`);
  }

  startPlayback(nowMs: number) {
    if (!this.lastTake || this.lastTake.samples.length < 2) return;
    this.player = new TakePlayer(this.lastTake);
    this.playbackStartMs = nowMs;
    this.playing = true;
    this.ghost.visible = true;
  }

  stopPlayback() {
    this.playing = false;
    this.ghost.visible = false;
  }

  togglePlayback(nowMs: number) {
    if (this.playing) this.stopPlayback();
    else this.startPlayback(nowMs);
  }

  private updatePlayback(nowMs: number) {
    const p = this.player;
    if (!p) return;
    const t = ((nowMs - this.playbackStartMs) / 1000) % Math.max(p.durationS, 0.001);
    const pose = p.poseAt(t, this.ghostPose);
    this.ghost.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    this.ghost.rotation.y = pose.yaw;
    this.tmpQ.set(pose.camQuat[0], pose.camQuat[1], pose.camQuat[2], pose.camQuat[3]);
  }

  liveResults(): ConstraintResult[] | null {
    return this.state === 'recording' ? this.meter.live((performance.now() - this.startMs) / 1000) : null;
  }
}
