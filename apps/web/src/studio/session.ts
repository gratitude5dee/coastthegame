/**
 * Studio session (M3.5 slice): mission → action → take → cut → verdict → billboard playback / download.
 * - Video: real-time capture of the beauty render via `canvas.captureStream` + MediaRecorder (the offline
 *   fixed-step re-render with passes is M6, STU-1/2). The clip is the billboard texture and the download (STU-3 video-only).
 * - Poses: TakeRecorder at 30 Hz (ACT-2) → TakePlayer drives a ghost actor on playback.
 * - Judge: ShotMeter live scores → Verdict at cut (MIS-2/3).
 */
import * as THREE from 'three';
import {
  MISSION_LOW_AND_SLOW,
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

export interface FrameContext {
  nowMs: number;
  feet: THREE.Vector3;
  yaw: number;
  speed: number;
  grounded: boolean;
  camera: THREE.PerspectiveCamera;
  cameraHeightM: number;
  subjectInFrame: boolean;
  timePreset: MeterSample['timePreset'];
  cell: string;
}

export class StudioSession {
  state: SessionState = 'idle';
  mission: Mission = MISSION_LOW_AND_SLOW;
  takesUsed = 0;
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
    scene: THREE.Scene,
    playerTemplate: THREE.Group,
    private readonly canvas: HTMLCanvasElement,
    private readonly cellVersion: string,
  ) {
    this.card = createMissionCard(parent);
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

  /** The Photographer hands out the mission (or `?mission=1` auto-briefs for QA). */
  brief() {
    if (this.state !== 'idle') return;
    this.state = 'briefed';
    this.card.brief(this.mission);
    this.card.setStatus('Press Enter (or ACTION) to roll');
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
    try {
      const stream = (this.canvas as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream }).captureStream?.(30);
      if (stream && typeof MediaRecorder !== 'undefined') {
        const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((m) =>
          MediaRecorder.isTypeSupported(m),
        );
        this.media = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
        this.media.ondataavailable = (e) => {
          if (e.data.size > 0) this.chunks.push(e.data);
        };
        this.media.start(250);
      }
    } catch (e) {
      console.warn('video capture unavailable — recording poses only', e);
      this.media = null;
    }
    performance.mark('coast:take-start');
  }

  /** Per-frame while recording: sample poses + judge. */
  tick(ctx: FrameContext) {
    if (this.playing) this.updatePlayback(ctx.nowMs);
    if (this.state !== 'recording') return;
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
    });
    this.card.update(this.meter.live(t), t, true, this.takesUsed, this.mission.takesMax);
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
