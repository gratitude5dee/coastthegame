/**
 * Game orchestrator (M3 actor mode on sample worlds — goal.md ACT-1, PHY-1/2/3, CAM-1/2, INP-1/2, DIR-3 fallback).
 * Owns the scene, Spark, the cell/scene loader, physics, the possessed character, the lowrider, props, the beat clock,
 * the camera rig and the HUD. Input arrives only as FrameInput from providers (PLT-2). Simulation is fixed 60 Hz with
 * render interpolation (STU-1).
 */
import * as THREE from 'three';
import { SparkRenderer, SparkXr, SplatMesh, SplatFileType } from '@sparkjsdev/spark';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
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
  liftFromAxes,
  loadRapier,
  snapTurnShift,
  tablePoint,
  yawOf,
  zeroVehicleInput,
  HOP_CORNERS,
  type Cell,
  type GroundGrid,
  type HopPattern,
  type PlatformInfo,
  type RigMode,
  type RigTarget,
  type PropSpec,
  type VehicleInput,
  DeixisBuffer,
  type DeixisSample,
} from '@coast/engine';
import { BeatClock, type MeterSample } from '@coast/studio';
import { newFrameInput, resetFrameInput, type FrameInput, type InputProvider } from './input/intents';
import { KeyboardMouseProvider } from './input/keyboardMouse';
import { TouchProvider } from './input/touch';
import { GamepadProvider } from './input/gamepad';
import { XrControllerProvider } from './input/xrControllers';
import { initPerf } from './perf';
import { StudioSession } from './studio/session';
import { Metronome } from './audio/metronome';
import { Sfx } from './audio/sfx';
import { NpcSystem, type Npc, type NpcSpec } from './npc/npcs';
import { GhostActor } from './studio/ghosts';
import type { CameraRequest, SceneOps, UtteranceOutcome } from '@coast/director';
import { DirectorConsole, summarize } from './director/console';
import { createSubtitles, type Subtitles } from './ui/subtitles';
import { createLoadingScreen, type LoadingScreen } from './ui/loading';

export interface SceneDef {
  title: string;
  url: string;
  fileType?: SplatFileType;
  position: [number, number, number];
  scale: number;
  camera: { pos: [number, number, number]; lookAt: [number, number, number] };
  world: boolean; // walkable world vs. object on a table
  spawn?: [number, number, number];
}

export const LOCAL_BUTTERFLY: SceneDef = {
  title: 'Butterfly (local sample)',
  url: '/samples/butterfly.spz',
  position: [0, 0, -3],
  scale: 1,
  camera: { pos: [0, 0.2, 0.5], lookAt: [0, 0, -3] },
  world: false,
};

// Spark sample assets are stored Y-down: rotate 180° about X — rotate, never mirror (W-2).
export const SCENES: Record<string, SceneDef> = {
  valley: {
    title: 'Valley (Spark sample world)',
    url: 'https://sparkjs.dev/assets/splats/valley.spz',
    position: [0, 0, 0],
    scale: 0.5,
    camera: { pos: [0, 2.2, -0.5], lookAt: [0, 1.6, -8] },
    world: true,
    spawn: [0, 0, -1],
  },
  street: {
    title: 'Snow street (Spark sample world)',
    url: 'https://sparkjs.dev/assets/splats/snow-street.spz',
    position: [0, 0, 0],
    scale: 1,
    camera: { pos: [0, 1.6, 2], lookAt: [0, 1.4, -5] },
    world: true,
    spawn: [0, 0, 1],
  },
  sutro: {
    title: 'Sutro Tower, SF (SOGS)',
    url: 'https://sparkjs.dev/assets/splats/sutro.zip',
    fileType: SplatFileType.PCSOGSZIP,
    position: [0, 0, 0],
    scale: 1,
    camera: { pos: [0, 1.5, 4], lookAt: [0, 1.5, 0] },
    world: true,
    spawn: [0, 0, 3],
  },
  butterfly: LOCAL_BUTTERFLY,
};
export const SCENE_ORDER = ['valley', 'street', 'sutro', 'butterfly'] as const;

const TIME_PRESETS = {
  noon: new THREE.Color(1, 1, 1),
  golden: new THREE.Color(1.1, 0.94, 0.8),
  blue: new THREE.Color(0.8, 0.9, 1.12),
  night: new THREE.Color(0.5, 0.56, 0.82),
} as const;
type TimePreset = keyof typeof TIME_PRESETS;
const TIME_ORDER: TimePreset[] = ['noon', 'golden', 'blue', 'night'];
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
    };
    __coastSay?: (text: string) => UtteranceOutcome;
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

  private splat: SplatMesh | null = null;
  private sceneDef: SceneDef = LOCAL_BUTTERFLY;
  private currentSceneId = 'valley';
  private cellId: string | null = null;
  private loading = '';
  private usingFallback = false;
  private timePreset: TimePreset = 'noon';

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
  private readonly stride = new StrideTracker();
  private autoHop = false;
  private pendingBeat: { event: NonNullable<MeterSample['beatEvent']>; phaseMs: number } | null = null;
  private verdictAt = 0;
  private ground: GroundGrid | null = null;
  private groundMesh: THREE.Mesh | null = null; // invisible raycast target + optional debug wireframe
  private colliderMeshes: THREE.Object3D[] = [];
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
  private typing = false;
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

    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 2000);
    this.sfx = new Sfx(this.camera, { muted: params.get('mute') === '1' || this.isShot });
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

    // Lights for meshes (splats are unlit); env map from the cell pano lands with M2 (W-5).
    this.scene.add(new THREE.HemisphereLight(0xfff1dc, 0x24303f, 1.1));
    const sun = new THREE.DirectionalLight(0xffe2b8, 1.4);
    sun.position.set(6, 12, 4);
    this.scene.add(sun);

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
      this.director = new DirectorConsole(document.body, this.sceneOps(), this.deixis, {
        mode: () => this.rig.mode,
        forward: () => {
          const f = this.camera.getWorldDirection(this.tmpV);
          return [f.x, f.z];
        },
        onOutcome: (text, outcome) => {
          this.subtitles ??= createSubtitles(document.body);
          this.subtitles.say('Director', summarize(outcome), 4500);
          this.syncDirectorHook(text, outcome);
          this.updateHint();
        },
        onFocus: (typing) => {
          this.typing = typing;
          this.kbm.releaseAll();
        },
      });
      window.__coastSay = (text) => this.director!.say(text);
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

  /** Boot: pick the scene/cell from params and start the loop. */
  async start() {
    const p = this.opts.params;
    const cell = p.get('cell');
    if (cell) await this.loadCell(cell);
    else {
      const sceneId = p.get('scene') ?? (this.isShot ? 'butterfly' : 'valley');
      await this.loadScene(sceneId in SCENES ? sceneId : 'valley');
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
    if (this.splat) {
      this.world.remove(this.splat);
      this.splat.dispose();
      this.splat = null;
    }
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
    if (this.groundMesh) {
      this.world.remove(this.groundMesh);
      this.groundMesh.geometry.dispose();
      this.groundMesh = null;
    }
    for (const m of this.colliderMeshes) this.world.remove(m);
    this.colliderMeshes = [];
    this.ground = null;
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
    if (this.identity !== PLAYER_IDENTITY) this.setIdentity(PLAYER_IDENTITY);
    this.looks.clear();
    this.followId = null;
    this.director?.close();
    this.deixis.clear();
    window.__coastPhysics = false;
    window.__coastSteps = 0;
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

  async loadScene(id: string) {
    let def = SCENES[id] ?? LOCAL_BUTTERFLY;
    this.usingFallback = false;
    if (!(await this.reachable(def.url))) {
      def = LOCAL_BUTTERFLY;
      this.usingFallback = true;
    }
    this.clearWorld();
    this.cellId = null;
    this.currentSceneId = id;
    this.sceneDef = def;
    this.beginLoad(def.title, !this.isShot && (def.world || this.forcePhysics));
    const mesh = new SplatMesh({
      url: def.url,
      ...(def.fileType ? { fileType: def.fileType } : {}), // never pass fileType: undefined (breaks auto-detect)
      lod: true,
      onProgress: this.onFetchProgress,
      onLoad: () => this.onWorldLoaded(def),
    });
    mesh.quaternion.set(1, 0, 0, 0);
    mesh.position.set(...def.position);
    mesh.scale.setScalar(def.scale);
    mesh.recolor.copy(TIME_PRESETS[this.timePreset]);
    this.world.add(mesh);
    this.splat = mesh;
    this.placeCamera(def);
    this.perf.setCell(id);
  }

  /** Marble cell (goal.md W-2): /cells/<id>/cell.json with spz + collider GLB + pano. */
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
    };
    this.sceneDef = def;
    this.beginLoad(def.title, !this.isShot);
    const e = cell.transform.rotationEuler;
    const mesh = new SplatMesh({ url: def.url, lod: true, onProgress: this.onFetchProgress, onLoad: () => this.onWorldLoaded(def, cell) });
    mesh.rotation.set(THREE.MathUtils.degToRad(e[0]), THREE.MathUtils.degToRad(e[1]), THREE.MathUtils.degToRad(e[2]));
    mesh.position.set(...def.position);
    mesh.scale.setScalar(def.scale);
    mesh.recolor.copy(TIME_PRESETS[this.timePreset]);
    this.world.add(mesh);
    this.splat = mesh;
    this.placeCamera(def);
    this.perf.setCell(id);
  }

  private placeCamera(def: SceneDef) {
    this.camera.position.set(...def.camera.pos);
    this.camera.lookAt(...def.camera.lookAt);
    // Seed the rig yaw from the look direction so the first frames don't snap.
    const d = new THREE.Vector3(...def.camera.lookAt).sub(new THREE.Vector3(...def.camera.pos));
    this.rig.yaw = Math.atan2(-d.x, -d.z);
    this.rig.pitch = 0;
  }

  private onWorldLoaded(def: SceneDef, cell?: Cell) {
    this.loading = '';
    if (!performance.getEntriesByName('coast:interactive').length) performance.mark('coast:interactive'); // QB-3
    window.__coastReady = true;
    this.loadingScreen?.progress('fetch', 1);
    this.painter = new SplatPainter(this.world, { maxSdfs: this.budgets.maxPaintSdfs });
    window.__coastPaint = { count: 0, strokes: 0 };
    if (!this.isShot && (def.world || this.forcePhysics)) void this.initPhysics(def, cell);
  }

  // ── Physics / character / props ────────────────────────────────────────────────────────────────────────────

  private async initPhysics(def: SceneDef, cell?: Cell) {
    const gen = ++this.physicsGen;
    const R = await loadRapier();
    if (gen !== this.physicsGen || !this.splat) return; // scene changed while loading
    this.loadingScreen?.progress('physics', 0.35);
    const physics = new PhysicsWorld(R);
    this.physics = physics;

    let colliderLoaded = false;
    if (cell?.assets.collider) {
      try {
        const gltf = await new GLTFLoader().loadAsync(cell.assets.collider);
        if (gen !== this.physicsGen) return;
        gltf.scene.rotation.copy(this.splat.rotation);
        gltf.scene.position.copy(this.splat.position);
        gltf.scene.scale.copy(this.splat.scale);
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            const m = o as THREE.Mesh;
            physics.addStaticTrimesh(m.geometry, m.matrixWorld);
            m.visible = false;
          }
        });
        this.world.add(gltf.scene);
        this.colliderMeshes.push(gltf.scene);
        colliderLoaded = true;
      } catch (e) {
        console.warn('collider GLB failed, deriving ground from splats', e);
      }
    }

    const spawnXZ = new THREE.Vector3(...(def.spawn ?? [0, 0, 0]));
    if (!colliderLoaded) {
      // Ground from the splats themselves (PHY-1 fallback). Centre the grid on the spawn.
      this.ground = groundFromSplats(this.splat, { center: spawnXZ, halfExtent: 40, cellSize: 0.75 });
      const { geometry } = physics.addGroundGrid(this.ground);
      physics.addFence(this.ground, 4); // the block ends where the scan ends — nobody drives off the world
      window.__coastGround = {
        minX: this.ground.minX,
        minZ: this.ground.minZ,
        cols: this.ground.cols,
        cellSize: this.ground.cellSize,
        coverage: this.ground.coverage,
        sampled: this.ground.sampled ?? 0,
      };
      this.groundMesh = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ color: 0x3fd0ff, wireframe: true, transparent: true, opacity: 0.35 }),
      );
      this.groundMesh.visible = this.debug;
      this.world.add(this.groundMesh);
    }

    this.loadingScreen?.progress('physics', 0.7);
    const spawnY = this.ground ? groundHeightAt(this.ground, spawnXZ.x, spawnXZ.z) : spawnXZ.y;
    const feet = new THREE.Vector3(spawnXZ.x, spawnY + 0.3, spawnXZ.z);
    this.character = new CharacterController(physics, { start: feet, yaw: this.rig.yaw });

    // A few props to grab, throw and "put there" (PHY-2). GLB props arrive with M4.
    const props = new PropSystem(physics, this.world);
    this.props = props;
    const f = this.rig.forwardXZ(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    const at = (fwd: number, side: number, h: number) =>
      feet
        .clone()
        .addScaledVector(f, fwd)
        .addScaledVector(right, side)
        .add(new THREE.Vector3(0, h + 0.6, 0));
    props.spawn(
      { id: props.nextId('crate'), shape: 'box', size: [0.35, 0.35, 0.35], color: 0xd9743a, mass: 3 },
      at(2.5, -1.2, this.groundDelta(feet, f, 2.5, right, -1.2)),
    );
    props.spawn(
      { id: props.nextId('crate'), shape: 'box', size: [0.25, 0.25, 0.25], color: 0x4fa3d9, mass: 2 },
      at(3.2, 0.6, this.groundDelta(feet, f, 3.2, right, 0.6)),
    );
    // Spray cans (W-4): grab one, then click / pull the trigger at the splats to tag them in the can's colour.
    props.spawn(
      { id: props.nextId('can'), shape: 'cylinder', size: [0.12, 0.2], color: 0xff3fa4, mass: 0.6, tags: ['spray'] },
      at(2.0, 1.4, this.groundDelta(feet, f, 2.0, right, 1.4)),
    );
    props.spawn(
      { id: props.nextId('can'), shape: 'cylinder', size: [0.12, 0.2], color: 0x3fd0ff, mass: 0.6, tags: ['spray'] },
      at(1.6, 1.9, this.groundDelta(feet, f, 1.6, right, 1.9)),
    );
    props.spawn(
      { id: props.nextId('ball'), shape: 'ball', size: [0.3], color: 0x9be34a, mass: 1.5 },
      at(4.5, -0.3, this.groundDelta(feet, f, 4.5, right, -0.3)),
    );

    const grabParam = this.opts.params.get('grab');
    if (grabParam) {
      const target = props.props.get(grabParam);
      if (target) props.grab(target); // QA: start holding a prop (e.g. grab=can_3 for the spray test)
    }

    // The lowrider idles nearby, facing the same way (PHY-3), parked on the flattest patch within a few metres so it
    // never spawns half inside a hillside (which launches it). It drops onto its suspension.
    const carPos = feet.clone().addScaledVector(f, 5).addScaledVector(right, -3.5);
    if (this.ground) {
      const spot = flattestSpot(this.ground, feet, 4, 9, 2.6, 2.6);
      carPos.copy(spot.position);
      carPos.y += 1.2;
    } else carPos.y = feet.y + 1.0;
    this.vehicle = new Lowrider(physics, { position: carPos, yaw: this.rig.yaw });
    this.vehicleSpawn = { pos: carPos.clone(), yaw: this.rig.yaw };
    this.world.add(this.vehicle.group);
    this.sfx.engineStart(this.vehicle.group); // idles by the door (no-op until audio unlocks; retried per frame)

    this.setupStudio(feet, f, right);

    // The beat grid starts with the world (the track player lands with AUD-2); `?beat=1` = hop on the beat from the start.
    this.beat.start(performance.now());
    if (this.opts.params.get('beat') === '1') this.autoHop = true;
    if (this.opts.params.get('vehicle') === '1') this.enterVehicle();

    this.physicsReady = true;
    window.__coastPhysics = true;
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
    if (this.ground) out.y = groundHeightAt(this.ground, out.x, out.z) + 0.3;
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
      const y = this.ground ? groundHeightAt(this.ground, s[0], s[2]) : s[1];
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

  /** The Photographer (tutor) + extras on a runtime navmesh, the billboard, and the studio session (goal.md §3.1 steps 2, 5). */
  private setupStudio(feet: THREE.Vector3, f: THREE.Vector3, right: THREE.Vector3) {
    const physics = this.physics!;
    this.subtitles ??= createSubtitles(document.body);
    const npcs = new NpcSystem(physics, this.world, this.ground, {
      onGreet: (npc, line) => {
        this.subtitles?.say(npc.spec.name, line);
        this.sfx.tick(npc.spec.id === 'photographer' ? 900 : 600);
        if (npc.spec.id === 'photographer' && this.studio?.state === 'idle') {
          this.studio.brief();
          this.updateHint();
        }
        this.syncNpcHook();
      },
    });
    this.npcs = npcs;
    const at = (fwd: number, side: number) => feet.clone().addScaledVector(f, fwd).addScaledVector(right, side);
    this.looks.set(PLAYER_IDENTITY.id, { color: PLAYER_IDENTITY.color, name: PLAYER_IDENTITY.name });
    npcs.spawn({
      id: 'photographer',
      name: 'Photographer',
      color: 0x4fa3d9,
      home: at(4, 1.6),
      approaches: true,
      speed: 1.5,
      lines: [
        'Say: camera low, follow me.',
        'Roll it — Enter is action. Get low, keep the crate in frame.',
        'Golden hour is on T. Sunset sells.',
      ],
    });
    npcs.spawn({ id: 'npc_a', name: 'Rico', color: 0xd9a03a, home: at(9, -5), lines: ['Yo $COAST!', 'Nice ride.'] });
    npcs.spawn({ id: 'npc_b', name: 'Mari', color: 0xb35cd9, home: at(-3, 6), lines: ['Tag that wall.', 'Hop it on the one.'] });
    npcs.spawn({ id: 'npc_c', name: 'Dee', color: 0x3ad98a, home: at(7, 7), lines: ['Low and slow.', 'That your cut on the billboard?'] });
    for (const n of npcs.npcs) this.looks.set(n.spec.id, { color: n.spec.color, name: n.spec.name });
    // Navmesh: the cell collider when there is one, else the splat-derived ground grid (bounded to the scan coverage).
    const walkable: THREE.Mesh[] = [];
    for (const m of this.colliderMeshes) m.traverse((o) => ((o as THREE.Mesh).isMesh ? walkable.push(o as THREE.Mesh) : null));
    if (!walkable.length && this.groundMesh) walkable.push(this.groundMesh);
    const c = this.ground?.coverage;
    const bounds: [[number, number, number], [number, number, number]] | undefined = c
      ? [
          [c.minX, -50, c.minZ],
          [c.maxX, 80, c.maxZ],
        ]
      : undefined;
    const gen = this.physicsGen;
    void npcs.buildNav(walkable, bounds).then(() => {
      if (gen === this.physicsGen) this.syncNpcHook();
    });
    this.syncNpcHook();

    // Billboard: "your cut plays here" until a take exists, then the recorded clip (VideoTexture).
    const bbPos = feet.clone().addScaledVector(f, 6.5).addScaledVector(right, -2.2);
    bbPos.y = (this.ground ? groundHeightAt(this.ground, bbPos.x, bbPos.z) : feet.y) + 1.9;
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
  private groundDelta(feet: THREE.Vector3, f: THREE.Vector3, fwd: number, right: THREE.Vector3, side: number): number {
    if (!this.ground) return 0;
    const p = feet.clone().addScaledVector(f, fwd).addScaledVector(right, side);
    return groundHeightAt(this.ground, p.x, p.z) - feet.y + 0.3;
  }

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

    this.renderer.render(this.scene, this.camera);
    this.studio?.frameRendered();
    this.perf.tick(dtMs);
    if (this.frame++ % 10 === 0) this.renderHud();
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
      this.splat?.recolor.copy(TIME_PRESETS[this.timePreset]);
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
      if (this.groundMesh) this.groundMesh.visible = this.debug;
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
    if (i.muteToggle) {
      this.sfx.toggleMuted();
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
    }
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
        const minY = groundHeightAt(this.ground, this.camera.position.x, this.camera.position.z) + 0.25;
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
        const minY = groundHeightAt(this.ground, this.camera.position.x, this.camera.position.z) + 0.25;
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
    if (this.groundMesh) targets.push(this.groundMesh);
    for (const m of this.colliderMeshes) targets.push(m);
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
    this.splat.raycast(this.raycaster, hits);
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
    const npcDist = photographer ? feet.distanceTo(photographer.mesh.position) : Infinity;
    if (studio.state === 'idle' && npcDist < 2.6) {
      studio.brief();
      this.updateHint();
    } else if (studio.state === 'verdict') {
      // Walking off after reading the verdict banks the stars and queues the next mission (talk to the tutor again).
      if (this.verdictAt === 0) this.verdictAt = performance.now();
      else if (npcDist > LEAVE_DISTANCE && performance.now() - this.verdictAt > VERDICT_GRACE_MS) {
        studio.leave();
        this.verdictAt = 0;
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
          if (this.ground) p.y = Math.max(p.y, groundHeightAt(this.ground, p.x, p.z));
          props.select(prop);
          props.placeSelectedAt(p);
          this.studio?.edit(now(), { kind: 'propPlace', propId: id, pos: [p.x, p.y, p.z] });
          this.sfx.tick(900);
          return true;
        }
        if (id === 'lowrider' && this.vehicle && !this.driving) {
          const p = new THREE.Vector3(pos[0], pos[1], pos[2]);
          if (this.ground) p.y = groundHeightAt(this.ground, p.x, p.z);
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
        const base = this.ground ? groundHeightAt(this.ground, t.x, t.z) : t.y - 0.5;
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
        if (this.ground) p.y = groundHeightAt(this.ground, p.x, p.z);
        p.y += (spec.size[1] ?? spec.size[0] ?? 0.3) + 0.3;
        props.spawn(spec, p);
        this.sfx.tick(1100);
        return spec.id;
      },
      setTime: (preset) => {
        const map: Record<string, TimePreset> = { golden: 'golden', blue: 'blue', night: 'night', fog_noon: 'noon' };
        const t = map[preset];
        if (!t) return false;
        this.timePreset = t;
        this.splat?.recolor.copy(TIME_PRESETS[t]);
        return true;
      },
      setWeather: () => false, // fog volumes / rain land with the Marble cells (M2, W-5)
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
    const camH = this.ground ? camPos.y - groundHeightAt(this.ground, camPos.x, camPos.z) : camPos.y - feet.y;
    const subject = this.studio?.subjectId ?? 'crate_1';
    return {
      nowMs: performance.now(),
      feet,
      yaw: car ? car.yaw : ch.yaw,
      speed: car ? Math.abs(car.speed) : ch.speed,
      grounded: car ? car.wheelsOnGround >= 2 : ch.grounded,
      driving: !!car,
      camera: this.camera,
      cameraHeightM: camH,
      subjectInFrame: this.subjectInFrame(subject),
      timePreset: this.timePreset,
      cell: this.cellId ?? this.currentSceneId,
      ...(this.pendingBeat ? { beatEvent: this.pendingBeat.event, beatPhaseMs: this.pendingBeat.phaseMs } : {}),
    };
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
        'drag to orbit · wheel zoom · WASD move · E grab / get in the car · click a prop then the ground = put that there · / say "camera low, follow the car"';
    else this.hint = 'overhead: drag to orbit · wheel zoom · click a prop, then click where it goes · / say "put that there"';
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
      `<br>mode <b>${this.rig.mode}</b> (Tab) · time <b>${this.timePreset}</b> (T) · / direct · scenes 1–4 · C collider · R reset · M ${this.sfx.isMuted ? 'unmute' : 'mute'}<br><span style="opacity:.8">${this.hint}</span>`;
  }
}
