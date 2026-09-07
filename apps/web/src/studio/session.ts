/**
 * Studio session (M3.5 slice): mission → action → take → cut → verdict → billboard playback / download.
 * - Video: real-time capture of the beauty render via `canvas.captureStream(0)` + `requestFrame()` after every render
 *   (so every drawn frame reaches the encoder even at 2 fps on a weak GPU) + MediaRecorder (the offline fixed-step
 *   re-render with passes is M6, STU-1/2). The clip is the billboard texture and the download (STU-3 video-only).
 * - Poses: TakeRecorder at 30 Hz (ACT-2) → the mission's takes form a *set* (TakeSet, multi-take blocking): every
 *   earlier take replays as a ghost, in sync, while the next one rolls, and the whole set loops after the cut.
 * - Possession (ACT-3): `actorId` names who is performing; each take carries it and its ghost wears that look.
 * - Judge: ShotMeter live scores → Verdict at cut (MIS-2/3).
 */
import * as THREE from 'three';
import {
  MISSIONS_V0,
  Reel,
  ShotMeter,
  TakeRecorder,
  TakeSet,
  DEFAULT_BEAT_GRID,
  buildCutManifest,
  captionTrack,
  planCut,
  setTime,
  takeStore,
  type CutManifest,
  type CutOptions,
  type ConstraintResult,
  type MeterSample,
  type Mission,
  type PropPose,
  type TakePose,
  type TakeV1,
  type Verdict,
  type WorldEditInput,
} from '@coast/studio';
import { createMissionCard, type MissionCard } from '../ui/missionCard';
import { GhostActor, type ActorLook } from './ghosts';
import { exportCut, type ExportResult, type ExportScene, type Overlay } from './exporter';
import { sha256Hex, uploadCut, uploadCutManifest, uploadTake } from '../api';

/** Gives a ghost body to a take's performer (the game knows the looks; tests get capsules). */
export type GhostFactory = (actorId: string) => GhostActor;

export type SessionState = 'idle' | 'briefed' | 'recording' | 'verdict';

/** Clip codecs in preference order; the first supported one records, the next takes over if it dies mid-take. */
const MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
/** How long a cut waits for the clip recorder's final chunk before moving on without it. */
const STOP_MEDIA_TIMEOUT_MS = 4000;

export interface FrameContext {
  nowMs: number;
  feet: THREE.Vector3;
  yaw: number;
  speed: number;
  grounded: boolean;
  /** At the wheel of the lowrider (the pose is the car's). */
  driving?: boolean;
  /** Awake props this frame (the recorder keeps the ones that move, ACT-2). */
  props?: { id: string; pos: [number, number, number]; quat: [number, number, number, number] }[];
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
  /** Who is performing the next take ('player' unless possessing an NPC, ACT-3). */
  actorId = 'player';
  /** The mission's takes so far — they replay together (multi-take blocking). */
  readonly set = new TakeSet(3);
  /** One ghost body per set layer, same order. */
  readonly ghosts: GhostActor[] = [];
  private playbackStartMs = 0;
  private playbackLoop = true;
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
  private readonly ghostPose: TakePose = {
    pos: [0, 0, 0],
    yaw: 0,
    speed: 0,
    driving: false,
    camPos: [0, 0, 0],
    camQuat: [0, 0, 0, 1],
  };
  private readonly makeGhost: GhostFactory;
  /** The game moves a prop to a replayed pose (kinematic replay of thrown / placed props, STU-1). */
  propWriter: ((id: string, pose: PropPose) => void) | null = null;
  private readonly propPose: PropPose = { t: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1] };
  /** The game lends its renderer/scene/camera for an export (null on surfaces that cannot export, e.g. XR). */
  exportScene: (() => Omit<ExportScene, 'seek'>) | null = null;
  lastCutUrl: string | null = null;
  exporting = false;
  /** Guest session id (the Worker keys takes and cuts by it); empty = never upload. */
  sessionId = '';
  lastShare: string | null = null;
  /** The provenance manifest of the last exported cut (STU-5). */
  lastManifest: CutManifest | null = null;
  /** The reel (MIS-4): best take + stars per mission, persisted across visits. */
  readonly reel: Reel;
  /** Watching an earned mission's take again (from the reel) — its own set and ghost, the mission's set untouched. */
  private review: { set: TakeSet; ghosts: GhostActor[]; missionId: string } | null = null;
  /** The game persists the reel (localStorage) and redraws the strip. */
  onReel: ((reel: Reel) => void) | null = null;

  constructor(
    parent: HTMLElement,
    scene: THREE.Object3D,
    playerTemplate: THREE.Group,
    private readonly canvas: HTMLCanvasElement,
    private readonly cellVersion: string,
    missions: Mission[] = MISSIONS_V0,
    startIndex = 0,
    ghostFactory?: GhostFactory,
  ) {
    this.card = createMissionCard(parent);
    this.missions = missions.length ? missions : MISSIONS_V0;
    this.missionIndex = Math.min(Math.max(0, startIndex), this.missions.length - 1);
    this.mission = this.missions[this.missionIndex]!;
    this.meter = new ShotMeter(this.mission);
    this.recorder = new TakeRecorder({ actorId: 'player', cellVersion });
    this.reel = new Reel(this.missions);
    const fallbackLook: ActorLook = { color: 0x9be34a, name: 'replay' };
    this.makeGhost = ghostFactory ?? (() => new GhostActor(scene, playerTemplate, null, fallbackLook));
  }

  /** The ghost bodies currently performing (visible during a rolling take or a looping playback). */
  get ghostsVisible() {
    return this.playing ? this.ghosts.length : 0;
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
      this.clearSet(); // a new shot: fresh set
      this.card.hide();
    } else if (done) {
      this.card.setStatus('reel complete — replay any mission from the photographer');
      this.takesUsed = 0;
      this.clearSet();
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
    this.recorder.start(ctx.nowMs, this.actorId);
    // Multi-take blocking: the earlier takes of this shot perform again, on the take clock, while this one rolls.
    if (this.set.size > 0) this.startPlayback(ctx.nowMs, false);
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
      driving: ctx.driving ?? false,
      camPos: [ctx.camera.position.x, ctx.camera.position.y, ctx.camera.position.z],
      camQuat: [q.x, q.y, q.z, q.w],
    });
    if (ctx.props) for (const p of ctx.props) this.recorder.sampleProp(ctx.nowMs, p.id, p.pos, p.quat);
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
    this.stopPlayback();
    this.addToSet(take);
    const verdict = this.meter.finish(elapsed, take.id);
    this.lastVerdict = verdict;
    if (verdict.stars > (this.stars.get(this.mission.id) ?? 0)) this.stars.set(this.mission.id, verdict.stars);
    this.reel.record(this.mission.id, verdict.stars, take.id);
    this.onReel?.(this.reel);
    performance.mark('coast:take-cut');
    void takeStore.save(take).catch(() => {});
    if (this.sessionId) void uploadTake(this.sessionId, take); // ACT-4: the R2 shelf, when the API is around

    const clip = await this.stopMedia();
    if (this.lastClipUrl) URL.revokeObjectURL(this.lastClipUrl);
    this.lastClipUrl = clip ? URL.createObjectURL(clip) : null;
    const ext = clip?.type.includes('mp4') ? 'mp4' : 'webm';
    this.card.verdict(verdict, {
      downloadUrl: this.lastClipUrl ?? undefined,
      downloadName: `coast-${this.mission.id}-take${this.takesUsed}.${ext}`,
      onRetake: this.takesUsed < this.mission.takesMax ? () => this.retake() : undefined,
      onPlayback: () => this.startPlayback(performance.now()),
      ...(this.exportScene && this.set.size > 0
        ? { onExport: () => void this.exportCutToCard(), onExportPortrait: () => void this.exportCutToCard({ width: 1080, height: 1920 }) }
        : {}),
    });
    this.onClip?.(this.lastClipUrl, verdict);
    this.startPlayback(performance.now(), true);
  }

  /** Hook for the game: show the clip on the billboard. */
  onClip: ((url: string | null, verdict: Verdict) => void) | null = null;

  private stopMedia(): Promise<Blob | null> {
    const m = this.media;
    this.media = null;
    if (!m) return Promise.resolve(null);
    return new Promise((resolve) => {
      // A recorder whose encoder died never fires `stop` (seen on software GL after a few captures): cap the wait and
      // keep whatever chunks it delivered — the verdict must never hang on the clip.
      const timer = setTimeout(() => {
        console.warn('clip recorder did not stop in time — keeping what it gave');
        done();
      }, STOP_MEDIA_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve(this.chunks.length ? new Blob(this.chunks, { type: m.mimeType || 'video/webm' }) : null);
      };
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

  /** Replay the set from `nowMs`: looping on its own (P, after a cut) or once, on the take clock, under a rolling take. */
  startPlayback(nowMs: number, loop = true) {
    this.stopReview();
    if (this.set.size === 0) return;
    this.playbackStartMs = nowMs;
    this.playbackLoop = loop;
    this.playing = true;
    this.set.rewind();
    for (const g of this.ghosts) g.visible = true;
    this.updatePlayback(nowMs);
  }

  stopPlayback() {
    if (this.review) {
      this.stopReview();
      return;
    }
    this.playing = false;
    for (const g of this.ghosts) g.visible = false;
  }

  togglePlayback(nowMs: number) {
    if (this.playing) this.stopPlayback();
    else this.startPlayback(nowMs, true);
  }

  private updatePlayback(nowMs: number) {
    const stage = this.review ?? { set: this.set, ghosts: this.ghosts };
    const t = setTime(nowMs, this.playbackStartMs, stage.set.durationS, this.playbackLoop);
    this.seekSet(t, stage.set, stage.ghosts);
  }

  /** Put every ghost and every replayed prop where the set has them at time `t`. */
  private seekSet(t: number, set = this.set, ghosts = this.ghosts) {
    for (let i = 0; i < ghosts.length; i++) {
      const pose = set.poseAt(i, t, this.ghostPose);
      if (pose) ghosts[i]!.setPose(pose);
    }
    if (this.propWriter) {
      for (const id of set.propIds()) {
        const p = set.propPoseAt(id, t, this.propPose);
        if (p) this.propWriter(id, p);
      }
    }
  }

  /**
   * Watch an earned mission's best take again (the reel, MIS-4): loaded from the session store, replayed on its own
   * ghost while the current mission's set stays as it is. Resolves false when there is nothing to watch.
   */
  async reviewMission(missionId: string, nowMs = performance.now()): Promise<boolean> {
    const entry = this.reel.entry(missionId);
    if (!entry?.takeId || this.state === 'recording') return false;
    const take = this.set.layers.find((l) => l.take.id === entry.takeId)?.take ?? (await takeStore.load(entry.takeId).catch(() => null));
    if (!take || take.samples.length < 2) return false;
    this.stopPlayback();
    this.stopReview();
    const set = new TakeSet(1);
    set.add(take);
    const ghost = this.makeGhost(take.actorId);
    this.review = { set, ghosts: [ghost], missionId };
    this.playbackStartMs = nowMs;
    this.playbackLoop = true;
    this.playing = true;
    ghost.visible = true;
    this.updatePlayback(nowMs);
    return true;
  }

  get reviewing(): string | null {
    return this.review?.missionId ?? null;
  }

  stopReview() {
    const r = this.review;
    if (!r) return;
    this.review = null;
    this.playing = false;
    for (const g of r.ghosts) g.dispose();
  }

  /**
   * Export the set as a Coast Cut (STU-1/STU-3): fixed-step, every take solid, the newest take's camera. Returns the
   * encoded clip; the card shows progress and the download.
   */
  async exportCut(
    opts: Omit<CutOptions, 'durationS'> & { captions?: boolean; credit?: string; id?: string } = {},
    onProgress?: (done: number, total: number) => void,
  ): Promise<ExportResult & { manifest: CutManifest }> {
    if (!this.exportScene) throw new Error('export is not available here');
    if (this.set.size === 0) throw new Error('nothing to export — cut a take first');
    if (this.exporting) throw new Error('already exporting');
    const { captions = true, credit, id: cutId, ...cut } = opts;
    const plan = planCut({ durationS: this.set.durationS, cameraLayer: this.set.size - 1, ...cut });
    const m = this.mission;
    const overlay: Overlay = {
      look: m.look,
      captions: captions
        ? captionTrack({
            title: m.title,
            subtitle: `${m.section ? `${m.section} · ` : ''}bars ${m.barRange[0]}–${m.barRange[1]}`,
            durationS: plan.endS - plan.startS,
            takes: this.set.layers.map((l) => l.take),
            ...(credit ? { credit } : {}),
          })
        : [],
    };
    const takes = this.set.layers.map((l) => l.take);
    // The provenance manifest (STU-5): everything the picture came from, hashed to the file once it exists.
    const manifestFor = (r: ExportResult, sha256?: string): CutManifest =>
      buildCutManifest({
        id: cutId ?? `${m.id}-${Date.now().toString(36)}`,
        title: m.title,
        missionId: m.id,
        trackId: m.trackId,
        barRange: m.barRange,
        bpm: DEFAULT_BEAT_GRID.bpm,
        look: m.look,
        takes,
        plan,
        captions: overlay.captions ?? [],
        video: { bytes: r.blob.size, mime: r.mime, codec: r.codec, ...(sha256 ? { sha256 } : {}) },
        cells: [{ id: this.cellVersion, version: this.cellVersion }],
        author: { userId: this.sessionId ?? 'guest' },
        app: { version: __COAST_VERSION__, commit: __COAST_COMMIT__ },
      });
    const camLayer = this.set.layers[Math.min(Math.max(0, plan.cameraLayer), this.set.size - 1)]!;
    const host = this.exportScene();
    const wasPlaying = this.playing;
    const camPose: TakePose = { pos: [0, 0, 0], yaw: 0, speed: 0, driving: false, camPos: [0, 0, 0], camQuat: [0, 0, 0, 1] };
    this.exporting = true;
    this.stopPlayback();
    try {
      const result = await exportCut(
        plan,
        {
          renderer: host.renderer,
          scene: host.scene,
          camera: host.camera,
          begin: () => {
            host.begin();
            for (const g of this.ghosts) {
              g.setSolid(true);
              g.visible = true;
            }
          },
          seek: (t) => {
            this.seekSet(t);
            const c = camLayer.player.poseAt(t, camPose);
            host.camera.position.set(c.camPos[0], c.camPos[1], c.camPos[2]);
            host.camera.quaternion.set(c.camQuat[0], c.camQuat[1], c.camQuat[2], c.camQuat[3]);
          },
          end: () => {
            for (const g of this.ghosts) g.setSolid(false);
            host.end();
            if (wasPlaying) this.startPlayback(performance.now(), true);
            else for (const g of this.ghosts) g.visible = false;
          },
        },
        onProgress,
        overlay,
      );
      return { ...result, manifest: manifestFor(result, await sha256Hex(result.blob)) };
    } finally {
      this.exporting = false;
    }
  }

  private async exportCutToCard(opts: { width?: number; height?: number } = {}) {
    try {
      const cutId = `${this.mission.id}-${Date.now().toString(36)}`;
      const r = await this.exportCut({ ...opts, id: cutId }, (done, total) => this.card.exportProgress(done, total));
      if (this.lastCutUrl) URL.revokeObjectURL(this.lastCutUrl);
      this.lastCutUrl = URL.createObjectURL(r.blob);
      const portrait = (opts.height ?? 0) > (opts.width ?? 1);
      this.card.exportReady(this.lastCutUrl, `coast-cut-${this.mission.id}${portrait ? '-9x16' : ''}.${r.ext}`);
      performance.mark('coast:cut-exported');
      this.reel.setCut(this.mission.id, this.lastCutUrl);
      this.lastManifest = r.manifest;
      if (this.sessionId) {
        const shared = await uploadCut(this.sessionId, cutId, r.blob, this.mission.title, r.manifest.video?.sha256);
        if (shared) {
          this.lastShare = shared.url;
          this.card.exportShared(shared.url);
          this.reel.setCut(this.mission.id, shared.url);
          void uploadCutManifest(this.sessionId, cutId, r.manifest); // the share page's credits (STU-5)
        }
      }
      this.onReel?.(this.reel);
    } catch (e) {
      console.warn('cut export failed', e);
      this.card.exportFailed(e instanceof Error ? e.message : String(e));
    }
  }

  private addToSet(take: TakeV1) {
    if (take.samples.length < 2) return;
    this.set.add(take);
    const ghost = this.makeGhost(take.actorId);
    this.ghosts.push(ghost);
    while (this.ghosts.length > this.set.size) this.ghosts.shift()?.dispose(); // the set dropped its oldest layer
  }

  private clearSet() {
    this.stopPlayback();
    this.set.clear();
    for (const g of this.ghosts) g.dispose();
    this.ghosts.length = 0;
  }

  dispose() {
    this.stopReview();
    this.clearSet();
    this.card.hide();
  }

  liveResults(): ConstraintResult[] | null {
    return this.state === 'recording' ? this.meter.live((performance.now() - this.startMs) / 1000) : null;
  }
}
