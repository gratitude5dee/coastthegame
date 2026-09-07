/**
 * Game orchestrator (M3 actor mode on sample worlds — goal.md ACT-1, PHY-1/2/3, CAM-1/2, INP-1/2, DIR-3 fallback).
 * Owns the scene, Spark, the cell/scene loader, physics, the possessed character, the lowrider, props, the beat clock,
 * the camera rig and the HUD. Input arrives only as FrameInput from providers (PLT-2). Simulation is fixed 60 Hz with
 * render interpolation (STU-1).
 */
import * as THREE from 'three';
import { SparkRenderer, SparkXr, SplatMesh } from '@sparkjsdev/spark';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  CameraPath,
  CameraRig,
  CharacterController,
  Lowrider,
  PhysicsWorld,
  PropSystem,
  SplatPainter,
  StrideTracker,
  budgetsFor,
  dioramaPlacement,
  flattestSpot,
  framePositionForHead,
  groundFromSplats,
  groundHeightAt,
  splatsReady,
  liftFromAxes,
  loadRapier,
  snapTurnShift,
  tablePoint,
  yawOf,
  zeroVehicleInput,
  HOP_CORNERS,
  Atmosphere,
  TIME_ORDER,
  isLookName,
  CellStreamer,
  Corridor,
  LevelGraph,
  corridorFrame,
  cutGroundForCorridor,
  fenceRect,
  type Cell,
  type CellContent,
  type GroundGrid,
  type Portal,
  type StreamEvent,
  type TimeOfDay,
  type HopPattern,
  type PlatformInfo,
  type RigMode,
  type RigTarget,
  type PropSpec,
  type VehicleInput,
  DeixisBuffer,
  type DeixisSample,
} from '@coast/engine';
import type { PostStack } from '@coast/engine/post';
import { BeatClock, type MeterSample } from '@coast/studio';
import { newFrameInput, resetFrameInput, type FrameInput, type InputProvider } from './input/intents';
import { KeyboardMouseProvider } from './input/keyboardMouse';
import { TouchProvider } from './input/touch';
import { GamepadProvider } from './input/gamepad';
import { XrControllerProvider } from './input/xrControllers';
import { initPerf } from './perf';
import { StudioSession, type FrameContext } from './studio/session';
import { Metronome } from './audio/metronome';
import { Sfx } from './audio/sfx';
import { Tts } from './audio/tts';
import { NpcSystem, type Npc, type NpcSpec } from './npc/npcs';
import { GhostActor } from './studio/ghosts';
import { RealtimeClient, type CameraRequest, type SceneOps, type UtteranceOutcome } from '@coast/director';
import { DirectorConsole, spokenReply, summarize } from './director/console';
import { VoiceInput } from './director/voice';
import { connectRealtime, type RealtimeSession } from './director/realtimeWebrtc';
import { createSubtitles, type Subtitles } from './ui/subtitles';
import { createReelStrip, type ReelStrip } from './ui/reel';
import { createLoadingScreen, type LoadingScreen } from './ui/loading';
import {
  LEVELS,
  LOCAL_BUTTERFLY,
  SCENES,
  SCENE_ORDER,
  hubKit,
  levelForScene,
  soloLevel,
  worldDef,
  type LevelDef,
  type SceneDef,
} from './world/levels';

export type { SceneDef } from './world/levels';
export { SCENES, SCENE_ORDER, LOCAL_BUTTERFLY } from './world/levels';

/** A cell that is in the world right now (W-3): its splat, and once loaded its ground and colliders. */
interface ResidentCell {
  id: string;
  def: SceneDef;
  mesh: SplatMesh;
  loaded: boolean;
  ground: GroundGrid | null;
  colliders: ReturnType<PhysicsWorld['addStaticBox']>[];
  groundMesh: THREE.Mesh | null;
  colliderMeshes: THREE.Object3D[];
  cell?: Cell;
  /** What this cell put into the world (W-3 "content follows the cell", ADR-0011) — taken out again when it unloads. */
  content: { props: string[]; npcs: string[]; vehicle: boolean; spawned: boolean };
}

const noContent = () => ({ props: [], npcs: [], vehicle: false, spawned: false });

const RIG_ORDER: RigMode[] = ['actor', 'director', 'producer'];
const EYE_HEIGHT = 1.62;
/** Lowrider camera target: "feet" sit this far below the chassis centre; the driver's eye this far above them. */
const CAR_FEET_DROP = 0.6;
const CAR_EYE_HEIGHT = 1.55;
const CAR_FOLLOW = { distance: 2.1, height: 1.0 };
/** Beat-driven hydraulics pattern per beat in the bar (PHY-3 "driven by the track's beat grid"). */
const AUTO_HOP_PATTERN: HopPattern[] = ['front', 'back', 'left', 'right'];
const ENTER_DISTANCE = 3.4;
/** Possession reach (ACT-3): the nearest NPC within this many metres swaps bodies with you on V / Back / BE. */
const POSSESS_DISTANCE = 4;
/** $COAST — the identity the player starts with; an unpossessed $COAST loiters like any NPC. */
const PLAYER_IDENTITY: NpcSpec = {
  id: 'player',
  name: '$COAST',
  color: 0xffb54a,
  home: new THREE.Vector3(),
  lines: ['West Coast.', 'Roll it.'],
  approaches: false,
};
const LEAVE_DISTANCE = 4.5;
const VERDICT_GRACE_MS = 6000;

export interface GameOptions {
  platform: PlatformInfo;
  params: URLSearchParams;
  hud: HTMLElement;
  sessionId: string;
}

declare global {
  interface Window {
    __coastReady?: boolean;
    __coastLod?: boolean;
    __coastFrame?: number;
    __coastSteps?: number;
    __coastPhysics?: boolean;
    __coastVehicle?: { driving: boolean; speed: number; pos: [number, number, number]; hops: number; wheels: number; autoHop: boolean };
    __coastGame?: unknown;
    __coastXr?: boolean;
    __coastXrSupported?: boolean;
    __coastDiorama?: boolean;
    __coastPaint?: { count: number; strokes: number };
    __coastNpcs?: { count: number; nav: boolean; greets: number; photographer: [number, number, number] | null };
    __coastStudio?: { actorId: string; setSize: number; ghosts: number; state: string; possessed: number };
    __coastDirector?: {
      text: string;
      ok: boolean[];
      summary: string;
      follow: string | null;
      shot: { distance: number; height: number; fovDeg: number };
      /** The keyframed camera path (CAM-7): keys, length, whether the rig rides it right now and where. */
      path: { keys: number; durationS: number; locked: boolean; t: number | null };
    };
    __coastSay?: (text: string) => UtteranceOutcome;
    __coastVoice?: { supported: boolean; state: string };
    __coastExport?: (opts?: {
      fps?: number;
      width?: number;
      height?: number;
      bars?: [number, number];
    }) => Promise<{ bytes: number; mime: string; codec: string; ext: string; frames: number; seconds: number; manifest: unknown }>;
    /** QA: the control passes of a span of the set (STU-2): depth + pose videos and camera.json. */
    __coastExportControl?: (opts?: {
      startS?: number;
      endS?: number;
      passes?: ('depth' | 'pose')[];
      fps?: number;
      preview?: boolean;
    }) => Promise<{
      passes: Record<string, { bytes: number; mime: string; frames: number; seconds: number }>;
      camera: { frames: number; width: number; height: number; near: number; far: number; first: unknown };
      preview?: Record<string, string>;
    }>;
    /** QA: put the player's feet somewhere (the streaming harness walks the level this way). */
    __coastTeleport?: (x: number, y: number, z: number) => boolean;
    /** QA: the canvas as a PNG data URL right after the next rendered frame (the screenshot harness). */
    __coastShot?: () => Promise<string>;
    /** QA: draw calls in the last rendered frame (the splats count as one — 0 of them means Spark drew nothing yet). */
    __coastDraws?: number;
    /** QA: the post stack — whether the frame goes through it, the look on it, the bloom, the passes. */
    __coastPost?: () => {
      enabled: boolean;
      look: string;
      live: boolean;
      bloom?: number;
      contrast?: number;
      lift?: number;
      passes?: string[];
    };
    /** QA: put a look on the picture (what "make it noir" does through the director). */
    __coastLook?: (name: string) => boolean;
    /** QA: run the live frame through the post stack or straight to the canvas (A/B the picture and the frame time). */
    __coastPostLive?: (on: boolean) => void;
    __coastCells?: {
      active: string;
      resident: string[];
      loaded: string[];
      nearest: { to: string; distance: number } | null;
      corridors: number;
      /** Road ends walled off because the cell there has no ground (yet, or any more). */
      gates: number;
      /** What each resident cell has put into the world (props / NPCs / the car), and every prop id there is. */
      content: Record<string, { props: number; npcs: number; vehicle: boolean }>;
      props: string[];
    };
    __coastGround?: {
      minX: number;
      minZ: number;
      cols: number;
      cellSize: number;
      coverage?: { minX: number; minZ: number; maxX: number; maxZ: number };
      sampled: number;
    };
  }
}

export class Game {
  readonly scene = new THREE.Scene();
  /** Everything that belongs to the block: splats, actors, props, the car, the billboard. Scaled as one in the diorama (CAM-3). */
  readonly world = new THREE.Group();
  /** XR: the camera's parent; the rig moves this, never the camera (CAM-4). */
  readonly localFrame = new THREE.Group();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly spark: SparkRenderer;
  readonly rig: CameraRig;
  readonly budgets;
  private readonly isShot: boolean;
  private readonly freezeT: number;
  private readonly forcePhysics: boolean;
  private readonly lod: boolean;
  private readonly perf;
  private providers: InputProvider[] = [];
  private kbm: KeyboardMouseProvider;
  private touch: TouchProvider;
  private xrInput: XrControllerProvider;
  private xr: SparkXr | null = null;
  private xrButton: HTMLButtonElement | null = null;
  private inXr = false;
  /** Yaw of the XR frame relative to the subject (snap turns accumulate here). */
  private xrYaw = 0;
  private diorama = false;
  private readonly dioramaScale = 1 / 12;
  private teleportMarker: THREE.Mesh | null = null;
  private painter: SplatPainter | null = null;
  private spraying = false;
  private readonly sprayColor = new THREE.Color();
  private static readonly SPRAY_RANGE = 3.5;
  private readonly headLocal = new THREE.Vector3();
  private readonly headWorld = new THREE.Vector3();
  private readonly headQuat = new THREE.Quaternion();
  private input: FrameInput = newFrameInput();

  /** Resident cells of the level (W-3): the active one plus, at most, its nearest neighbour; loading and loaded alike. */
  private readonly cells = new Map<string, ResidentCell>();
  private levelDef: LevelDef = soloLevel('valley', SCENES.valley!);
  private graph: LevelGraph | null = null;
  private streamer: CellStreamer | null = null;
  /** Transitions in the world, keyed by their undirected edge. */
  private readonly corridors = new Map<string, Corridor>();
  private sceneDef: SceneDef = LOCAL_BUTTERFLY;
  private currentSceneId = 'valley';
  private cellId: string | null = null;
  private loading = '';
  private usingFallback = false;
  private timePreset: TimeOfDay = 'noon';
  /** The player (T) or the director (`set_time`) picked the time: cells stop applying their own lighting preset. */
  private timeByUser = false;
  /** A cell's ground came or went: the NPC navmesh is rebuilt on the next frame (spans every resident cell + the roads). */
  private navDirty = false;
  /** The look on the picture (MIS-6): the mission's at the brief, the director's after "make it noir". */
  private lookName = 'clean';
  /** The post stack (W-5 post LUT): live on tiers budgeted 'full'; every tier borrows one for the cut export. */
  private post: PostStack | null = null;
  private postLoading: Promise<PostStack> | null = null;
  private postLive = false;
  private postForExport = false;
  /** Time of day + weather as a grade on the splats, the sky, the lights and the fog (W-5). */
  private readonly atmosphere: Atmosphere;

  private physics: PhysicsWorld | null = null;
  private character: CharacterController | null = null;
  private props: PropSystem | null = null;
  private vehicle: Lowrider | null = null;
  private vehicleSpawn: { pos: THREE.Vector3; yaw: number } | null = null;
  private driving = false;
  private readonly vehicleInput: VehicleInput = zeroVehicleInput();
  private lastCarYaw = 0;
  private readonly beat = new BeatClock();
  private readonly metronome = new Metronome(this.beat);
  private sfx!: Sfx;
  /** Browser speech synthesis for NPC lines and the director's replies (AUD-1 placeholder). */
  private tts!: Tts;
  private readonly stride = new StrideTracker();
  private autoHop = false;
  private pendingBeat: { event: NonNullable<MeterSample['beatEvent']>; phaseMs: number } | null = null;
  private verdictAt = 0;
  private playerMesh: THREE.Group;
  private debug = false;
  private physicsReady = false;
  private physicsGen = 0;

  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly tmpMove = new THREE.Vector2();
  private readonly frameTimes: number[] = [];
  private last = performance.now();
  private frame = 0;
  private crosshair: HTMLElement;
  private loadingScreen: LoadingScreen | null = null;
  private lodReported = false;
  private readyFrames = 0;
  private hint = '';
  private studio: StudioSession | null = null;
  private npcs: NpcSystem | null = null;
  private subtitles: Subtitles | null = null;
  private reelStrip: ReelStrip | null = null;
  /** Who the player is right now (ACT-3): $COAST, or an NPC identity taken over with V. */
  private identity: NpcSpec = PLAYER_IDENTITY;
  private possessions = 0;
  /** Looks by actor id (for take ghosts): the player + every NPC identity spawned in this level. */
  private readonly looks = new Map<string, { color: number; name: string }>();
  /** The director's console (`/`): typed directions → acts; the voice path drives the same executor (DIR-1). */
  private director: DirectorConsole | null = null;
  private readonly deixis = new DeixisBuffer();
  /** What the follow camera is on when it is not the player: 'lowrider', a prop id or an NPC id (CAM-6 "follow the car"). */
  private followId: string | null = null;
  /** The director's keyframed camera path (CAM-7): keys dropped where the camera was, played as a locked shot. */
  private readonly cameraPath = new CameraPath();
  private pathStartedAt = 0;
  private typing = false;
  /** Push-to-talk speech recognition feeding the console (browser Web Speech; the Realtime client replaces it in M5). */
  private voice: VoiceInput | null = null;
  private pttWasHeld = false;
  /** A cut is rendering: the live loop is paused (see `exportScene`). */
  private exporting = false;
  /** Pending `__coastShot` callers: served with the canvas right after the next frame's render. */
  private readonly shotRequests: ((png: string) => void)[] = [];
  /** The scene surface the director acts on (shared by the typed console and the Realtime client). */
  private ops: SceneOps | null = null;
  /** The OpenAI Realtime voice director (DIR-1), when `?voice=realtime` and the Worker can mint a secret. */
  private realtime: { client: RealtimeClient; session: RealtimeSession } | null = null;
  private billboard: THREE.Mesh | null = null;
  private billboardVideo: HTMLVideoElement | null = null;
  private readonly frustum = new THREE.Frustum();
  private readonly frustumMatrix = new THREE.Matrix4();
  private readonly subjectSphere = new THREE.Sphere();

  constructor(private readonly opts: GameOptions) {
    const { platform, params, hud } = opts;
    this.budgets = budgetsFor(platform.tier);
    this.isShot = params.has('shot');
    this.freezeT = Number(params.get('t') ?? '0');
    this.forcePhysics = params.get('physics') === '1';
    this.lod = params.get('lod') !== '0'; // `?lod=0`: skip the LoD build (QA on slow machines; the ground estimator copes)

    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 2000);
    this.sfx = new Sfx(this.camera, { muted: params.get('mute') === '1' || this.isShot });
    this.tts = new Tts({ muted: params.get('mute') === '1' || this.isShot || params.get('tts') === '0' });
    // Audio starts on the first gesture (autoplay policy) — any key, click or touch.
    const unlock = () => this.sfx.unlock();
    for (const ev of ['keydown', 'pointerdown', 'touchstart'] as const) window.addEventListener(ev, unlock, { passive: true });
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.budgets.maxPixelRatio));
    this.renderer.setSize(innerWidth, innerHeight);
    document.body.appendChild(this.renderer.domElement);

    this.spark = new SparkRenderer({
      renderer: this.renderer,
      enableLod: true,
      lodSplatCount: this.budgets.lodSplatCount,
      maxStdDev: this.budgets.maxStdDev,
      lodRenderScale: this.budgets.lodRenderScale,
    });
    this.scene.add(this.spark, this.world, this.localFrame);
    performance.mark('coast:boot');
    window.__coastGame = this; // harness / console handle (read-only by convention)
    window.__coastShot = () => new Promise((resolve) => this.shotRequests.push(resolve));
    window.__coastTeleport = (x, y, z) => {
      if (!this.character) return false;
      this.exitVehicle();
      this.character.teleport(new THREE.Vector3(x, y, z));
      this.placeXrFrameNow();
      return true;
    };

    // Time of day is a grade (W-5): the sky dome, the sun + hemisphere for the meshes, exp² fog, and a dyno colour
    // modifier on every splat (splats carry baked light). The env map from the cell pano lands with M2.
    // `?grade=0` (or a tier with no post budget) keeps the flat look: no sky dome, no per-splat modifier.
    this.atmosphere = new Atmosphere(this.scene, {
      enabled: params.get('grade') === '1' || (params.get('grade') !== '0' && this.budgets.postProcessing !== 'none'),
    });
    const timeParam = params.get('time');
    if (timeParam && (TIME_ORDER as string[]).includes(timeParam)) {
      this.timePreset = timeParam as TimeOfDay;
      this.timeByUser = true;
      this.atmosphere.setTime(this.timePreset, true);
    }
    // The post stack (W-5 post LUT, MIS-6 looks, AF-7 `postprocessing`): bloom for the neon, the look's 3D LUT,
    // vignette, grain, aberration. Live where the budget says 'full' (`?post=1` / `?post=0` override); every tier
    // renders the cut export through one; XR renders straight to the layer. `?look=` starts under a look.
    this.postLive =
      params.get('post') === '1' || (params.get('post') !== '0' && this.atmosphere.enabled && this.budgets.postProcessing === 'full');
    const lookParam = params.get('look');
    if (lookParam) this.setLook(lookParam);
    if (this.postLive) void this.ensurePost();
    window.__coastPost = () => ({
      ...(this.post ? this.post.state() : {}),
      enabled: !!this.post && (this.postLive || this.exporting),
      live: this.postLive,
      look: this.lookName,
    });
    window.__coastLook = (name) => this.setLook(name);
    window.__coastPostLive = (on) => {
      this.postLive = on;
      if (on) void this.ensurePost();
    };

    // Placeholder player (visible in director/producer): capsule + nose to show facing. Replaced by the $COAST rig in M4.
    this.playerMesh = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, 1.1, 6, 16),
      new THREE.MeshStandardMaterial({ color: 0xffb54a, roughness: 0.6 }),
    );
    body.position.y = 0.9;
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.3), new THREE.MeshStandardMaterial({ color: 0x0b0a10 }));
    nose.position.set(0, 1.45, -0.4);
    this.playerMesh.add(body, nose);
    this.playerMesh.visible = false;
    this.world.add(this.playerMesh);

    const camParam = params.get('cam') ?? 'director';
    this.rig = new CameraRig(
      (['actor', 'director', 'producer'] as RigMode[]).includes(camParam as RigMode) ? (camParam as RigMode) : 'director',
    );
    this.camera.fov = this.rig.params.fovDeg;
    this.camera.updateProjectionMatrix();

    this.kbm = new KeyboardMouseProvider(this.renderer.domElement);
    this.touch = new TouchProvider(this.renderer.domElement);
    this.xrInput = new XrControllerProvider(this.renderer, this.localFrame);
    this.providers = [this.kbm, this.touch, new GamepadProvider(), this.xrInput];
    if (platform.webxr && !this.isShot) this.setupXr();
    this.kbm.setPointerLockDesired(this.rig.mode === 'actor');

    this.crosshair = document.createElement('div');
    this.crosshair.style.cssText =
      'position:fixed;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:#ffb54a;box-shadow:0 0 0 1px #0008;pointer-events:none;display:none';
    document.body.appendChild(this.crosshair);

    if (!this.isShot) {
      this.ops = this.sceneOps();
      this.director = new DirectorConsole(document.body, this.ops, this.deixis, {
        mode: () => this.rig.mode,
        forward: () => {
          const f = this.camera.getWorldDirection(this.tmpV);
          return [f.x, f.z];
        },
        onOutcome: (text, outcome) => {
          this.subtitles ??= createSubtitles(document.body);
          this.subtitles.say('Director', summarize(outcome), 4500);
          this.tts.say('director', spokenReply(outcome));
          this.syncDirectorHook(text, outcome);
          this.updateHint();
        },
        onFocus: (typing) => {
          this.typing = typing;
          this.kbm.releaseAll();
        },
      });
      window.__coastSay = (text) => this.director!.say(text);
      this.voice = new VoiceInput({
        onTranscript: (text, speech) => this.director?.say(text, performance.now(), speech),
        onInterim: (text) => this.director?.listening(text),
        onState: (state, detail) => {
          if (state === 'listening') this.director?.listening('');
          else this.director?.listening(null);
          if (state === 'denied') this.hint = 'microphone blocked — allow it in the address bar, or press / to type';
          else if (state === 'error') this.hint = `speech recognition: ${detail ?? 'error'} — press / to type`;
          this.syncVoiceHook();
        },
      });
      this.syncVoiceHook();
      if (params.get('voice') === 'realtime') void this.startRealtime(params.get('premium') === '1');
    }

    if (this.isShot)
      document.getElementById('coast-load')?.remove(); // deterministic screenshots: no title card
    else {
      const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      this.loadingScreen = createLoadingScreen(
        document.body,
        touch
          ? 'left thumb: move · right thumb: look · ACTION rolls a take · walk up to the photographer'
          : 'WASD move · drag to look · Tab camera · E grab / get in the lowrider · Enter action · talk to the photographer',
      );
      // Reveal on the beat when the grid is running (UX-3 "reveal wipe synced to music").
      this.loadingScreen.reveal = () => {
        if (!this.beat.isRunning) return 0;
        const now = performance.now();
        return this.beat.timeOf(this.beat.phase(now).beatIndex + 1) - now;
      };
    }

    this.perf = initPerf({
      tier: platform.tier,
      cell: 'valley',
      sessionId: opts.sessionId,
      apiBase: '',
      splatCount: () => this.spark.display?.numSplats ?? 0,
    });

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });

    void hud;
  }

  /** The active cell (where the spawn, the HUD title and the perf reports point). */
  private get active(): ResidentCell | null {
    return this.cells.get(this.currentSceneId) ?? null;
  }
  private get splat(): SplatMesh | null {
    return this.active?.mesh ?? null;
  }
  private get ground(): GroundGrid | null {
    return this.active?.ground ?? null;
  }
  private get groundMesh(): THREE.Mesh | null {
    return this.active?.groundMesh ?? null;
  }
  /** Collider GLBs of every resident cell (Marble cells; empty on the sample worlds). */
  private get colliderMeshes(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const c of this.cells.values()) out.push(...c.colliderMeshes);
    return out;
  }

  /**
   * Ground height at a world XZ across everything resident (W-3): the highest of the cell grounds that cover the
   * point (inside their fence rectangles — beyond those the grid is hole-filled guesswork) and the roads between
   * cells; the active cell's grid, clamped, when nothing covers it.
   */
  private heightAt(x: number, z: number): number {
    let best = -Infinity;
    for (const c of this.cells.values()) {
      if (!c.ground) continue;
      const r = fenceRect(c.ground);
      if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue;
      best = Math.max(best, groundHeightAt(c.ground, x, z));
    }
    for (const road of this.corridors.values()) {
      const h = road.frame.heightAt(x, z);
      if (h !== null) best = Math.max(best, h);
    }
    if (Number.isFinite(best)) return best;
    const a = this.ground;
    return a ? groundHeightAt(a, x, z) : 0;
  }

  /** Time of day is a grade on the whole set (W-5): the splats, the sky, the lights and the fog dissolve together. */
  private recolorWorld(preset: TimeOfDay = this.timePreset) {
    this.atmosphere.setTime(preset, this.isShot);
  }

  /** Boot: pick the level / scene / cell from params and start the loop. */
  async start() {
    const p = this.opts.params;
    const cell = p.get('cell');
    if (cell) await this.loadCell(cell);
    else {
      const level = p.get('level');
      const sceneId = p.get('scene') ?? (this.isShot ? 'butterfly' : level && LEVELS[level] ? LEVELS[level].level.hub : 'valley');
      await this.loadScene(sceneId, level ?? undefined);
    }
    this.renderer.setAnimationLoop((time) => this.tick(time));
  }

  // ── Loading ───────────────────────────────────────────────────────────────────────────────────────────────

  private async reachable(url: string): Promise<boolean> {
    if (url.startsWith('/')) return true;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
      clearTimeout(t);
      return r.ok;
    } catch {
      return false;
    }
  }

  private clearWorld() {
    for (const id of [...this.cells.keys()]) this.unloadCell(id);
    for (const road of this.corridors.values()) road.dispose();
    this.corridors.clear();
    this.graph = null;
    this.streamer = null;
    this.painter?.dispose();
    this.painter = null;
    this.spraying = false;
    this.physicsGen++;
    this.physicsReady = false;
    this.character = null;
    if (this.vehicle) {
      this.sfx.engineStop();
      this.vehicle.dispose();
      this.vehicle = null;
    }
    this.sfx.spraySet(false);
    this.stride.reset();
    this.vehicleSpawn = null;
    this.setDriving(false);
    this.autoHop = false;
    this.metronome.disable();
    this.beat.stop();
    if (this.props) {
      for (const id of [...this.props.props.keys()]) this.props.remove(id);
      this.world.remove(this.props.group, this.props.ghost);
      this.props = null;
    }
    this.physics?.dispose();
    this.physics = null;
    this.playerMesh.visible = false;
    this.npcs?.dispose();
    this.npcs = null;
    if (this.billboard) this.world.remove(this.billboard);
    this.billboard = null;
    if (this.studio) {
      this.studio.dispose();
      this.studio = null;
    }
    this.reelStrip?.hide();
    if (this.identity !== PLAYER_IDENTITY) this.setIdentity(PLAYER_IDENTITY);
    this.looks.clear();
    this.followId = null;
    this.director?.close();
    this.deixis.clear();
    window.__coastPhysics = false;
    window.__coastSteps = 0;
    this.syncCellsHook();
  }

  private beginLoad(title: string, withPhysics: boolean) {
    this.loading = title;
    this.lodReported = false;
    this.readyFrames = 0;
    window.__coastReady = false;
    window.__coastLod = false;
    this.loadingScreen?.begin(title, { stages: withPhysics ? ['fetch', 'lod', 'physics'] : ['fetch', 'lod'] });
  }

  /** Splat download progress → the loading card (total unknown for chunked responses → indeterminate half). */
  private onFetchProgress = (e: ProgressEvent) => {
    this.loadingScreen?.progress('fetch', e.lengthComputable && e.total > 0 ? Math.min(0.98, e.loaded / e.total) : 0.5);
  };

  /**
   * Load the level a scene belongs to with that scene as the active cell (W-3): `?level=` names one explicitly,
   * otherwise the sample strip when the scene is one of its cells, else a one-cell level. Off the network, the local
   * butterfly stands in.
   */
  async loadScene(id: string, levelId?: string) {
    let levelDef = levelId && LEVELS[levelId] ? LEVELS[levelId] : levelForScene(id);
    if (!levelDef.level.cells.includes(id)) id = levelDef.level.hub;
    this.usingFallback = false;
    if (!(await this.reachable(levelDef.cells[id]!.url))) {
      levelDef = soloLevel('butterfly', LOCAL_BUTTERFLY);
      id = 'butterfly';
      this.usingFallback = true;
    }
    this.clearWorld();
    this.levelDef = levelDef;
    this.graph = new LevelGraph(
      levelDef.level,
      Object.fromEntries(Object.entries(levelDef.cells).map(([cid, d]) => [cid, { id: cid, transitions: d.transitions ?? [] }])),
    );
    this.streamer = new CellStreamer(this.graph, id, { residentCells: this.budgets.residentCells });
    this.cellId = null;
    this.currentSceneId = id;
    const def = worldDef(levelDef, id);
    this.sceneDef = def;
    this.beginLoad(def.title, !this.isShot && (def.world || this.forcePhysics));
    this.addCellSplat(id, def, true);
    this.placeCamera(def);
    this.perf.setCell(id);
    this.syncCellsHook();
  }

  /** Marble cell (goal.md W-2): /cells/<id>/cell.json with spz + collider GLB + pano — a one-cell level for now. */
  async loadCell(id: string) {
    let cell: Cell;
    try {
      const r = await fetch(`/cells/${id}/cell.json`);
      if (!r.ok) throw new Error(`${r.status}`);
      cell = (await r.json()) as Cell;
    } catch (e) {
      console.warn(`cell ${id} not found (${String(e)}) — falling back to the valley sample`);
      return this.loadScene('valley');
    }
    this.clearWorld();
    this.cellId = id;
    this.currentSceneId = id;
    const spawn = cell.spawns[0]?.pos ?? [0, 0, 0];
    const def: SceneDef = {
      title: cell.title,
      url: cell.assets.spz500k,
      position: [0, cell.transform.groundOffset, 0],
      // TODO(M2): verify metric_scale_factor semantics on the first real cell (units × factor = metres?).
      scale: cell.transform.metricScale || 1,
      camera: { pos: [spawn[0], spawn[1] + 2, spawn[2] + 2], lookAt: [spawn[0], spawn[1] + 1.5, spawn[2] - 6] },
      world: true,
      spawn,
      transitions: [],
    };
    this.levelDef = soloLevel(id, def);
    this.graph = new LevelGraph(this.levelDef.level, { [id]: { id, transitions: [] } });
    this.streamer = new CellStreamer(this.graph, id, { residentCells: this.budgets.residentCells });
    this.sceneDef = def;
    this.beginLoad(def.title, !this.isShot);
    const resident = this.addCellSplat(id, def, true, cell);
    const e = cell.transform.rotationEuler;
    resident.mesh.rotation.set(THREE.MathUtils.degToRad(e[0]), THREE.MathUtils.degToRad(e[1]), THREE.MathUtils.degToRad(e[2]));
    this.placeCamera(def);
    this.perf.setCell(id);
    this.syncCellsHook();
  }

  /**
   * Put a cell's splat in the world at its placement (W-3). The first cell of a level drives the loading screen and
   * boots physics when it lands; a streamed neighbour arrives quietly and joins the physics world on load.
   */
  private addCellSplat(id: string, def: SceneDef, first: boolean, cell?: Cell): ResidentCell {
    const mesh = new SplatMesh({
      url: def.url,
      ...(def.fileType ? { fileType: def.fileType } : {}), // never pass fileType: undefined (breaks auto-detect)
      lod: this.lod && def.lod !== false,
      ...(first ? { onProgress: this.onFetchProgress } : {}),
      onLoad: () => (first ? this.onWorldLoaded(resident) : this.onCellLoaded(resident)),
    });
    mesh.quaternion.set(1, 0, 0, 0); // Spark sample assets are stored Y-down: rotate 180° about X — rotate, never mirror (W-2)
    mesh.position.set(...def.position);
    mesh.scale.setScalar(def.scale);
    this.atmosphere.grade(mesh);
    this.world.add(mesh);
    const resident: ResidentCell = {
      id,
      def,
      mesh,
      loaded: false,
      ground: null,
      colliders: [],
      groundMesh: null,
      colliderMeshes: [],
      content: noContent(),
      ...(cell ? { cell } : {}),
    };
    this.cells.set(id, resident);
    return resident;
  }

  /** Take a cell out of the world: splat, ground, fence, and the roads that no resident cell needs any more. */
  private unloadCell(id: string) {
    const c = this.cells.get(id);
    if (!c) return;
    this.cells.delete(id);
    this.despawnCellContent(c);
    this.world.remove(c.mesh);
    c.mesh.dispose();
    if (this.physics && c.colliders.length) this.physics.removeColliders(c.colliders);
    if (c.groundMesh) {
      this.world.remove(c.groundMesh);
      c.groundMesh.geometry.dispose();
    }
    for (const m of c.colliderMeshes) this.world.remove(m);
    for (const [key, road] of this.corridors) {
      const [a, b] = key.split('|') as [string, string];
      if (!this.cells.has(a) && !this.cells.has(b)) {
        road.dispose();
        this.corridors.delete(key);
      }
    }
    this.syncGates();
  }

  private placeCamera(def: SceneDef) {
    this.camera.position.set(...def.camera.pos);
    this.camera.lookAt(...def.camera.lookAt);
    // Seed the rig yaw from the look direction so the first frames don't snap.
    const d = new THREE.Vector3(...def.camera.lookAt).sub(new THREE.Vector3(...def.camera.pos));
    this.rig.yaw = Math.atan2(-d.x, -d.z);
    this.rig.pitch = 0;
  }

  private onWorldLoaded(resident: ResidentCell) {
    resident.loaded = true;
    this.loading = '';
    if (!performance.getEntriesByName('coast:interactive').length) performance.mark('coast:interactive'); // QB-3
    window.__coastReady = true;
    this.loadingScreen?.progress('fetch', 1);
    this.painter = new SplatPainter(this.world, { maxSdfs: this.budgets.maxPaintSdfs });
    window.__coastPaint = { count: 0, strokes: 0 };
    const def = resident.def;
    if (!this.isShot && (def.world || this.forcePhysics)) void this.initPhysics(resident);
  }

  /** A streamed neighbour's splat landed: give it ground + fence, open the road's gate, tell the streamer. */
  private onCellLoaded(resident: ResidentCell) {
    if (!this.cells.has(resident.id)) return; // unloaded while downloading
    resident.loaded = true;
    this.tryBuildGround(resident);
    this.syncCellsHook();
  }

  /**
   * Ground for a loaded cell once its splats are readable (with LoD, `onLoad` can precede the LoD tree — the frame
   * loop retries until the data is there). Returns whether the cell has ground now.
   */
  private tryBuildGround(c: ResidentCell): boolean {
    if (c.ground) return true;
    const physics = this.physics;
    if (!physics || !this.physicsReady || !c.loaded || !splatsReady(c.mesh)) return false;
    this.ensureCorridors();
    this.buildCellGround(c, physics);
    this.streamer?.markLoaded(c.id);
    this.syncGates();
    this.spawnCellContent(c);
    this.subtitles?.say('Set', `${c.def.title} is in`, 2500);
    return true;
  }

  // ── Content follows the cell (W-3, ADR-0011) ─────────────────────────────────────────────────────────────────

  /** The content a cell hosts: its own, or the hub kit for the level's hub without any (spawn-relative). */
  private contentFor(c: ResidentCell): CellContent | null {
    if (c.def.content) return c.def.content;
    if (c.id === this.levelDef.level.hub)
      return hubKit(c.def.spawn ? [c.def.spawn[0] - (c.def.origin?.[0] ?? 0), 0, c.def.spawn[2] - (c.def.origin?.[2] ?? 0)] : [0, 0, 0]);
    return null;
  }

  /**
   * Put a cell's props, NPCs and car into the world once its ground is in the physics world. Positions are in the
   * cell's frame with `y` metres above the derived ground. Anything already there (carried over from a previous
   * visit, or held) is left alone.
   */
  private spawnCellContent(c: ResidentCell) {
    const physics = this.physics;
    const props = this.props;
    const npcs = this.npcs;
    if (c.content.spawned || !physics || !props || !npcs || !(c.ground || c.colliders.length)) return;
    c.content.spawned = true;
    const content = this.contentFor(c);
    if (!content) return;
    const o = c.def.origin ?? [0, 0, 0];
    for (const p of content.props ?? []) {
      if (props.props.has(p.id)) continue;
      const pos = new THREE.Vector3(o[0] + p.pos[0], 0, o[2] + p.pos[2]);
      pos.y = this.heightAt(pos.x, pos.z) + p.pos[1];
      props.spawn({ id: p.id, shape: p.shape, size: p.size, color: p.color, mass: p.mass, ...(p.tags ? { tags: p.tags } : {}) }, pos);
      c.content.props.push(p.id);
    }
    for (const n of content.npcs ?? []) {
      if (npcs.byId(n.id) || n.id === this.identity.id) continue; // the player wears this identity right now (ACT-3)
      const home = new THREE.Vector3(o[0] + n.pos[0], o[1] + n.pos[1], o[2] + n.pos[2]);
      npcs.spawn({
        id: n.id,
        name: n.name,
        color: n.color,
        home,
        lines: n.lines,
        ...(n.approaches !== undefined ? { approaches: n.approaches } : {}),
        ...(n.speed !== undefined ? { speed: n.speed } : {}),
      });
      this.looks.set(n.id, { color: n.color, name: n.name });
      c.content.npcs.push(n.id);
    }
    if (content.vehicle && !this.vehicle) {
      // Parked on the flattest patch around the authored spot so it never spawns half inside a hillside (which
      // launches it); it drops onto its suspension.
      const v = content.vehicle;
      const carPos = new THREE.Vector3(o[0] + v.pos[0], 0, o[2] + v.pos[2]);
      if (c.ground) {
        // Never on top of a person (a kinematic capsule is a wall to the car), the player or a prop.
        const keepOut = [
          ...npcs.npcs.map((n) => ({ x: n.mesh.position.x, z: n.mesh.position.z, r: 1.2 })),
          ...[...props.props.values()].map((p) => ({ x: p.mesh.position.x, z: p.mesh.position.z, r: 0.8 })),
        ];
        const feet = this.character?.feet(this.tmpV);
        if (feet) keepOut.push({ x: feet.x, z: feet.z, r: 1.5 });
        const here = flattestSpot(c.ground, carPos, 0, 0, 1.2, 2.4, 1, keepOut); // the authored spot, if flat and clear
        carPos.copy(here.range < 0.6 ? here.position : flattestSpot(c.ground, carPos, 1.5, 5, 1.2, 2.4, 16, keepOut).position);
      } else carPos.y = this.heightAt(carPos.x, carPos.z);
      carPos.y += 1.2;
      const yaw = c.def.content ? v.yaw : this.rig.yaw; // the kit's car faces the way the player does
      this.vehicle = new Lowrider(physics, { position: carPos, yaw });
      this.vehicleSpawn = { pos: carPos.clone(), yaw };
      this.world.add(this.vehicle.group);
      this.sfx.engineStart(this.vehicle.group); // idles by the door (no-op until audio unlocks; retried per frame)
      c.content.vehicle = true;
    }
    this.navDirty = true;
    this.syncNpcHook();
  }

  /** Take a cell's content out with it — except what the player is holding or driving, which follows the player. */
  private despawnCellContent(c: ResidentCell) {
    const props = this.props;
    for (const id of c.content.props) {
      const p = props?.props.get(id);
      if (!p || props!.grabbed === p) continue;
      props!.remove(id);
    }
    for (const id of c.content.npcs) this.npcs?.remove(id);
    if (c.content.vehicle && this.vehicle && !this.driving) {
      this.sfx.engineStop();
      this.world.remove(this.vehicle.group);
      this.vehicle.dispose();
      this.vehicle = null;
      this.vehicleSpawn = null;
    }
    c.content = noContent();
    this.navDirty = true;
    this.syncNpcHook();
  }

  /**
   * The NPC navmesh spans every resident cell's walkable surface (its collider GLB, else its derived ground) and the
   * roads between them; rebuilt (async) whenever ground comes or goes — the crowd keeps walking on the old one meanwhile.
   */
  private rebuildNav() {
    const npcs = this.npcs;
    if (!npcs) return;
    const walkable: THREE.Mesh[] = [];
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const c of this.cells.values()) {
      if (!c.ground) continue;
      for (const m of c.colliderMeshes) m.traverse((o) => ((o as THREE.Mesh).isMesh ? walkable.push(o as THREE.Mesh) : null));
      if (!c.colliderMeshes.length && c.groundMesh) walkable.push(c.groundMesh);
      const cov = c.ground.coverage;
      if (cov) {
        minX = Math.min(minX, cov.minX);
        minZ = Math.min(minZ, cov.minZ);
        maxX = Math.max(maxX, cov.maxX);
        maxZ = Math.max(maxZ, cov.maxZ);
      }
    }
    for (const road of this.corridors.values()) walkable.push(road.road);
    if (!walkable.length) return;
    const bounds: [[number, number, number], [number, number, number]] | undefined = Number.isFinite(minX)
      ? [
          [minX - 1, -50, minZ - 1],
          [maxX + 1, 80, maxZ + 1],
        ]
      : undefined;
    const gen = this.physicsGen;
    void npcs.buildNav(walkable, bounds).then(() => {
      if (gen === this.physicsGen) this.syncNpcHook();
    });
  }

  // ── Streaming (W-3) ───────────────────────────────────────────────────────────────────────────────────────────

  private edgeKey(a: string, b: string) {
    return [a, b].sort().join('|');
  }

  /** Every road out of a resident cell exists (colliders included), so a cell's ground can be cut for it. */
  private ensureCorridors() {
    const graph = this.graph;
    const physics = this.physics;
    if (!graph || !physics) return;
    for (const id of this.cells.keys()) {
      for (const exit of graph.exitsOf(id)) {
        const key = this.edgeKey(exit.from, exit.to);
        if (this.corridors.has(key)) continue;
        const back = graph.portal(exit.to, exit.from)!;
        const a = this.doorwayFloor(exit);
        const b = this.doorwayFloor(back);
        const fogColor = this.atmosphere.fogColorHex;
        this.corridors.set(key, new Corridor(corridorFrame(a, b, 6, 1), { a: exit.from, b: exit.to }, this.world, physics, { fogColor }));
        for (const c of this.cells.values()) if (c.ground) this.recutCell(c, physics);
      }
    }
    this.syncGates();
  }

  /**
   * Roads touching a cell were built on its authored doorway heights; now that its ground is derived, rebuild them
   * end-snapped (and re-cut the neighbour at the other end, whose cut only ever deepens).
   */
  private rebuildCorridorsFor(id: string, physics: PhysicsWorld) {
    const graph = this.graph;
    if (!graph) return;
    for (const [key, road] of [...this.corridors]) {
      if (road.ends.a !== id && road.ends.b !== id) continue;
      const exit = graph.portal(road.ends.a, road.ends.b);
      const back = graph.portal(road.ends.b, road.ends.a);
      if (!exit || !back) continue;
      road.dispose();
      const fogColor = this.atmosphere.fogColorHex;
      this.corridors.set(
        key,
        new Corridor(corridorFrame(this.doorwayFloor(exit), this.doorwayFloor(back), 6, 1), road.ends, this.world, physics, { fogColor }),
      );
      const other = this.cells.get(road.ends.a === id ? road.ends.b : road.ends.a);
      if (other?.ground) this.recutCell(other, physics);
    }
  }

  /** A doorway's floor, snapped to the cell's derived ground when that ground exists (authored heights are approximate). */
  private doorwayFloor(portal: Portal): [number, number, number] {
    const c = this.cells.get(portal.from);
    const [x, y, z] = portal.floor;
    if (c?.ground) return [x, groundHeightAt(c.ground, x, z), z];
    return [x, y, z];
  }

  /** Gates stand at any road end whose cell has no ground yet (or is gone). */
  private syncGates() {
    for (const road of this.corridors.values()) {
      road.setGate('a', !this.cells.get(road.ends.a)?.ground);
      road.setGate('b', !this.cells.get(road.ends.b)?.ground);
    }
  }

  /** Ground + fence for a sample cell from its splats (or the cell collider GLB), cut for every road that touches it. */
  private buildCellGround(c: ResidentCell, physics: PhysicsWorld) {
    if (c.ground || c.colliders.length) return;
    const def = c.def;
    const spawnXZ = new THREE.Vector3(...(def.spawn ?? def.position));
    c.ground = groundFromSplats(c.mesh, { center: spawnXZ, halfExtent: def.groundHalfExtent ?? 40, cellSize: 0.75 });
    this.rebuildCorridorsFor(c.id, physics);
    this.recutCell(c, physics);
    if (c.id === this.currentSceneId) {
      window.__coastGround = {
        minX: c.ground.minX,
        minZ: c.ground.minZ,
        cols: c.ground.cols,
        cellSize: c.ground.cellSize,
        coverage: c.ground.coverage,
        sampled: c.ground.sampled ?? 0,
      };
    }
  }

  /** (Re)build a cell's ground collider + fence after cutting its grid for the roads that touch it. */
  private recutCell(c: ResidentCell, physics: PhysicsWorld) {
    if (!c.ground) return;
    const openings = [];
    for (const [key, road] of this.corridors) {
      if (!key.split('|').includes(c.id)) continue;
      cutGroundForCorridor(c.ground, road.frame);
      openings.push(road.frame.footprint);
    }
    if (c.colliders.length) physics.removeColliders(c.colliders);
    c.colliders = [];
    if (c.groundMesh) {
      this.world.remove(c.groundMesh);
      c.groundMesh.geometry.dispose();
      c.groundMesh = null;
    }
    const rect = fenceRect(c.ground, 1.5);
    const { collider, geometry } = physics.addGroundGrid(c.ground, rect);
    c.colliders.push(collider, ...physics.addFence(c.ground, 4, 1.5, openings)); // the block ends where the scan ends
    c.groundMesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: 0x3fd0ff, wireframe: true, transparent: true, opacity: 0.35 }),
    );
    c.groundMesh.visible = this.debug;
    this.world.add(c.groundMesh);
    this.navDirty = true;
  }

  /** Per frame: feed the player's position to the streamer and act on what it decides. */
  private updateStreaming(feet: THREE.Vector3) {
    const s = this.streamer;
    if (!s || !this.physicsReady) return;
    for (const c of this.cells.values()) if (c.loaded && !c.ground) this.tryBuildGround(c);
    for (const ev of s.update(feet)) this.onStreamEvent(ev);
    if (this.frame % 15 === 0) this.syncCellsHook();
  }

  private onStreamEvent(ev: StreamEvent) {
    const graph = this.graph;
    if (!graph) return;
    if (ev.kind === 'load') {
      if (this.cells.has(ev.cell)) return;
      const def = worldDef(this.levelDef, ev.cell);
      this.addCellSplat(ev.cell, def, false);
      this.ensureCorridors();
      this.hint = `${def.title} is streaming in`;
      performance.mark('coast:stream-load');
    } else if (ev.kind === 'unload') {
      this.streamer?.drop(ev.cell);
      this.unloadCell(ev.cell);
    } else {
      this.setActiveCell(ev.cell);
      performance.mark('coast:stream-arrive');
    }
    this.syncCellsHook();
  }

  /** The player walked into another cell: it owns the spawn, the HUD title and the perf reports from here on. */
  private setActiveCell(id: string) {
    const c = this.cells.get(id);
    if (!c) return;
    this.currentSceneId = id;
    this.sceneDef = c.def;
    this.perf.setCell(id);
    this.applyCellLighting(c);
    this.subtitles?.say('Set', `${c.def.title}`, 3000);
    this.updateHint();
  }

  /** A cell arrives under its own grade (SCH-1 `lighting.preset`) — unless the player or the director picked a time. */
  private applyCellLighting(c: ResidentCell) {
    const preset = c.def.lighting ?? (c.cell?.lighting.preset as TimeOfDay | undefined);
    if (!preset || this.timeByUser || preset === this.timePreset) return;
    this.timePreset = preset;
    this.recolorWorld(preset);
  }

  private syncCellsHook() {
    const s = this.streamer;
    const feet = this.character?.feet(this.tmpV);
    const nearest = s && feet ? s.nearest(feet) : null;
    window.__coastCells = {
      active: this.currentSceneId,
      resident: [...this.cells.keys()],
      loaded: [...this.cells.values()].filter((c) => c.loaded && c.ground).map((c) => c.id),
      nearest: nearest ? { to: nearest.portal.to, distance: Math.round(nearest.distance * 10) / 10 } : null,
      corridors: this.corridors.size,
      gates: [...this.corridors.values()].reduce((n, r) => n + (r.gateClosed('a') ? 1 : 0) + (r.gateClosed('b') ? 1 : 0), 0),
      content: Object.fromEntries(
        [...this.cells.values()].map((c) => [
          c.id,
          { props: c.content.props.length, npcs: c.content.npcs.length, vehicle: c.content.vehicle },
        ]),
      ),
      props: [...(this.props?.props.keys() ?? [])],
    };
  }

  // ── Physics / character / props ────────────────────────────────────────────────────────────────────────────

  private async initPhysics(resident: ResidentCell) {
    const gen = ++this.physicsGen;
    const R = await loadRapier();
    // With Rapier already cached (a scene switch), we can get here before the LoD tree exists: wait for the splats.
    for (let i = 0; i < 600 && gen === this.physicsGen && !splatsReady(resident.mesh); i++) await new Promise((r) => setTimeout(r, 50));
    if (gen !== this.physicsGen || !this.cells.has(resident.id)) return; // scene changed while loading
    this.loadingScreen?.progress('physics', 0.35);
    const physics = new PhysicsWorld(R);
    this.physics = physics;
    const def = resident.def;
    const cell = resident.cell;

    let colliderLoaded = false;
    if (cell?.assets.collider) {
      try {
        const gltf = await new GLTFLoader().loadAsync(cell.assets.collider);
        if (gen !== this.physicsGen) return;
        gltf.scene.rotation.copy(resident.mesh.rotation);
        gltf.scene.position.copy(resident.mesh.position);
        gltf.scene.scale.copy(resident.mesh.scale);
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            const m = o as THREE.Mesh;
            resident.colliders.push(physics.addStaticTrimesh(m.geometry, m.matrixWorld));
            m.visible = false;
          }
        });
        this.world.add(gltf.scene);
        resident.colliderMeshes.push(gltf.scene);
        colliderLoaded = true;
      } catch (e) {
        console.warn('collider GLB failed, deriving ground from splats', e);
      }
    }

    const spawnXZ = new THREE.Vector3(...(def.spawn ?? [0, 0, 0]));
    // Roads out of this cell first (their footprints cut the ground), then the ground from the splats themselves
    // (PHY-1 fallback), centred on the spawn, fenced where the scan ends — with the roads' doorways left open (W-3).
    this.ensureCorridors();
    if (!colliderLoaded) this.buildCellGround(resident, physics);

    this.loadingScreen?.progress('physics', 0.7);
    const spawnY = this.ground ? this.heightAt(spawnXZ.x, spawnXZ.z) : spawnXZ.y;
    const feet = new THREE.Vector3(spawnXZ.x, spawnY + 0.3, spawnXZ.z);
    this.character = new CharacterController(physics, { start: feet, yaw: this.rig.yaw });

    // Props, NPCs and the car are the cell's content (W-3, ADR-0011): the hub kit for a hub without its own list.
    // Systems first (the studio needs the NPC crowd), then the content, then whatever `?grab=` / `?vehicle=` ask for.
    this.props = new PropSystem(physics, this.world);
    const f = this.rig.forwardXZ(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    this.setupStudio(feet, f, right);
    this.spawnCellContent(resident);
    this.applyCellLighting(resident);

    const grabParam = this.opts.params.get('grab');
    if (grabParam) {
      const target = this.props.props.get(grabParam);
      if (target) this.props.grab(target); // QA: start holding a prop (e.g. grab=can_3 for the spray test)
    }

    // The beat grid starts with the world (the track player lands with AUD-2); `?beat=1` = hop on the beat from the start.
    this.beat.start(performance.now());
    if (this.opts.params.get('beat') === '1') this.autoHop = true;
    if (this.opts.params.get('vehicle') === '1') this.enterVehicle();

    this.physicsReady = true;
    window.__coastPhysics = true;
    for (const c of this.cells.values()) if (c.ground) this.streamer?.markLoaded(c.id);
    for (const c of this.cells.values()) if (c !== resident) this.tryBuildGround(c); // neighbours that landed meanwhile
    this.syncGates();
    this.syncCellsHook();
    this.loadingScreen?.progress('physics', 1);
    this.updateHint();
    const say = this.opts.params.get('say');
    if (say && this.director) this.director.say(say); // QA: `?say=camera low, follow the car`
  }

  // ── WebXR (Quest 3 / Vision Pro): SparkXr session, frame-based rig, diorama producer ───────────────────────────

  private setupXr() {
    const host = document.getElementById('enter') ?? document.body;
    const button = document.createElement('button');
    button.id = 'xr-button';
    button.textContent = 'ENTER VR';
    button.style.cssText =
      'pointer-events:auto;padding:10px 16px;border-radius:8px;border:1px solid rgba(242,236,220,.35);background:rgba(11,10,16,.6);color:#f2ecdc;font:600 12px system-ui,sans-serif;letter-spacing:.08em;cursor:pointer';
    host.appendChild(button);
    this.xrButton = button;
    this.xr = new SparkXr({
      renderer: this.renderer,
      element: button,
      mode: 'vr',
      referenceSpaceType: 'local-floor',
      frameBufferScaleFactor: this.budgets.xrFramebufferScale,
      enableHands: false, // hands (pinch = grab, index ray = point) land with the fog/paint touch slice
      onReady: (supported) => {
        button.hidden = !supported;
        window.__coastXrSupported = supported;
      },
      onEnterXr: () => this.onEnterXr(),
      onExitXr: () => this.onExitXr(),
    });
  }

  private onEnterXr() {
    this.inXr = true;
    window.__coastXr = true;
    if (this.xrButton) this.xrButton.textContent = 'EXIT VR';
    // The rig now moves the frame; the headset owns the camera's local pose (three writes it every frame).
    this.localFrame.add(this.camera);
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.identity();
    this.xrYaw = this.rig.yaw; // keep facing the way the desktop view faced
    if (this.driving) this.xrYaw -= this.vehicle?.yaw ?? 0;
    if (this.rig.mode === 'director') this.rig.setMode('actor');
    if (this.rig.mode === 'producer') this.setDiorama(true);
    this.kbm.setPointerLockDesired(false);
    performance.mark('coast:xr-enter');
    this.updateHint();
  }

  private onExitXr() {
    this.inXr = false;
    window.__coastXr = false;
    if (this.xrButton) this.xrButton.textContent = 'ENTER VR';
    this.setDiorama(false);
    // Hand the view direction back to the desktop rig, then detach the camera from the frame.
    this.camera.getWorldQuaternion(this.headQuat);
    this.rig.yaw = yawOf(this.headQuat);
    this.rig.pitch = 0;
    this.camera.removeFromParent();
    this.camera.position.set(0, 0, 0);
    if (this.teleportMarker) this.teleportMarker.visible = false;
    this.kbm.setPointerLockDesired(this.rig.mode === 'actor');
    this.updateHint();
  }

  /** Head pose in frame space (local) and world space, from the last rendered XR frame. */
  private readHead() {
    this.headLocal.copy(this.camera.position);
    this.camera.getWorldPosition(this.headWorld);
    this.camera.getWorldQuaternion(this.headQuat);
  }

  /**
   * Producer in VR = diorama (CAM-3): the world group shrinks to 1:12 on a "table" in front of the standing user with
   * the player's feet as the anchor; physics pauses while it is on. Positions are already 1:1 in the physics world, so
   * leaving is just the identity transform (hand manipulation writes back later).
   */
  private setDiorama(on: boolean) {
    if (on === this.diorama) return;
    this.diorama = on;
    if (on && this.character) {
      this.readHead();
      const feet = this.driving && this.vehicle ? this.carFeet(new THREE.Vector3()).clone() : this.character.feet(new THREE.Vector3());
      const table = tablePoint(this.headWorld, yawOf(this.headQuat), 0.7, 0.55);
      const place = dioramaPlacement(feet, table, this.dioramaScale);
      this.world.position.copy(place.position);
      this.world.scale.setScalar(place.scale);
      this.playerMesh.visible = true;
      performance.mark('coast:diorama-enter');
    } else {
      this.world.position.set(0, 0, 0);
      this.world.scale.setScalar(1);
    }
    window.__coastDiorama = this.diorama;
  }

  private ensureTeleportMarker() {
    if (this.teleportMarker) return this.teleportMarker;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.36, 32),
      new THREE.MeshBasicMaterial({ color: 0xffb54a, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    this.world.add(ring);
    this.teleportMarker = ring;
    return ring;
  }

  /** XR snap turn: rotate the frame and shift the body so the head stays where it is (no world slide). */
  private snapTurn(delta: number) {
    const ch = this.character;
    if (!ch || this.driving) {
      this.xrYaw += delta;
      return;
    }
    this.readHead();
    const shift = snapTurnShift(this.xrYaw, delta, this.headLocal);
    this.xrYaw += delta;
    const feet = ch.feet(new THREE.Vector3());
    ch.teleport(feet.add(new THREE.Vector3(shift.x, 0, shift.y)));
    this.placeXrFrameNow();
  }

  /** Re-place the XR frame under the head right now (after a teleport/snap), so the next simulate sees no drift. */
  private placeXrFrameNow() {
    const car = this.driving ? this.vehicle : null;
    const feet = car ? this.carFeet(this.tmpV) : this.character ? this.character.feet(this.tmpV) : null;
    if (feet) this.updateXrFrame(feet, car ? car.yaw : 0);
  }

  // ── Lowrider (PHY-3) ─────────────────────────────────────────────────────────────────────────────────────────

  private setDriving(v: boolean) {
    if (v === this.driving) return;
    this.driving = v;
    this.touch.setDriving(v);
    this.xrInput.driving = v;
    // In XR the frame yaw is relative to the subject: re-base so the user keeps facing the same way.
    if (this.inXr && this.vehicle) this.xrYaw += v ? -this.vehicle.yaw : this.vehicle.yaw;
  }

  private enterVehicle() {
    const car = this.vehicle;
    const ch = this.character;
    if (!car || !ch || this.driving) return;
    this.props?.release(null);
    this.props?.select(null);
    ch.setActive(false);
    this.playerMesh.visible = false;
    this.lastCarYaw = car.yaw;
    this.setDriving(true);
    performance.mark('coast:vehicle-enter');
    this.updateHint();
  }

  private exitVehicle() {
    const car = this.vehicle;
    const ch = this.character;
    if (!car || !ch || !this.driving) return;
    const out = car.exitPoint(new THREE.Vector3());
    if (this.ground) out.y = this.heightAt(out.x, out.z) + 0.3;
    ch.setActive(true);
    ch.teleport(out);
    ch.yaw = car.yaw;
    this.setDriving(false);
    this.updateHint();
  }

  /** R / fell off the world: everyone back to the spawn pose (player out of the car, car on its marks). */
  private respawn() {
    this.exitVehicle();
    this.placeCamera(this.sceneDef);
    if (this.character) {
      const s = this.sceneDef.spawn ?? [0, 0, 0];
      const y = this.ground ? this.heightAt(s[0], s[2]) : s[1];
      this.character.teleport(new THREE.Vector3(s[0], y + 0.3, s[2]));
    }
    if (this.vehicle && this.vehicleSpawn) this.vehicle.teleport(this.vehicleSpawn.pos, this.vehicleSpawn.yaw);
  }

  /** Which corners a manual hop lifts: the held switch decides (front by default, Shift = all four). */
  private hopPattern(): HopPattern {
    const i = this.input;
    if (i.sprint) return 'all';
    if (i.hydro.y < -0.5) return 'back';
    if (i.hydro.x < -0.5) return 'left';
    if (i.hydro.x > 0.5) return 'right';
    return 'front';
  }

  /** Feet-level target for the camera rig while driving. */
  private carFeet(out: THREE.Vector3): THREE.Vector3 {
    return this.vehicle!.position(out).sub(this.tmpV2.set(0, CAR_FEET_DROP, 0));
  }

  /** The NPC crowd (the cells put their people on it), the billboard, and the studio session (goal.md §3.1 steps 2, 5). */
  private setupStudio(feet: THREE.Vector3, f: THREE.Vector3, right: THREE.Vector3) {
    const physics = this.physics!;
    this.subtitles ??= createSubtitles(document.body);
    const npcs = new NpcSystem(physics, this.world, (x, z) => this.heightAt(x, z), {
      onGreet: (npc, line) => {
        this.subtitles?.say(npc.spec.name, line);
        this.tts.say(npc.spec.id, line);
        this.sfx.tick(npc.spec.id === 'photographer' ? 900 : 600);
        if (npc.spec.id === 'photographer' && this.studio?.state === 'idle') {
          this.studio.brief();
          this.updateHint();
        }
        this.syncNpcHook();
      },
    });
    this.npcs = npcs;
    this.looks.set(PLAYER_IDENTITY.id, { color: PLAYER_IDENTITY.color, name: PLAYER_IDENTITY.name });
    this.syncNpcHook();

    // Billboard: "your cut plays here" until a take exists, then the recorded clip (VideoTexture).
    const bbPos = feet.clone().addScaledVector(f, 6.5).addScaledVector(right, -2.2);
    bbPos.y = (this.ground ? this.heightAt(bbPos.x, bbPos.z) : feet.y) + 1.9;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#0b0a10';
    g.fillRect(0, 0, 640, 360);
    g.strokeStyle = 'rgba(242,236,220,.25)';
    g.lineWidth = 4;
    g.strokeRect(8, 8, 624, 344);
    g.fillStyle = '#ffb54a';
    g.font = '600 34px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('your cut plays here', 320, 170);
    g.fillStyle = 'rgba(242,236,220,.7)';
    g.font = '22px system-ui, sans-serif';
    g.fillText('talk to the photographer · Enter = action / cut', 320, 215);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const bb = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.8), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    bb.position.copy(bbPos);
    bb.lookAt(feet.x, bbPos.y, feet.z);
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(3.4, 2.0, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.9 }),
    );
    frame.position.set(0, 0, -0.05);
    bb.add(frame);
    this.world.add(bb);
    this.billboard = bb;

    const missionParam = Number(this.opts.params.get('mission') ?? '0');
    const studio = new StudioSession(
      document.body,
      this.world,
      this.playerMesh,
      this.renderer.domElement,
      this.cellId ?? this.currentSceneId,
      undefined,
      missionParam > 0 ? missionParam - 1 : 0,
      (actorId) =>
        new GhostActor(
          this.world,
          this.playerMesh,
          this.vehicle?.group ?? null,
          this.looks.get(actorId) ?? { color: 0x9be34a, name: actorId },
          CAR_FEET_DROP,
        ),
    );
    studio.onClip = (url) => this.showClip(url);
    studio.actorId = this.identity.id;
    studio.sessionId = this.opts.sessionId;
    // The reel (MIS-4): persisted per browser; the strip redraws on every verdict / export.
    try {
      studio.reel.restore(JSON.parse(localStorage.getItem('coast:reel') ?? 'null'));
    } catch {
      /* no saved reel */
    }
    this.reelStrip ??= createReelStrip(document.body, (missionId) => {
      void this.studio?.reviewMission(missionId).then((ok) => {
        if (ok) {
          this.subtitles ??= createSubtitles(document.body);
          this.subtitles.say('Reel', `${this.studio?.reel.entry(missionId)?.title ?? missionId} — best take · P stops`, 3000);
        }
      });
    });
    studio.onReel = (reel) => {
      try {
        localStorage.setItem('coast:reel', JSON.stringify(reel.serialize()));
      } catch {
        /* storage full or blocked */
      }
      this.reelStrip?.render(reel, studio.mission.id);
    };
    this.reelStrip.render(studio.reel, studio.mission.id);
    studio.propWriter = (id, pose) => {
      if (this.props?.grabbed?.spec.id === id) return; // the player is holding it: the live hand wins
      this.props?.setPose(id, pose.pos, pose.quat);
    };
    // Cut export (STU-3): the session borrows the renderer; the live loop pauses and the live body hides meanwhile.
    // A keyframed camera path with two keys or more drives the picture instead of a take's camera (CAM-7).
    // Every tier renders the cut through the post stack (the look as a LUT, offline is affordable anywhere).
    studio.exportScene = () => ({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      prepare: async () => {
        if (this.post) return;
        await this.ensurePost();
        this.postForExport = !this.postLive; // borrowed for the cut: gone again at `end` (a live stack stays)
      },
      begin: () => {
        this.exporting = true;
        this.rig.unlock();
        this.renderer.setAnimationLoop(null);
        this.spark.autoUpdate = false;
        this.playerMesh.visible = false;
        this.props?.select(null);
      },
      frame: () => this.atmosphere.frame(this.camera),
      // Spark's own update is asynchronous (a timeout, an accumulate, a sort on a worker, and the picture switches to
      // the new set only once its sort is in): an offline frame waits for all of it, so every exported frame is
      // accumulated and sorted for *its* camera and modifiers (`autoUpdate` is off meanwhile).
      settle: () => this.settleSplats(),
      render: () => this.renderFrame(1 / 30),
      look: () => this.lookName,
      end: () => {
        if (this.postForExport) {
          this.post?.dispose();
          this.post = null;
          this.postLoading = null;
          this.postForExport = false;
        }
        this.exporting = false;
        this.spark.autoUpdate = true;
        this.last = performance.now();
        this.renderer.setAnimationLoop((time) => this.tick(time));
        this.updateHint();
      },
    });
    studio.onLook = (look) => {
      if (!this.setLook(look)) console.warn(`mission look "${look}" is not a look the engine knows`);
    };
    this.syncCameraPath();
    window.__coastExport = async (opts) => {
      const r = await studio.exportCut(opts ?? {});
      return { bytes: r.blob.size, mime: r.mime, codec: r.codec, ext: r.ext, frames: r.frames, seconds: r.seconds, manifest: r.manifest };
    };
    // The people in the cell for the pose pass (STU-2); the ghosts on set are the session's own.
    studio.people = () =>
      (this.npcs?.npcs ?? []).map((n) => ({
        feet: [n.mesh.position.x, n.mesh.position.y, n.mesh.position.z] as [number, number, number],
        yaw: n.mesh.rotation.y,
      }));
    window.__coastExportControl = async (opts = {}) => {
      const { fps, ...span } = opts;
      const r = await studio.exportControl({ ...span, ...(fps ? { cut: { fps } } : {}) });
      return {
        ...(r.preview ? { preview: r.preview as Record<string, string> } : {}),
        passes: Object.fromEntries(
          Object.entries(r.passes).map(([k, v]) => [k, { bytes: v.blob.size, mime: v.mime, frames: v.frames, seconds: v.seconds }]),
        ),
        camera: {
          frames: r.camera.frames.length,
          width: r.camera.width,
          height: r.camera.height,
          near: r.camera.depth.near,
          far: r.camera.depth.far,
          first: r.camera.frames[0],
        },
      };
    };
    this.studio = studio;
    if (missionParam > 0) studio.brief(); // QA: `?mission=n` auto-briefs mission n
  }

  private showClip(url: string | null) {
    if (!url || !this.billboard) return;
    const v = this.billboardVideo ?? document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.src = url;
    v.play().catch(() => {});
    if (!this.billboardVideo) {
      this.billboardVideo = v;
      const tex = new THREE.VideoTexture(v);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = this.billboard.material as THREE.MeshBasicMaterial;
      mat.map = tex;
      mat.needsUpdate = true;
    }
  }

  /** Ground height difference between the spawn and a point offset from it (so props start above the terrain). */
  // ── Frame ─────────────────────────────────────────────────────────────────────────────────────────────────

  private tick(time: number) {
    const dtMs = time - this.last;
    this.last = time;
    const dt = Math.min(dtMs / 1000, 0.1);
    this.frameTimes.push(dtMs);
    if (this.frameTimes.length > 240) this.frameTimes.shift();
    window.__coastFrame = this.frame;
    window.__coastLod = !!(this.splat as unknown as { packedSplats?: { lodSplats?: unknown } } | null)?.packedSplats?.lodSplats;
    if (!this.lodReported && window.__coastReady) {
      // Detail stage: the LoD tree is built — or the world has clearly been on screen for a while (no LoD on tiny scenes).
      if (window.__coastLod) this.readyFrames = 90;
      else if ((this.spark.display?.numSplats ?? 0) > 0) this.readyFrames++;
      if (this.readyFrames >= 90) {
        this.lodReported = true;
        this.loadingScreen?.progress('lod', 1);
      }
    }

    this.atmosphere.update(dt, this.camera);
    if (this.atmosphere.tweening) for (const road of this.corridors.values()) road.setFogColor(this.atmosphere.fogColorHex);
    if (this.isShot) {
      if (this.splat) this.splat.rotation.y = this.freezeT * 0.5; // deterministic pose for screenshots
    } else {
      this.pollInput(dt);
      this.handleEdges();
      this.simulate(dt);
      this.updateCamera(dt);
      this.updatePointer();
      this.feedDeixis();
      this.metronome.tick(performance.now());
      this.pendingBeat = null; // consumed by this frame's meter sample
    }

    const post = this.renderFrame(dt);
    window.__coastDraws = post ? post.sceneDraws : this.renderer.info.render.calls;
    if (this.shotRequests.length) {
      this.renderer.getContext().finish(); // software GL: make sure the instanced splat draw has landed before reading back
      const png = this.renderer.domElement.toDataURL('image/png');
      for (const r of this.shotRequests.splice(0)) r(png);
    }
    this.studio?.frameRendered();
    this.perf.tick(dtMs);
    if (this.frame++ % 10 === 0) this.renderHud();
  }

  /** The frame: through the post stack (grade share + look) when there is one and we are not presenting to an XR layer. */
  private renderFrame(dt: number): PostStack | null {
    const post = this.post && (this.postLive || this.exporting) && !this.renderer.xr.isPresenting ? this.post : null;
    if (!post) {
      this.renderer.render(this.scene, this.camera);
      return null;
    }
    const s = this.atmosphere.state;
    post.setGrade(s.postContrast, s.postLift, s.neon);
    post.render(dt);
    return post;
  }

  /** The post stack, loaded on demand (`@coast/engine/post` is its own chunk, QB-3) and wearing the current look. */
  private async ensurePost(): Promise<PostStack> {
    if (this.post) return this.post;
    this.postLoading ??= import('@coast/engine/post').then(({ PostStack }) => {
      const post = new PostStack(this.renderer, this.scene, this.camera);
      post.setLook(this.lookName);
      this.post ??= post;
      return this.post;
    });
    return this.postLoading;
  }

  /**
   * Accumulate and sort the splats for the current camera and modifiers and wait until that set is what draws
   * (Spark keeps showing the last *sorted* set; with LoD the set changes with the view, so the sort is what settles it).
   */
  private async settleSplats(): Promise<void> {
    const spark = this.spark;
    await spark.update({ scene: this.scene, camera: this.camera });
    const deadline = performance.now() + 4000;
    while ((spark.sorting || spark.display !== spark.current) && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4));
      if (!spark.sorting && spark.display !== spark.current) await spark.update({ scene: this.scene, camera: this.camera });
    }
  }

  /** The look by name (MIS-6): remembered even where nothing renders it live, so the cut export gets it. */
  private setLook(name: string): boolean {
    if (!isLookName(name)) return false;
    this.lookName = name;
    this.post?.setLook(name);
    return true;
  }

  private pollInput(dt: number) {
    resetFrameInput(this.input);
    for (const p of this.providers) p.poll(dt, this.input);
  }

  private handleEdges() {
    const i = this.input;
    if (i.sceneKey) {
      const id = SCENE_ORDER[i.sceneKey - 1];
      if (id) void this.loadScene(id);
    }
    if (i.timeCycle) {
      this.timePreset = TIME_ORDER[(TIME_ORDER.indexOf(this.timePreset) + 1) % TIME_ORDER.length]!;
      this.timeByUser = true;
      this.recolorWorld();
    }
    if (i.modeCycle) {
      if (this.inXr) {
        // VR has two perspectives: actor (life-size) and producer (the diorama). Director is a desktop/phone view.
        this.rig.setMode(this.rig.mode === 'producer' ? 'actor' : 'producer');
        this.setDiorama(this.rig.mode === 'producer');
      } else this.setRigMode(RIG_ORDER[(RIG_ORDER.indexOf(this.rig.mode) + 1) % RIG_ORDER.length]!);
      this.props?.select(null);
      this.updateHint();
    }
    if (i.snapTurn && this.inXr && !this.diorama) this.snapTurn(i.snapTurn);
    if (this.inXr && !this.diorama && !this.driving && this.character) {
      const marker = this.ensureTeleportMarker();
      if (i.teleport === 'aim' || i.teleport === 'go') {
        const ray = this.pointerRay();
        const hit = ray ? this.groundHit(ray) : null;
        if (hit && i.teleport === 'aim') {
          marker.visible = true;
          marker.position.copy(hit).add(this.tmpV2.set(0, 0.03, 0));
        } else if (hit) {
          marker.visible = false;
          this.character.teleport(hit.add(this.tmpV2.set(0, 0.1, 0)));
          this.placeXrFrameNow(); // before simulate, or the walk-offset logic would pull the body back
          performance.mark('coast:teleport');
        } else marker.visible = false;
      } else marker.visible = false;
    }
    if (i.debugToggle) {
      this.debug = !this.debug;
      for (const c of this.cells.values()) if (c.groundMesh) c.groundMesh.visible = this.debug;
      for (const m of this.colliderMeshes) m.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).visible = this.debug) : null));
    }
    if (i.resetEdge) this.respawn();
    if (i.undo) {
      if (this.holdingSprayCan()) this.painter?.undo();
      else this.props?.undo();
      this.syncPaintHook();
    }
    if (i.cancel) this.props?.select(null);
    if (i.say && this.director && !this.inXr) this.director.toggle();
    if (this.realtime) {
      // The voice director is live (server VAD): ` toggles the microphone instead of pushing to talk.
      if (i.ptt && !this.pttWasHeld) {
        this.realtime.session.setMuted(!this.realtime.session.muted);
        this.hint = this.realtime.session.muted ? 'mic muted — ` to unmute' : 'voice director live — just talk';
      }
    } else if (this.voice && !this.typing) {
      // Push-to-talk: hold ` / LT / MIC — the transcript directs on release.
      if (i.ptt && !this.pttWasHeld) this.voice.start();
      else if (!i.ptt && this.pttWasHeld) this.voice.stop();
    }
    this.pttWasHeld = i.ptt;
    if (i.muteToggle) {
      this.tts.setMuted(this.sfx.toggleMuted());
      this.updateHint();
    }
    if (i.beatToggle) {
      this.autoHop = !this.autoHop;
      if (this.autoHop) this.metronome.enable(performance.now());
      else this.metronome.disable();
      this.updateHint();
    }

    const props = this.props;
    if (!props || !this.character) return;

    // Lowrider: E gets in / out; Space hops (a manual hop is a judged beat event, MIS-2 beatSync).
    const wasDriving = this.driving;
    if (wasDriving) {
      if (i.interact) this.exitVehicle();
      else if (i.jump && this.vehicle) {
        this.vehicleInput.hop = this.hopPattern();
        this.pendingBeat = { event: 'hop', phaseMs: this.beat.phase(performance.now()).msToNearest };
        this.sfx.hydraulic(HOP_CORNERS[this.vehicleInput.hop].length);
      }
    }

    // Studio: roll / cut / playback (goal.md §3.1 steps 4–5)
    if (this.studio) {
      if (i.action) {
        const r = this.studio.action(this.frameContext());
        if (r === 'ignored' && this.studio.state === 'idle') this.studio.card.setStatus('walk up to the photographer first');
        else if (r !== 'ignored') this.sfx.clapper();
        this.updateHint();
      }
      if (i.playback) this.studio.togglePlayback(performance.now());
    }
    if (i.possess && !wasDriving && !this.inXr) this.possessNearest();

    // Grab / throw (PHY-2) — or get in the lowrider when it is the closer thing (never on the edge that just got out).
    if (i.interact && !wasDriving) {
      if (props.grabbed) {
        this.studio?.edit(performance.now(), { kind: 'propRelease', propId: props.grabbed.spec.id });
        props.release(null);
        this.sfx.tick(700);
      } else {
        const near = this.nearestProp(2.6);
        const carDist = this.vehicleDistance();
        if (carDist < ENTER_DISTANCE && (!near || carDist < near.mesh.position.distanceTo(this.character.feet(this.tmpV)))) {
          this.enterVehicle();
        } else if (near) {
          props.grab(near);
          this.studio?.edit(performance.now(), { kind: 'propGrab', propId: near.spec.id });
          this.sfx.tick(1200);
        }
      }
    }
    if (i.throwEdge && props.grabbed) {
      const v = this.camera
        .getWorldDirection(new THREE.Vector3())
        .multiplyScalar(9)
        .add(new THREE.Vector3(0, 3, 0));
      this.studio?.edit(performance.now(), { kind: 'propThrow', propId: props.grabbed.spec.id, velocity: [v.x, v.y, v.z] });
      props.release(v);
    }

    // Spray paint (W-4): holding a can, the primary button sprays along the pointer ray onto the splats — a click is one
    // puff, holding it (pointer lock / XR trigger) lays a stroke. Throwing the can stays on F / right squeeze.
    if (this.holdingSprayCan() && !this.diorama) {
      const held = i.primaryHeld && (this.rig.mode === 'actor' || this.inXr); // in director mode a drag is the orbit
      if (i.select || held) {
        if (!this.spraying) {
          this.spraying = true;
          this.painter?.begin();
        }
        this.sprayAt(this.pointerRay());
      } else if (this.spraying) {
        this.spraying = false;
        this.painter?.end();
      }
      if (i.select) return; // the click was the spray, not a select
    } else if (this.spraying) {
      this.spraying = false;
      this.painter?.end();
    }

    // Put that there — click/tap fallback (DIR-3): click a prop to select, click the ground to place.
    if (i.select) {
      const ray = this.pointerRay();
      if (ray) {
        if (props.grabbed) {
          const v = this.camera
            .getWorldDirection(new THREE.Vector3())
            .multiplyScalar(9)
            .add(new THREE.Vector3(0, 3, 0));
          this.studio?.edit(performance.now(), { kind: 'propThrow', propId: props.grabbed.spec.id, velocity: [v.x, v.y, v.z] });
          props.release(v);
        } else if (props.selected) {
          const hit = this.groundHit(ray);
          if (hit) {
            const id = props.selected.spec.id;
            props.placeSelectedAt(hit);
            this.studio?.edit(performance.now(), { kind: 'propPlace', propId: id, pos: [hit.x, hit.y, hit.z] });
          } else props.select(props.pick(ray));
        } else {
          props.select(props.pick(ray));
          if (props.selected) performance.mark('coast:act-preview');
        }
        this.updateHint();
      }
    }
  }

  private simulate(dt: number) {
    const physics = this.physics;
    const ch = this.character;
    if (!physics || !ch || !this.physicsReady) return;
    const i = this.input;
    const driving = this.driving && !!this.vehicle;
    if (this.diorama) return; // the world is on the table: physics paused (CAM-3)
    if (this.inXr) {
      // The head rules: movement is relative to where the user looks; the capsule faces the same way.
      this.readHead();
      this.rig.yaw = yawOf(this.headQuat);
      if (!driving) ch.yaw = this.rig.yaw;
    }
    // Local move → world move relative to the camera yaw.
    const yaw = this.rig.yaw;
    const mx = THREE.MathUtils.clamp(i.move.x, -1, 1);
    const my = THREE.MathUtils.clamp(i.move.y, -1, 1);
    this.tmpMove.set(mx * Math.cos(yaw) - my * Math.sin(yaw), -mx * Math.sin(yaw) - my * Math.cos(yaw));
    const charInput: Parameters<CharacterController['step']>[1] = {
      move: this.tmpMove,
      jump: i.jump && !driving,
      sprint: i.sprint,
      offset: null,
    };
    if (this.inXr && !driving) {
      // Physical walking: the head drifted from the frame origin → the capsule tries to follow (the frame is put back
      // under the head in updateCamera, so a blocked capsule pushes the world instead of leaving the body behind).
      // Where the frame would have to be for the head to stand over the feet, vs where it is: the difference is how
      // far the user physically walked since the frame was last placed.
      const wanted = framePositionForHead(ch.feet(this.tmpV), this.xrYaw, this.headLocal, this.tmpV2);
      const dx = this.localFrame.position.x - wanted.x;
      const dz = this.localFrame.position.z - wanted.z;
      if (Math.hypot(dx, dz) > 0.005) charInput.offset = new THREE.Vector2(dx, dz);
    }

    // Lowrider input: the stick drives when you are in it; the switchbox works from outside too (it is a show car).
    const vi = this.vehicleInput;
    vi.throttle = driving ? my : 0;
    vi.steer = driving ? mx : 0;
    vi.brake = driving && i.sprint;
    vi.lift = liftFromAxes(THREE.MathUtils.clamp(i.hydro.x, -1, 1), THREE.MathUtils.clamp(i.hydro.y, -1, 1));
    if (this.autoHop) {
      const now = performance.now();
      for (const b of this.beat.crossed(now)) {
        const bpb = this.beat.grid.beatsPerBar;
        vi.hop = AUTO_HOP_PATTERN[(((b % bpb) + bpb) % bpb) % AUTO_HOP_PATTERN.length] ?? 'front';
        this.sfx.hydraulic(HOP_CORNERS[vi.hop].length);
      }
    }

    const jumped = !!charInput.jump && ch.grounded;
    physics.step(dt, (fixedDt) => {
      this.props?.beforeStep();
      this.vehicle?.beforeStep();
      this.vehicle?.step(fixedDt, vi);
      vi.hop = null; // edge consumed by the first sub-step
      if (!driving) ch.step(fixedDt, charInput);
      charInput.jump = false;
      charInput.offset = null; // physical displacement applies once per frame
      if (this.props?.grabbed) this.props.updateGrabbed(this.holdPoint());
    });
    window.__coastSteps = physics.stepCount;
    if (jumped) this.sfx.jump();
    if (!driving) {
      for (const ev of this.stride.update(ch.speed, ch.grounded, dt)) {
        if (ev === 'step') this.sfx.footstep('grass', ch.speed, this.stride.foot as 0 | 1);
        else this.sfx.land();
      }
    }
    if (this.vehicle) {
      this.sfx.engineStart(this.vehicle.group); // no-op once running; first call after the audio unlock starts it
      this.sfx.engineUpdate(this.vehicle.speed, vi.throttle, driving);
    }
    this.sfx.spraySet(this.spraying);
    if (this.npcs) {
      this.npcs.update(dt, driving ? this.carFeet(this.tmpV) : ch.feet(this.tmpV), false);
      if (this.frame % 10 === 0) this.syncNpcHook();
    }
    if (this.rig.mode === 'actor' && !driving && !this.inXr) ch.yaw = this.rig.yaw;
    this.updateStreaming(driving ? this.carFeet(this.tmpV) : ch.feet(this.tmpV));
    if (this.navDirty) {
      this.navDirty = false;
      this.rebuildNav();
    }
    this.props?.sync(physics.alpha);
    this.vehicle?.sync(physics.alpha);
    if (this.vehicle) {
      const p = this.vehicle.position(this.tmpV);
      window.__coastVehicle = {
        driving,
        speed: this.vehicle.speed,
        pos: [p.x, p.y, p.z],
        hops: this.vehicle.hops,
        wheels: this.vehicle.wheelsOnGround,
        autoHop: this.autoHop,
      };
    } else if (window.__coastVehicle) window.__coastVehicle = undefined;
    // Fell through the world? Respawn on the ground (directly — an input edge set here would be cleared before it is read).
    const fell =
      (driving ? this.vehicle!.position(this.tmpV) : ch.feet(this.tmpV)).y < -40 || (this.vehicle?.position(this.tmpV2).y ?? 0) < -40;
    if (fell) this.respawn();
  }

  private updateCamera(dt: number) {
    const ch = this.character;
    const car = this.driving ? this.vehicle : null;
    const feet = car ? this.carFeet(this.tmpV) : ch ? ch.feet(this.tmpV) : this.tmpV.set(...(this.sceneDef.spawn ?? [0, 0, 0]));
    const look = { yaw: this.input.look.x, pitch: this.input.look.y, zoom: this.input.zoom };
    if (this.inXr) {
      this.updateXrFrame(feet, car ? car.yaw : 0);
      if (ch) {
        this.playerMesh.visible = this.diorama;
        this.playerMesh.position.copy(feet);
        this.playerMesh.rotation.y = car ? car.yaw : ch.yaw;
        this.updateStudio(feet);
      }
      this.crosshair.style.display = 'none';
      return;
    }
    if (car && ch) {
      // Driving: the rig follows the car; in first person the look turns with the car (free look on top).
      const carYaw = car.yaw;
      const dYaw = Math.atan2(Math.sin(carYaw - this.lastCarYaw), Math.cos(carYaw - this.lastCarYaw));
      this.lastCarYaw = carYaw;
      if (this.rig.mode === 'actor') this.rig.yaw += dYaw;
      this.rig.update(dt, this.camera, { feet, yaw: carYaw, eyeHeight: CAR_EYE_HEIGHT, followScale: CAR_FOLLOW }, look);
      if (this.ground && this.rig.mode !== 'actor') {
        const minY = this.heightAt(this.camera.position.x, this.camera.position.z) + 0.25;
        if (this.camera.position.y < minY) this.camera.position.y = minY;
      }
      this.playerMesh.visible = false;
      this.updateStudio(feet);
    } else if (ch) {
      const followed = this.followId && this.rig.mode !== 'actor' ? this.followTarget(this.followId) : null;
      if (followed) this.rig.update(dt, this.camera, followed, look);
      else this.rig.update(dt, this.camera, { feet, yaw: ch.yaw, eyeHeight: EYE_HEIGHT }, look);
      // Keep follow cameras above the terrain (low-angle shots may dip, never clip through the ground).
      if (this.ground && this.rig.mode !== 'actor') {
        const minY = this.heightAt(this.camera.position.x, this.camera.position.z) + 0.25;
        if (this.camera.position.y < minY) this.camera.position.y = minY;
      }
      this.playerMesh.visible = this.rig.mode !== 'actor';
      this.playerMesh.position.copy(feet);
      this.playerMesh.rotation.y = ch.yaw;
      this.updateStudio(feet);
    } else if (!this.sceneDef.world) {
      // Object scenes (butterfly): free orbit-ish look with drag, no character.
      this.rig.yaw -= look.yaw;
      this.camera.rotation.y = this.rig.yaw;
    }
    this.crosshair.style.display = this.rig.mode === 'actor' && this.input.pointerLocked ? 'block' : 'none';
  }

  /**
   * XR (CAM-4): place the frame so the head stands over the subject's feet — the character when walking, the driver's
   * seat when driving — with the accumulated snap-turn yaw on top. In the diorama the frame stays put and the world moves.
   */
  private updateXrFrame(feet: THREE.Vector3, subjectYaw: number) {
    if (this.diorama) return;
    this.readHead();
    const yaw = subjectYaw + this.xrYaw;
    this.localFrame.rotation.y = yaw;
    if (this.driving) {
      framePositionForHead(feet, yaw, this.headLocal, this.localFrame.position);
      this.localFrame.position.y = feet.y - 0.6; // a standing user's eye lands in the cabin
      this.lastCarYaw = subjectYaw;
    } else framePositionForHead(feet, yaw, this.headLocal, this.localFrame.position);
  }

  /**
   * The keyframed path (CAM-7): a key is the camera as it stands, timed from the first key (at least half a second
   * after the last); `play` locks the rig to the path (re-timed to `seconds` when given) until its end.
   */
  private cameraPathOp(op: NonNullable<CameraRequest['path']>, seconds?: number, loop?: boolean): boolean {
    const ok = this.cameraPathEdit(op, seconds, loop);
    this.syncCameraPath();
    this.syncDirectorHook();
    return ok;
  }

  /** The studio exports through the path once it has two keys (CAM-7). */
  private syncCameraPath() {
    if (this.studio) this.studio.cameraPath = this.cameraPath.size >= 2 ? this.cameraPath.toJSON() : null;
  }

  private cameraPathEdit(op: NonNullable<CameraRequest['path']>, seconds?: number, loop?: boolean): boolean {
    const path = this.cameraPath;
    const now = performance.now();
    switch (op) {
      case 'key': {
        if (path.size === 0) this.pathStartedAt = now;
        const last = path.keys[path.size - 1];
        const t = last ? Math.max(last.t + 0.5, (now - this.pathStartedAt) / 1000) : 0;
        path.addFromCamera(this.camera, t);
        this.subtitles?.say('Director', `key ${path.size} · ${t.toFixed(1)} s`, 2000);
        return true;
      }
      case 'play': {
        if (path.size < 2) {
          this.subtitles?.say('Director', 'two keys make a path — set another', 2500);
          return false;
        }
        if (seconds && seconds > 0) path.retime(seconds);
        this.followId = null;
        const ok = this.rig.lock(path, { loop: loop ?? false });
        if (ok) performance.mark('coast:path-play');
        return ok;
      }
      case 'stop':
        if (!this.rig.locked) return false;
        this.rig.unlock();
        return true;
      case 'clear':
        path.clear();
        this.rig.unlock();
        return true;
      case 'undo_key':
        return path.removeLast() !== undefined;
    }
  }

  /** Ghost preview while a prop is selected (DIR-3), following the pointer or the crosshair. */
  private updatePointer() {
    const props = this.props;
    if (!props?.selected) return;
    const ray = this.pointerRay();
    props.previewAt(ray ? this.groundHit(ray) : null);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────

  private pointerRay(): THREE.Ray | null {
    if (this.input.pointerRay) return this.input.pointerRay;
    const ndc = this.input.pointerLocked || this.input.pointer === null ? new THREE.Vector2(0, 0) : this.input.pointer;
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray.clone();
  }

  /** Ground point under a ray (grid mesh or cell collider), or null. */
  private groundHit(ray: THREE.Ray): THREE.Vector3 | null {
    this.raycaster.ray.copy(ray);
    const targets: THREE.Object3D[] = [];
    for (const c of this.cells.values()) if (c.groundMesh) targets.push(c.groundMesh);
    for (const m of this.colliderMeshes) targets.push(m);
    for (const road of this.corridors.values()) targets.push(road.road);
    const hits = this.raycaster.intersectObjects(targets, true);
    return hits[0]?.point ?? null;
  }

  private nearestProp(maxDist: number) {
    const props = this.props;
    const ch = this.character;
    if (!props || !ch) return null;
    const feet = ch.feet(this.tmpV);
    const fwd = this.camera.getWorldDirection(this.tmpV2);
    let best: ReturnType<PropSystem['pick']> = null;
    let bestScore = Infinity;
    for (const p of props.props.values()) {
      const d = p.mesh.position.distanceTo(feet);
      if (d > maxDist) continue;
      const dir = p.mesh.position.clone().sub(feet).normalize();
      const facing = 1 - dir.dot(fwd); // 0 = straight ahead
      const score = d + facing * 1.5;
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  private holdingSprayCan(): boolean {
    return !!this.props?.grabbed?.spec.tags?.includes('spray');
  }

  /** One puff where the ray meets the splats, within arm's reach of the can; logged into the take (ACT-2 sdfPaint). */
  private sprayAt(ray: THREE.Ray | null) {
    const painter = this.painter;
    const can = this.props?.grabbed;
    if (!painter || !can || !ray || !this.splat) return;
    // Nearest surface along the ray: the splats themselves (walls, objects — Spark raycasts the LoD subset, which can
    // slip between thin ground splats) or the physics ground / collider (solid, so the floor always takes paint).
    this.raycaster.ray.copy(ray);
    const hits: THREE.Intersection[] = [];
    for (const c of this.cells.values()) if (c.loaded) c.mesh.raycast(this.raycaster, hits);
    hits.sort((a, b) => a.distance - b.distance);
    let point = hits[0]?.point ?? null;
    const ground = this.groundHit(ray);
    if (ground && (!point || ray.origin.distanceTo(ground) < ray.origin.distanceTo(point))) point = ground;
    // Arm's reach is measured from the hand (the can), not from a chase camera sitting metres behind the player.
    if (!point || point.distanceTo(this.holdPoint()) > Game.SPRAY_RANGE) return;
    const hit = { point };
    this.sprayColor.setHex(can.spec.color);
    const puff = painter.spray(hit.point, this.sprayColor, 0.22);
    if (!puff) return;
    this.studio?.edit(performance.now(), { kind: 'sdfPaint', shape: 'sphere', pos: puff.pos, r: puff.r, rgba: puff.rgba });
    performance.mark('coast:spray');
    this.syncPaintHook();
  }

  private syncPaintHook() {
    if (this.painter) window.__coastPaint = { count: this.painter.count, strokes: this.painter.strokes.length };
  }

  /** Distance from the player's feet to the lowrider's chassis (∞ without one). */
  private vehicleDistance(): number {
    if (!this.vehicle || !this.character) return Infinity;
    return this.vehicle.position(this.tmpV2).distanceTo(this.character.feet(this.tmpV));
  }

  private holdPoint(): THREE.Vector3 {
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    if (this.rig.mode === 'actor') return this.camera.position.clone().addScaledVector(fwd, 1.5);
    const feet = this.character!.feet(new THREE.Vector3());
    const f = this.rig.forwardXZ(new THREE.Vector3());
    return feet.addScaledVector(f, 1.2).add(new THREE.Vector3(0, 1.0, 0));
  }

  /** Studio per-frame: proximity brief by the Photographer, take sampling + judging (goal.md MIS-2). */
  private updateStudio(feet: THREE.Vector3) {
    const studio = this.studio;
    if (!studio) return;
    this.syncStudioHook();
    const photographer = this.npcs?.byId('photographer');
    // Possessing the Photographer (ACT-3) puts her identity on the player: you are never "away" from yourself, so the
    // brief and the verdict stay put (walking off to bank the stars needs her body back, or the reel).
    const npcDist = photographer ? feet.distanceTo(photographer.mesh.position) : this.identity.id === 'photographer' ? 0 : Infinity;
    if (studio.state === 'idle' && npcDist < 2.6) {
      studio.brief();
      this.updateHint();
    } else if (studio.state === 'verdict') {
      // Walking off after reading the verdict banks the stars and queues the next mission (talk to the tutor again).
      if (this.verdictAt === 0) this.verdictAt = performance.now();
      else if (npcDist > LEAVE_DISTANCE && performance.now() - this.verdictAt > VERDICT_GRACE_MS) {
        studio.leave();
        this.verdictAt = 0;
        this.reelStrip?.render(studio.reel, studio.mission.id);
        this.updateHint();
      }
    } else this.verdictAt = 0;
    studio.tick(this.frameContext());
  }

  /**
   * Possession (goal.md ACT-3): swap bodies with the nearest NPC within reach — you take their identity and spot, they
   * carry on as who you were (loitering where you stood). Doing it again next to that body switches back. The camera
   * rig follows the capsule, so it re-targets for free; takes from here on carry the new actor id and their ghosts wear
   * that look (the 3-take demo: $COAST, then the Photographer, then Rico, all in one scene).
   */
  private possessNearest() {
    const ch = this.character;
    const npcs = this.npcs;
    if (!ch || !npcs || this.studio?.state === 'recording') return;
    const npc = npcs.nearest(ch.feet(new THREE.Vector3()), POSSESS_DISTANCE);
    if (!npc) {
      this.hint = 'nobody within reach to possess';
      return;
    }
    this.possessNpc(npc);
  }

  /** Swap bodies with `npc` (any distance — the director can say "be Rico" from across the block). */
  private possessNpc(npc: Npc): boolean {
    const ch = this.character;
    const npcs = this.npcs;
    if (!ch || !npcs || this.driving || this.inXr || this.studio?.state === 'recording') return false;
    const feet = ch.feet(new THREE.Vector3());
    const was = npcs.swapIdentity(npc, this.identity, feet, ch.yaw);
    this.setIdentity(was.spec);
    ch.teleport(was.position);
    ch.yaw = was.yaw;
    this.rig.yaw = was.yaw;
    this.possessions++;
    this.sfx.tick(this.identity.id === PLAYER_IDENTITY.id ? 500 : 1500);
    this.subtitles?.say(
      this.identity.name,
      this.identity.id === PLAYER_IDENTITY.id ? 'Back in my own shoes.' : `You're ${this.identity.name} now.`,
      4000,
    );
    this.updateHint();
    this.syncNpcHook();
    return true;
  }

  /** Wear an identity: the placeholder's colour and the take recorder's actor id follow it. */
  private setIdentity(spec: NpcSpec) {
    this.identity = spec;
    const body = this.playerMesh.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | undefined;
    body?.material.color.setHex(spec.color);
    if (this.studio) this.studio.actorId = spec.id;
  }

  /** Where the follow camera goes when it is on something other than the player (CAM-6 "follow the car"). */
  private followTarget(id: string): RigTarget | null {
    if (id === 'lowrider' && this.vehicle) {
      return { feet: this.carFeet(this.tmpV).clone(), yaw: this.vehicle.yaw, eyeHeight: CAR_EYE_HEIGHT, followScale: CAR_FOLLOW };
    }
    const npc = this.npcs?.byId(id);
    if (npc) return { feet: npc.mesh.position.clone(), yaw: npc.mesh.rotation.y, eyeHeight: EYE_HEIGHT };
    const prop = this.props?.props.get(id);
    if (prop) return { feet: prop.mesh.position.clone(), yaw: this.rig.yaw, eyeHeight: 0.6 };
    return null;
  }

  /** The thing under a ray: a prop, an NPC or the lowrider (ids the director's references resolve to). */
  private pickAny(ray: THREE.Ray): string | null {
    const prop = this.props?.pick(ray);
    if (prop) return prop.spec.id;
    const targets: THREE.Object3D[] = [];
    if (this.npcs) for (const n of this.npcs.npcs) targets.push(n.mesh);
    if (this.vehicle) targets.push(this.vehicle.group);
    if (!targets.length) return null;
    this.raycaster.ray.copy(ray);
    const hit = this.raycaster.intersectObjects(targets, true)[0];
    if (!hit) return null;
    let o: THREE.Object3D | null = hit.object;
    while (o) {
      if (this.vehicle && o === this.vehicle.group) return 'lowrider';
      if (this.npcs && o.parent === this.world && this.npcs.npcs.some((n) => n.mesh === o)) return o.name;
      o = o.parent;
    }
    return null;
  }

  /** One pointing sample per frame for the deixis buffer (DIR-3): what the pointer is on, the selection, the ground. */
  private feedDeixis() {
    const d = this.director;
    if (!d || !this.physicsReady || this.diorama) return;
    const ray = this.pointerRay();
    const sample: DeixisSample = { t: performance.now() };
    if (ray) {
      const hit = this.pickAny(ray);
      if (hit) sample.pointerHit = hit;
      const g = this.groundHit(ray);
      if (g) sample.groundPoint = [g.x, g.y, g.z];
      if (this.input.pointerRay) sample.headHit = hit ?? undefined; // an XR ray counts as a pointed hand/head ray
    }
    if (this.props?.selected) sample.selection = this.props.selected.spec.id;
    if (this.input.select) sample.clickEdge = true;
    d.sample(sample, 3);
  }

  private setRigMode(mode: RigMode) {
    if (this.inXr) return;
    this.rig.setMode(mode);
    this.kbm.setPointerLockDesired(mode === 'actor');
    if (mode === 'actor') this.followId = null;
    this.realtime?.client.refreshTools(); // CAM-8: the voice director sees only this mode's tools
  }

  /**
   * The Realtime voice director (DIR-1): the Worker mints the secret, the browser talks WebRTC, the model's tool
   * calls run through the same executor as the `/` bar. Without a key (503) or a budget (402) the browser recogniser
   * stays the voice path.
   */
  private async startRealtime(premium = false) {
    if (this.realtime || !this.director || !this.ops) return;
    const client = new RealtimeClient({
      executor: this.director.executor,
      ops: this.ops,
      buffer: this.deixis,
      mode: () => this.rig.mode,
      speakerForward: () => {
        const f = this.camera.getWorldDirection(this.tmpV);
        return [f.x, f.z];
      },
      sceneSummary: () => this.sceneSummary(),
      missionBrief: () => {
        const st = this.studio;
        if (!st || st.state === 'idle') return null;
        return `${st.mission.title} — ${st.mission.constraints.map((c) => c.kind).join(', ')} (take ${st.takesUsed + 1} of ${st.mission.takesMax})`;
      },
      onTranscript: (text) => {
        this.subtitles ??= createSubtitles(document.body);
        this.subtitles.say(this.identity.name, text, 3000);
      },
      onAssistant: (text) => {
        this.subtitles ??= createSubtitles(document.body);
        this.subtitles.say('Director', text, 4000);
      },
      onAct: (env, result) => {
        window.__coastDirector = {
          text: `${env.act.op} (voice)`,
          ok: [result.ok],
          summary: result.ok ? `✓ ${env.act.op}` : `✗ ${result.error ?? result.question ?? env.act.op}`,
          follow: this.followId,
          shot: { distance: this.rig.params.distance, height: this.rig.params.height, fovDeg: this.rig.params.fovDeg },
          path: { keys: this.cameraPath.size, durationS: this.cameraPath.durationS, locked: this.rig.locked, t: this.rig.pathTime },
        };
        this.updateHint();
      },
      onState: (state, detail) => {
        window.__coastVoice = { supported: true, state: `realtime:${state}${detail ? ` (${detail})` : ''}` };
        if (state === 'error') this.hint = `voice director: ${detail ?? 'error'}`;
        if (state === 'closed') this.realtime = null;
      },
    });
    try {
      const session = await connectRealtime({ sessionId: this.opts.sessionId, client, premium });
      this.realtime = { client, session };
      this.hint = 'voice director live — just talk (` mutes the mic)';
    } catch (e) {
      this.hint = `voice director unavailable: ${e instanceof Error ? e.message : String(e)} — hold \` for browser speech`;
      window.__coastVoice = { supported: this.voice?.supported ?? false, state: `realtime:unavailable` };
    }
  }

  /** ≤ 2 KB of what is on set, for the model's context (DIR-1 scene summary). */
  private sceneSummary() {
    return {
      mode: this.rig.mode,
      me: this.identity.id,
      props: [...(this.props?.props.values() ?? [])].map((p) => p.spec.id),
      people: (this.npcs?.npcs ?? []).map((n) => `${n.spec.id}:${n.spec.name}`),
      car: this.vehicle ? 'lowrider' : null,
      time: this.timePreset,
      recording: this.studio?.state === 'recording',
      takes: this.studio?.set.size ?? 0,
    };
  }

  private syncVoiceHook() {
    window.__coastVoice = { supported: this.voice?.supported ?? false, state: this.voice?.state ?? 'none' };
  }

  /** `__coastDirector`: the last direction's outcome, refreshed every frame with the live follow target and shot. */
  private syncDirectorHook(text?: string, outcome?: UtteranceOutcome) {
    const prev = window.__coastDirector;
    window.__coastDirector = {
      text: text ?? prev?.text ?? '',
      ok: outcome ? outcome.results.map((r) => r.ok) : (prev?.ok ?? []),
      summary: outcome ? summarize(outcome) : (prev?.summary ?? ''),
      follow: this.followId,
      shot: { distance: this.rig.params.distance, height: this.rig.params.height, fovDeg: this.rig.params.fovDeg },
      path: { keys: this.cameraPath.size, durationS: this.cameraPath.durationS, locked: this.rig.locked, t: this.rig.pathTime },
    };
  }

  /**
   * What the director can do to this scene (goal.md DIR-2 acts, CAM-8 role partition): the same surface the voice
   * model's tool calls land on. Ids: props ('crate_1'), 'lowrider', NPC ids, 'me'.
   */
  private sceneOps(): SceneOps {
    const now = () => performance.now();
    const propColor = (name: string): number | null => {
      const table: Record<string, number> = {
        red: 0xd11a2a,
        'candy red': 0xc0102a,
        blue: 0x2f6fd6,
        green: 0x3ad98a,
        yellow: 0xffd23f,
        orange: 0xff8a2a,
        purple: 0x8a4fd9,
        pink: 0xff3fa4,
        white: 0xf2ecdc,
        black: 0x0b0a10,
        gold: 0xffb54a,
        golden: 0xffb54a,
        chrome: 0xc9ced6,
        silver: 0xc9ced6,
        teal: 0x2ab7a9,
        cyan: 0x3fd0ff,
        grey: 0x8a8a8a,
        gray: 0x8a8a8a,
      };
      return table[name] ?? null;
    };
    const ASSETS: Record<string, PropSpec> = {
      crate: { id: '', shape: 'box', size: [0.35, 0.35, 0.35], color: 0xd9743a, mass: 3 },
      box: { id: '', shape: 'box', size: [0.35, 0.35, 0.35], color: 0xd9743a, mass: 3 },
      cone: { id: '', shape: 'cylinder', size: [0.22, 0.35], color: 0xff8a2a, mass: 1 },
      can: { id: '', shape: 'cylinder', size: [0.12, 0.2], color: 0xff3fa4, mass: 0.6, tags: ['spray'] },
      'spray can': { id: '', shape: 'cylinder', size: [0.12, 0.2], color: 0x3fd0ff, mass: 0.6, tags: ['spray'] },
      ball: { id: '', shape: 'ball', size: [0.3], color: 0x9be34a, mass: 1.5 },
      barrel: { id: '', shape: 'cylinder', size: [0.3, 0.45], color: 0x2f6fd6, mass: 8 },
    };
    const feetOf = (id: string): THREE.Vector3 | null => {
      if (id === 'me') return this.driving ? this.carFeet(new THREE.Vector3()) : (this.character?.feet(new THREE.Vector3()) ?? null);
      if (id === 'lowrider') return this.vehicle ? this.carFeet(new THREE.Vector3()) : null;
      const npc = this.npcs?.byId(id);
      if (npc) return npc.mesh.position.clone();
      const prop = this.props?.props.get(id);
      return prop ? prop.mesh.position.clone() : null;
    };
    const propOf = (id: string) => this.props?.props.get(id) ?? null;
    return {
      byDescription: (desc) => {
        const d = desc
          .toLowerCase()
          .replace(/^(the|a|an|my|our)\s+/, '')
          .trim();
        if (/^(me|myself|player|coast|\$coast)$/.test(d)) return ['me'];
        if (/car|lowrider|ride|whip|impala/.test(d)) return this.vehicle ? ['lowrider'] : [];
        const out: string[] = [];
        for (const n of this.npcs?.npcs ?? []) {
          if (n.spec.name.toLowerCase() === d || n.spec.id === d || d.includes(n.spec.name.toLowerCase())) out.push(n.spec.id);
        }
        if (out.length) return out;
        if (/photographer|tutor|npc|extra|somebody|someone/.test(d)) return (this.npcs?.npcs ?? []).map((n) => n.spec.id);
        const me = feetOf('me');
        const props = [...(this.props?.props.values() ?? [])].filter((p) => {
          const kind = p.spec.id.replace(/_\d+$/, '');
          return (
            p.spec.id === d ||
            kind === d ||
            d.includes(kind) ||
            (p.spec.tags ?? []).some((t) => d.includes(t)) ||
            (/box/.test(d) && kind === 'crate')
          );
        });
        if (me) props.sort((a, b) => a.mesh.position.distanceTo(me) - b.mesh.position.distanceTo(me));
        return props.map((p) => p.spec.id);
      },
      positionOf: (id) => {
        const f = feetOf(id);
        return f ? [f.x, f.y, f.z] : undefined;
      },
      radiusOf: (id) => {
        if (id === 'lowrider') return this.vehicle?.boundingSphere(this.subjectSphere).radius ?? 2.4;
        const prop = propOf(id);
        if (prop) {
          if (!prop.mesh.geometry.boundingSphere) prop.mesh.geometry.computeBoundingSphere();
          return prop.mesh.geometry.boundingSphere?.radius ?? 0.5;
        }
        return 0.5;
      },
      move: (id, pos) => {
        const props = this.props;
        const prop = propOf(id);
        if (props && prop) {
          const p = new THREE.Vector3(pos[0], pos[1], pos[2]);
          if (this.ground) p.y = Math.max(p.y, this.heightAt(p.x, p.z));
          props.select(prop);
          props.placeSelectedAt(p);
          this.studio?.edit(now(), { kind: 'propPlace', propId: id, pos: [p.x, p.y, p.z] });
          this.sfx.tick(900);
          return true;
        }
        if (id === 'lowrider' && this.vehicle && !this.driving) {
          const p = new THREE.Vector3(pos[0], pos[1], pos[2]);
          if (this.ground) p.y = this.heightAt(p.x, p.z);
          this.vehicle.teleport(p.add(new THREE.Vector3(0, 1.2, 0)), this.vehicle.yaw);
          return true;
        }
        return false;
      },
      rotate: (id, yawDeg, faceId) => {
        const from = feetOf(id);
        if (!from) return false;
        let yaw: number;
        if (faceId) {
          const to = feetOf(faceId);
          if (!to) return false;
          yaw = Math.atan2(-(to.x - from.x), -(to.z - from.z));
        } else yaw = (yawDeg ?? 90) * (Math.PI / 180);
        const prop = propOf(id);
        if (prop) {
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
          if (!faceId)
            q.multiply(
              new THREE.Quaternion(prop.body.rotation().x, prop.body.rotation().y, prop.body.rotation().z, prop.body.rotation().w),
            );
          prop.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
          prop.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          return true;
        }
        const npc = this.npcs?.byId(id);
        if (npc) {
          npc.facing = faceId ? yaw : npc.facing + yaw;
          npc.faceTarget = null;
          return true;
        }
        if (id === 'lowrider' && this.vehicle && !this.driving) {
          this.vehicle.teleport(this.vehicle.position(new THREE.Vector3()), faceId ? yaw : this.vehicle.yaw + yaw);
          return true;
        }
        return false;
      },
      scale: (id, factor) => {
        const props = this.props;
        const prop = propOf(id);
        if (!props || !prop || !(factor > 0)) return false;
        const t = prop.body.translation();
        const yaw = new THREE.Euler().setFromQuaternion(prop.mesh.quaternion, 'YXZ').y;
        const spec: PropSpec = { ...prop.spec, size: prop.spec.size.map((v) => v * factor), mass: (prop.spec.mass ?? 1) * factor ** 3 };
        props.remove(id);
        const base = this.ground ? this.heightAt(t.x, t.z) : t.y - 0.5;
        props.spawn(spec, new THREE.Vector3(t.x, base + (spec.size[1] ?? spec.size[0] ?? 0.3) + 0.05, t.z), yaw);
        return true;
      },
      remove: (id) => {
        const props = this.props;
        if (!props || !propOf(id)) return false;
        if (props.grabbed?.spec.id === id) props.release(null);
        props.remove(id);
        this.sfx.tick(400);
        return true;
      },
      setMaterial: (id, color) => {
        const hex = propColor(color);
        if (hex === null) return false;
        const prop = propOf(id);
        if (prop) {
          (prop.mesh.material as THREE.MeshStandardMaterial).color.setHex(hex);
          return true;
        }
        const npc = this.npcs?.byId(id);
        if (npc) {
          npc.capsule.material.color.setHex(hex);
          return true;
        }
        return false;
      },
      spawn: (asset, pos) => {
        const props = this.props;
        const key = Object.keys(ASSETS).find((k) => asset === k || asset.includes(k));
        if (!props || !key) return null;
        const spec = { ...ASSETS[key]!, id: props.nextId(key.replace(/\s+/g, '')) };
        const p = new THREE.Vector3(pos[0], pos[1], pos[2]);
        if (this.ground) p.y = this.heightAt(p.x, p.z);
        p.y += (spec.size[1] ?? spec.size[0] ?? 0.3) + 0.3;
        props.spawn(spec, p);
        this.sfx.tick(1100);
        return spec.id;
      },
      setTime: (preset) => {
        if (!(TIME_ORDER as string[]).includes(preset)) return false;
        this.timePreset = preset as TimeOfDay;
        this.timeByUser = true;
        this.recolorWorld(this.timePreset);
        return true;
      },
      setWeather: (kind, amount) => {
        // Fog and rain are density on the same atmosphere (rain has no drops yet — it reads as a wet haze, W-5).
        this.atmosphere.setWeather(kind, amount ?? 0.6);
        return true;
      },
      setLook: (name) => this.setLook(name),
      possess: (id) => {
        if (!this.npcs) return false;
        if (id === 'me') {
          if (this.identity.id === PLAYER_IDENTITY.id) return true; // already me
          const body = this.npcs.byId(PLAYER_IDENTITY.id);
          return body ? this.possessNpc(body) : false;
        }
        if (id === this.identity.id) return true;
        const npc = this.npcs.byId(id);
        return npc ? this.possessNpc(npc) : false;
      },
      playAnim: () => false, // clips arrive with the skinned rigs (M4)
      replay: () => {
        const studio = this.studio;
        if (!studio || studio.set.size === 0) return false;
        studio.startPlayback(now(), true);
        return true;
      },
      record: (action) => {
        const studio = this.studio;
        if (!studio) return false;
        if (action === 'start') {
          if (studio.state === 'verdict' && studio.takesUsed < studio.mission.takesMax) studio.retake();
          if (!studio.canRoll) return false;
        } else if (studio.state !== 'recording') return false;
        const r = studio.action(this.frameContext());
        if (r !== 'ignored') this.sfx.clapper();
        return r !== 'ignored';
      },
      markBeat: (label) => {
        if (this.studio?.state !== 'recording') return false;
        this.studio.edit(now(), { kind: 'marker', label });
        this.sfx.tick(1400);
        return true;
      },
      undo: (n) => {
        let count = 0;
        for (let i = 0; i < n; i++) {
          if (this.props?.undo())
            count++; // the director's acts are mostly moves; the spray can has its own Z
          else if (this.painter?.undo()) count++;
          else break;
        }
        return count;
      },
      camera: (req: CameraRequest) => {
        if (this.inXr) return false;
        if (this.rig.mode === 'actor') this.setRigMode('director'); // "camera low" from first person: over the shoulder first
        let ok = false;
        if (req.followId !== undefined) {
          this.followId = req.followId === 'me' ? null : req.followId;
          ok = true;
        }
        if (req.shot) ok = this.rig.applyShot(req.shot) || ok;
        if (req.move) ok = this.rig.move(req.move, req.durationMs ?? 1500) || ok;
        if (req.lensMm !== undefined) ok = this.rig.lens(req.lensMm) || ok;
        if (req.path) ok = this.cameraPathOp(req.path, req.pathSeconds, req.loop) || ok;
        if (req.lookAtId) {
          const subject = feetOf(this.followId ?? 'me');
          const target = feetOf(req.lookAtId);
          if (subject && target && subject.distanceTo(target) > 0.1) {
            this.rig.yaw = Math.atan2(-(target.x - subject.x), -(target.z - subject.z));
            ok = true;
          }
        }
        return ok;
      },
      setMode: (mode) => {
        if (this.inXr) return false;
        this.setRigMode(mode);
        return true;
      },
      preview: (id, pos) => {
        const props = this.props;
        if (!props) return;
        const prop = id ? propOf(id) : null;
        if (!prop || !pos) {
          props.select(null);
          return;
        }
        props.select(prop);
        props.previewAt(new THREE.Vector3(pos[0], pos[1], pos[2]));
        performance.mark('coast:act-preview');
      },
    };
  }

  private npcNearby() {
    if (!this.character || !this.npcs) return null;
    return this.npcs.nearest(this.character.feet(this.tmpV), POSSESS_DISTANCE);
  }

  private syncStudioHook() {
    if (this.director) this.syncDirectorHook();
    const s = this.studio;
    window.__coastStudio = {
      actorId: this.identity.id,
      setSize: s?.set.size ?? 0,
      ghosts: s?.ghostsVisible ?? 0,
      state: s?.state ?? 'none',
      possessed: this.possessions,
    };
  }

  private syncNpcHook() {
    this.syncStudioHook();
    const p = this.npcs?.byId('photographer');
    window.__coastNpcs = {
      count: this.npcs?.npcs.length ?? 0,
      nav: this.npcs?.ready ?? false,
      greets: this.npcs?.greets ?? 0,
      photographer: p ? [p.mesh.position.x, p.mesh.position.y, p.mesh.position.z] : null,
    };
  }

  private frameContext() {
    const ch = this.character!;
    const car = this.driving ? this.vehicle : null;
    const feet = car ? this.carFeet(new THREE.Vector3()).clone() : ch.feet(new THREE.Vector3());
    const camPos = this.camera.getWorldPosition(new THREE.Vector3());
    const camH = this.ground ? camPos.y - this.heightAt(camPos.x, camPos.z) : camPos.y - feet.y;
    const subject = this.studio?.subjectId ?? 'crate_1';
    return {
      nowMs: performance.now(),
      feet,
      yaw: car ? car.yaw : ch.yaw,
      speed: car ? Math.abs(car.speed) : ch.speed,
      grounded: car ? car.wheelsOnGround >= 2 : ch.grounded,
      driving: !!car,
      props: this.awakeProps(),
      camera: this.camera,
      cameraHeightM: camH,
      subjectInFrame: this.subjectInFrame(subject),
      timePreset: this.timePreset,
      cell: this.cellId ?? this.currentSceneId,
      ...(this.pendingBeat ? { beatEvent: this.pendingBeat.event, beatPhaseMs: this.pendingBeat.phaseMs } : {}),
    };
  }

  /** Poses of the props in motion this frame (the take keeps the ones that move; a resting crate costs nothing). */
  private awakeProps(): NonNullable<FrameContext['props']> {
    const out: NonNullable<FrameContext['props']> = [];
    if (!this.props || this.studio?.state !== 'recording') return out;
    for (const p of this.props.props.values()) {
      if (p.body.isSleeping() && p !== this.props.grabbed) continue;
      const t = p.body.translation();
      const r = p.body.rotation();
      out.push({ id: p.spec.id, pos: [t.x, t.y, t.z], quat: [r.x, r.y, r.z, r.w] });
    }
    return out;
  }

  /** Frustum test of the subject's bounding sphere (subjectInFrame constraint): a prop id or 'lowrider'. */
  private subjectInFrame(id: string): boolean {
    this.frustumMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);
    if (id === 'lowrider') {
      if (!this.vehicle) return false;
      return this.frustum.intersectsSphere(this.vehicle.boundingSphere(this.subjectSphere));
    }
    const p = this.props?.props.get(id);
    if (!p) return false;
    if (!p.mesh.geometry.boundingSphere) p.mesh.geometry.computeBoundingSphere();
    this.subjectSphere.copy(p.mesh.geometry.boundingSphere!).applyMatrix4(p.mesh.matrixWorld);
    return this.frustum.intersectsSphere(this.subjectSphere);
  }

  private updateHint() {
    const p = this.props;
    const beat = this.autoHop ? ' · H beat off' : ' · H hop on the beat';
    if (!this.physicsReady) this.hint = 'loading physics…';
    else if (this.exporting) this.hint = 'rendering the cut…';
    else if (this.inXr)
      this.hint = this.diorama
        ? 'diorama: B back to life-size'
        : 'left stick move · right stick snap / push to teleport · A jump · X grab / car · Y action · B diorama';
    else if (this.driving)
      this.hint =
        (this.studio?.state === 'recording' ? '● recording — Enter to cut · ' : '') +
        'WASD drive · Space hop · Shift brake (Shift+Space = all four) · I/K front/back · J/L sides · E get out' +
        beat;
    else if (p?.grabbed && this.holdingSprayCan())
      this.hint =
        this.rig.mode === 'actor' ? 'hold click = spray the wall · Z undo · E drop · F throw' : 'click = spray · Z undo · E drop · F throw';
    else if (p?.grabbed) this.hint = 'E drop · F / click throw';
    else if (p?.selected) this.hint = 'click the ground = put it there · Esc cancel · Z undo';
    else if (this.studio?.state === 'recording')
      this.hint = `● recording ${this.identity.name}${this.studio.ghostsVisible ? ` with ${this.studio.ghostsVisible} replay${this.studio.ghostsVisible > 1 ? 's' : ''}` : ''} — Enter to cut`;
    else if (this.studio?.state === 'verdict' && this.studio.set.size > 0)
      this.hint = `P replay the set (${this.studio.set.size} take${this.studio.set.size > 1 ? 's' : ''}) · V near an NPC = play their part next take · Enter = take ${this.studio.takesUsed + 1}`;
    else if (this.studio?.state === 'briefed')
      this.hint =
        this.studio.mission.id === 'm02-hop-on-the-one'
          ? 'Enter = action · get in the lowrider (E) · hop (Space) on the beat · keep the car in frame' + beat
          : 'Enter = action · get low (drag the camera down) · keep the crate in frame · T for golden hour';
    else if (this.vehicleDistance() < ENTER_DISTANCE) this.hint = 'E = get in the lowrider' + beat;
    else if (this.npcNearby())
      this.hint = `V = be ${this.npcNearby()!.spec.name}${this.identity.id !== PLAYER_IDENTITY.id ? ` (you are ${this.identity.name})` : ''}`;
    else if (this.rig.mode === 'actor')
      this.hint =
        'click to lock the mouse · WASD · Space jump · Shift sprint · E grab / get in the car · click a prop then the ground = put that there';
    else if (this.rig.mode === 'director')
      this.hint =
        (this.followId ? `following ${this.followId} · ` : '') +
        'drag to orbit · wheel zoom · WASD move · E grab / get in the car · click a prop then the ground = put that there · / type or hold ` and say "camera low, follow the car"';
    else this.hint = 'overhead: drag to orbit · wheel zoom · click a prop, then click where it goes · / say "put that there"';
  }

  /** "cells valley + street (loading) · → street 12 m" once the level has more than one cell (W-3). */
  private streamingHud(): string {
    const s = this.streamer;
    if (!s || this.levelDef.level.cells.length < 2) return '';
    const resident = [...this.cells.values()].map((c) =>
      c.id === this.currentSceneId ? `<b>${c.id}</b>` : c.ground ? c.id : `${c.id} (loading)`,
    );
    const feet = this.character ? this.character.feet(this.tmpV2) : null;
    const near = feet ? s.nearest(feet) : null;
    return ` · cells ${resident.join(' + ')}` + (near ? ` · → ${near.portal.to} ${near.distance.toFixed(0)} m` : '');
  }

  private renderHud() {
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const fps = this.frameTimes.length ? 1000 / (this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length) : 0;
    const title = this.usingFallback ? 'offline → local butterfly' : this.sceneDef.title;
    const label = this.cellId ? `cell ${this.cellId}` : title;
    if (!this.hint || (!this.driving && this.studio?.state !== 'recording')) this.updateHint(); // proximity hints change as you walk
    this.opts.hud.innerHTML =
      `<b>$COAST</b> M3 playground · <b>${label}</b>${this.loading ? ' · loading…' : ''}<br>` +
      `tier <b>${this.opts.platform.tier}</b> · xr:${this.opts.platform.webxr} · ${fps.toFixed(0)} fps · p95 ${p95.toFixed(1)} ms (target ${this.budgets.frameBudgetMs}) · ` +
      `splats ${(this.spark.display?.numSplats ?? 0).toLocaleString()} / ${this.budgets.lodSplatCount.toLocaleString()}` +
      (this.physicsReady && !this.driving ? ` · physics ${this.character?.grounded ? 'grounded' : 'air'}` : '') +
      (this.driving && this.vehicle
        ? ` · lowrider ${Math.round(Math.abs(this.vehicle.speed) * 3.6)} km/h · ${this.vehicle.wheelsOnGround}/4 wheels down`
        : '') +
      (this.autoHop ? ` · beat ● ${this.beat.phase(performance.now()).bar + 1}.${this.beat.phase(performance.now()).beatInBar + 1}` : '') +
      this.streamingHud() +
      `<br>mode <b>${this.rig.mode}</b> (Tab) · time <b>${this.timePreset}</b> (T) · look <b>${this.lookName}</b>${this.post ? '' : ' (export)'} · / direct · scenes 1–4 · C collider · R reset · M ${this.sfx.isMuted ? 'unmute' : 'mute'}<br><span style="opacity:.8">${this.hint}</span>`;
  }
}
