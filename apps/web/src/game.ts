/**
 * Game orchestrator (M3 actor mode on sample worlds — goal.md ACT-1, PHY-1/2/3, CAM-1/2, INP-1/2, DIR-3 fallback).
 * Owns the scene, Spark, the cell/scene loader, physics, the possessed character, the lowrider, props, the beat clock,
 * the camera rig and the HUD. Input arrives only as FrameInput from providers (PLT-2). Simulation is fixed 60 Hz with
 * render interpolation (STU-1).
 */
import * as THREE from 'three';
import { SparkRenderer, SplatMesh, SplatFileType } from '@sparkjsdev/spark';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  CameraRig,
  CharacterController,
  Lowrider,
  PhysicsWorld,
  PropSystem,
  budgetsFor,
  groundFromSplats,
  groundHeightAt,
  liftFromAxes,
  loadRapier,
  zeroVehicleInput,
  type Cell,
  type GroundGrid,
  type HopPattern,
  type PlatformInfo,
  type RigMode,
  type VehicleInput,
} from '@coast/engine';
import { BeatClock, type MeterSample } from '@coast/studio';
import { newFrameInput, resetFrameInput, type FrameInput, type InputProvider } from './input/intents';
import { KeyboardMouseProvider } from './input/keyboardMouse';
import { TouchProvider } from './input/touch';
import { GamepadProvider } from './input/gamepad';
import { initPerf } from './perf';
import { StudioSession } from './studio/session';
import { Metronome } from './audio/metronome';
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
  }
}

export class Game {
  readonly scene = new THREE.Scene();
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
  private photographer: THREE.Group | null = null;
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
    this.scene.add(this.spark);
    performance.mark('coast:boot');

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
    this.scene.add(this.playerMesh);

    const camParam = params.get('cam') ?? 'director';
    this.rig = new CameraRig(
      (['actor', 'director', 'producer'] as RigMode[]).includes(camParam as RigMode) ? (camParam as RigMode) : 'director',
    );
    this.camera.fov = this.rig.params.fovDeg;
    this.camera.updateProjectionMatrix();

    this.kbm = new KeyboardMouseProvider(this.renderer.domElement);
    this.touch = new TouchProvider(this.renderer.domElement);
    this.providers = [this.kbm, this.touch, new GamepadProvider()];
    this.kbm.setPointerLockDesired(this.rig.mode === 'actor');

    this.crosshair = document.createElement('div');
    this.crosshair.style.cssText =
      'position:fixed;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:#ffb54a;box-shadow:0 0 0 1px #0008;pointer-events:none;display:none';
    document.body.appendChild(this.crosshair);

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
      this.scene.remove(this.splat);
      this.splat.dispose();
      this.splat = null;
    }
    this.physicsGen++;
    this.physicsReady = false;
    this.character = null;
    if (this.vehicle) {
      this.vehicle.dispose();
      this.vehicle = null;
    }
    this.vehicleSpawn = null;
    this.setDriving(false);
    this.autoHop = false;
    this.metronome.disable();
    this.beat.stop();
    if (this.props) {
      for (const id of [...this.props.props.keys()]) this.props.remove(id);
      this.scene.remove(this.props.group, this.props.ghost);
      this.props = null;
    }
    if (this.groundMesh) {
      this.scene.remove(this.groundMesh);
      this.groundMesh.geometry.dispose();
      this.groundMesh = null;
    }
    for (const m of this.colliderMeshes) this.scene.remove(m);
    this.colliderMeshes = [];
    this.ground = null;
    this.physics?.dispose();
    this.physics = null;
    this.playerMesh.visible = false;
    if (this.photographer) this.scene.remove(this.photographer);
    this.photographer = null;
    if (this.billboard) this.scene.remove(this.billboard);
    this.billboard = null;
    if (this.studio) {
      this.studio.card.hide();
      this.scene.remove(this.studio.ghost);
      this.studio = null;
    }
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
    this.scene.add(mesh);
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
    this.scene.add(mesh);
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
        this.scene.add(gltf.scene);
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
      physics.addFence(this.ground, 4); // the block ends where the ground grid ends — nobody drives off the world
      this.groundMesh = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ color: 0x3fd0ff, wireframe: true, transparent: true, opacity: 0.35 }),
      );
      this.groundMesh.visible = this.debug;
      this.scene.add(this.groundMesh);
    }

    this.loadingScreen?.progress('physics', 0.7);
    const spawnY = this.ground ? groundHeightAt(this.ground, spawnXZ.x, spawnXZ.z) : spawnXZ.y;
    const feet = new THREE.Vector3(spawnXZ.x, spawnY + 0.3, spawnXZ.z);
    this.character = new CharacterController(physics, { start: feet, yaw: this.rig.yaw });

    // A few props to grab, throw and "put there" (PHY-2). GLB props arrive with M4.
    const props = new PropSystem(physics, this.scene);
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
    props.spawn(
      { id: props.nextId('can'), shape: 'cylinder', size: [0.12, 0.2], color: 0xff3fa4, mass: 0.6 },
      at(2.0, 1.4, this.groundDelta(feet, f, 2.0, right, 1.4)),
    );
    props.spawn(
      { id: props.nextId('ball'), shape: 'ball', size: [0.3], color: 0x9be34a, mass: 1.5 },
      at(4.5, -0.3, this.groundDelta(feet, f, 4.5, right, -0.3)),
    );

    // The lowrider idles ahead and to the left, facing the same way (PHY-3). It drops onto its suspension.
    const carPos = feet.clone().addScaledVector(f, 5).addScaledVector(right, -3.5);
    carPos.y = (this.ground ? groundHeightAt(this.ground, carPos.x, carPos.z) : feet.y) + 1.0;
    this.vehicle = new Lowrider(physics, { position: carPos, yaw: this.rig.yaw });
    this.vehicleSpawn = { pos: carPos.clone(), yaw: this.rig.yaw };
    this.scene.add(this.vehicle.group);

    this.setupStudio(feet, f, right);

    // The beat grid starts with the world (the track player lands with AUD-2); `?beat=1` = hop on the beat from the start.
    this.beat.start(performance.now());
    if (this.opts.params.get('beat') === '1') this.autoHop = true;
    if (this.opts.params.get('vehicle') === '1') this.enterVehicle();

    this.physicsReady = true;
    window.__coastPhysics = true;
    this.loadingScreen?.progress('physics', 1);
    this.updateHint();
  }

  // ── Lowrider (PHY-3) ─────────────────────────────────────────────────────────────────────────────────────────

  private setDriving(v: boolean) {
    if (v === this.driving) return;
    this.driving = v;
    this.touch.setDriving(v);
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

  /** The Photographer (tutor NPC placeholder), the billboard, and the studio session (goal.md §3.1 steps 2, 5). */
  private setupStudio(feet: THREE.Vector3, f: THREE.Vector3, right: THREE.Vector3) {
    // Photographer: a blue capsule with a "camera" box, 4 m ahead and to the right.
    const npc = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.32, 1.0, 6, 16),
      new THREE.MeshStandardMaterial({ color: 0x4fa3d9, roughness: 0.6 }),
    );
    body.position.y = 0.85;
    const cam = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.12), new THREE.MeshStandardMaterial({ color: 0x0b0a10 }));
    cam.position.set(0.18, 1.35, -0.28);
    npc.add(body, cam);
    const npcPos = feet.clone().addScaledVector(f, 4).addScaledVector(right, 1.6);
    npcPos.y = this.ground ? groundHeightAt(this.ground, npcPos.x, npcPos.z) : feet.y;
    npc.position.copy(npcPos);
    npc.lookAt(feet.x, npcPos.y, feet.z);
    this.scene.add(npc);
    this.photographer = npc;

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
    this.scene.add(bb);
    this.billboard = bb;

    const missionParam = Number(this.opts.params.get('mission') ?? '0');
    const studio = new StudioSession(
      document.body,
      this.scene,
      this.playerMesh,
      this.renderer.domElement,
      this.cellId ?? this.currentSceneId,
      undefined,
      missionParam > 0 ? missionParam - 1 : 0,
    );
    studio.onClip = (url) => this.showClip(url);
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
      this.rig.cycle(RIG_ORDER);
      this.kbm.setPointerLockDesired(this.rig.mode === 'actor');
      this.props?.select(null);
      this.updateHint();
    }
    if (i.debugToggle) {
      this.debug = !this.debug;
      if (this.groundMesh) this.groundMesh.visible = this.debug;
      for (const m of this.colliderMeshes) m.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).visible = this.debug) : null));
    }
    if (i.resetEdge) this.respawn();
    if (i.undo) this.props?.undo();
    if (i.cancel) this.props?.select(null);
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
      }
    }

    // Studio: roll / cut / playback (goal.md §3.1 steps 4–5)
    if (this.studio) {
      if (i.action) {
        const r = this.studio.action(this.frameContext());
        if (r === 'ignored' && this.studio.state === 'idle') this.studio.card.setStatus('walk up to the photographer first');
        this.updateHint();
      }
      if (i.playback) this.studio.togglePlayback(performance.now());
    }

    // Grab / throw (PHY-2) — or get in the lowrider when it is the closer thing (never on the edge that just got out).
    if (i.interact && !wasDriving) {
      if (props.grabbed) {
        this.studio?.edit(performance.now(), { kind: 'propRelease', propId: props.grabbed.spec.id });
        props.release(null);
      } else {
        const near = this.nearestProp(2.6);
        const carDist = this.vehicleDistance();
        if (carDist < ENTER_DISTANCE && (!near || carDist < near.mesh.position.distanceTo(this.character.feet(this.tmpV)))) {
          this.enterVehicle();
        } else if (near) {
          props.grab(near);
          this.studio?.edit(performance.now(), { kind: 'propGrab', propId: near.spec.id });
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
    // Local move → world move relative to the camera yaw.
    const yaw = this.rig.yaw;
    const mx = THREE.MathUtils.clamp(i.move.x, -1, 1);
    const my = THREE.MathUtils.clamp(i.move.y, -1, 1);
    this.tmpMove.set(mx * Math.cos(yaw) - my * Math.sin(yaw), -mx * Math.sin(yaw) - my * Math.cos(yaw));
    const charInput = { move: this.tmpMove, jump: i.jump && !driving, sprint: i.sprint };

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
      }
    }

    physics.step(dt, (fixedDt) => {
      this.props?.beforeStep();
      this.vehicle?.beforeStep();
      this.vehicle?.step(fixedDt, vi);
      vi.hop = null; // edge consumed by the first sub-step
      if (!driving) ch.step(fixedDt, charInput);
      charInput.jump = false;
      if (this.props?.grabbed) this.props.updateGrabbed(this.holdPoint());
    });
    window.__coastSteps = physics.stepCount;
    if (this.rig.mode === 'actor' && !driving) ch.yaw = this.rig.yaw;
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
      this.rig.update(dt, this.camera, { feet, yaw: ch.yaw, eyeHeight: EYE_HEIGHT }, look);
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

  /** Ghost preview while a prop is selected (DIR-3), following the pointer or the crosshair. */
  private updatePointer() {
    const props = this.props;
    if (!props?.selected) return;
    const ray = this.pointerRay();
    props.previewAt(ray ? this.groundHit(ray) : null);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────

  private pointerRay(): THREE.Ray | null {
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
    const npcDist = this.photographer ? feet.distanceTo(this.photographer.position) : Infinity;
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
    if (this.photographer) this.photographer.lookAt(feet.x, this.photographer.position.y, feet.z);
    studio.tick(this.frameContext());
  }

  private frameContext() {
    const ch = this.character!;
    const car = this.driving ? this.vehicle : null;
    const feet = car ? this.carFeet(new THREE.Vector3()).clone() : ch.feet(new THREE.Vector3());
    const camH = this.ground
      ? this.camera.position.y - groundHeightAt(this.ground, this.camera.position.x, this.camera.position.z)
      : this.camera.position.y - feet.y;
    const subject = this.studio?.subjectId ?? 'crate_1';
    return {
      nowMs: performance.now(),
      feet,
      yaw: car ? car.yaw : ch.yaw,
      speed: car ? Math.abs(car.speed) : ch.speed,
      grounded: car ? car.wheelsOnGround >= 2 : ch.grounded,
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
    else if (this.driving)
      this.hint =
        (this.studio?.state === 'recording' ? '● recording — Enter to cut · ' : '') +
        'WASD drive · Space hop · Shift brake (Shift+Space = all four) · I/K front/back · J/L sides · E get out' +
        beat;
    else if (p?.grabbed) this.hint = 'E drop · F / click throw';
    else if (p?.selected) this.hint = 'click the ground = put it there · Esc cancel · Z undo';
    else if (this.studio?.state === 'recording') this.hint = '● recording — Enter to cut';
    else if (this.studio?.state === 'briefed')
      this.hint =
        this.studio.mission.id === 'm02-hop-on-the-one'
          ? 'Enter = action · get in the lowrider (E) · hop (Space) on the beat · keep the car in frame' + beat
          : 'Enter = action · get low (drag the camera down) · keep the crate in frame · T for golden hour';
    else if (this.vehicleDistance() < ENTER_DISTANCE) this.hint = 'E = get in the lowrider' + beat;
    else if (this.rig.mode === 'actor')
      this.hint =
        'click to lock the mouse · WASD · Space jump · Shift sprint · E grab / get in the car · click a prop then the ground = put that there';
    else if (this.rig.mode === 'director')
      this.hint = 'drag to orbit · wheel zoom · WASD move · E grab / get in the car · click a prop then the ground = put that there';
    else this.hint = 'overhead: drag to orbit · wheel zoom · click a prop, then click where it goes';
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
      `<br>mode <b>${this.rig.mode}</b> (Tab) · time <b>${this.timePreset}</b> (T) · scenes 1–4 · C collider · R reset<br><span style="opacity:.8">${this.hint}</span>`;
  }
}
