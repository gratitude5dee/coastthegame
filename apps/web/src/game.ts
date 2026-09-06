/**
 * Game orchestrator (M3 actor mode on sample worlds — goal.md ACT-1, PHY-1/2, CAM-1/2, INP-1/2, DIR-3 fallback).
 * Owns the scene, Spark, the cell/scene loader, physics, the possessed character, props, the camera rig and the HUD.
 * Input arrives only as FrameInput from providers (PLT-2). Simulation is fixed 60 Hz with render interpolation (STU-1).
 */
import * as THREE from 'three';
import { SparkRenderer, SplatMesh, SplatFileType } from '@sparkjsdev/spark';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  CameraRig,
  CharacterController,
  PhysicsWorld,
  PropSystem,
  budgetsFor,
  groundFromSplats,
  groundHeightAt,
  loadRapier,
  type Cell,
  type GroundGrid,
  type PlatformInfo,
  type RigMode,
} from '@coast/engine';
import { newFrameInput, resetFrameInput, type FrameInput, type InputProvider } from './input/intents';
import { KeyboardMouseProvider } from './input/keyboardMouse';
import { TouchProvider } from './input/touch';
import { GamepadProvider } from './input/gamepad';
import { initPerf } from './perf';

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
  private hint = '';

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
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.1, 6, 16), new THREE.MeshStandardMaterial({ color: 0xffb54a, roughness: 0.6 }));
    body.position.y = 0.9;
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.3), new THREE.MeshStandardMaterial({ color: 0x0b0a10 }));
    nose.position.set(0, 1.45, -0.4);
    this.playerMesh.add(body, nose);
    this.playerMesh.visible = false;
    this.scene.add(this.playerMesh);

    const camParam = params.get('cam') ?? 'director';
    this.rig = new CameraRig((['actor', 'director', 'producer'] as RigMode[]).includes(camParam as RigMode) ? (camParam as RigMode) : 'director');
    this.camera.fov = this.rig.params.fovDeg;
    this.camera.updateProjectionMatrix();

    this.kbm = new KeyboardMouseProvider(this.renderer.domElement);
    this.providers = [this.kbm, new TouchProvider(this.renderer.domElement), new GamepadProvider()];
    this.kbm.setPointerLockDesired(this.rig.mode === 'actor');

    this.crosshair = document.createElement('div');
    this.crosshair.style.cssText =
      'position:fixed;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:#ffb54a;box-shadow:0 0 0 1px #0008;pointer-events:none;display:none';
    document.body.appendChild(this.crosshair);

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
    window.__coastPhysics = false;
    window.__coastSteps = 0;
  }

  private beginLoad(title: string) {
    this.loading = title;
    window.__coastReady = false;
    window.__coastLod = false;
  }

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
    this.beginLoad(def.title);
    const mesh = new SplatMesh({
      url: def.url,
      ...(def.fileType ? { fileType: def.fileType } : {}), // never pass fileType: undefined (breaks auto-detect)
      lod: true,
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
    this.beginLoad(def.title);
    const e = cell.transform.rotationEuler;
    const mesh = new SplatMesh({ url: def.url, lod: true, onLoad: () => this.onWorldLoaded(def, cell) });
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
    if (!this.isShot && (def.world || this.forcePhysics)) void this.initPhysics(def, cell);
  }

  // ── Physics / character / props ────────────────────────────────────────────────────────────────────────────

  private async initPhysics(def: SceneDef, cell?: Cell) {
    const gen = ++this.physicsGen;
    const R = await loadRapier();
    if (gen !== this.physicsGen || !this.splat) return; // scene changed while loading
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
      this.ground = groundFromSplats(this.splat, { center: spawnXZ, halfExtent: 24, cellSize: 0.75 });
      const { geometry } = physics.addGroundGrid(this.ground);
      this.groundMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x3fd0ff, wireframe: true, transparent: true, opacity: 0.35 }));
      this.groundMesh.visible = this.debug;
      this.scene.add(this.groundMesh);
    }

    const spawnY = this.ground ? groundHeightAt(this.ground, spawnXZ.x, spawnXZ.z) : spawnXZ.y;
    const feet = new THREE.Vector3(spawnXZ.x, spawnY + 0.3, spawnXZ.z);
    this.character = new CharacterController(physics, { start: feet, yaw: this.rig.yaw });

    // A few props to grab, throw and "put there" (PHY-2). GLB props arrive with M4.
    const props = new PropSystem(physics, this.scene);
    this.props = props;
    const f = this.rig.forwardXZ(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    const at = (fwd: number, side: number, h: number) => feet.clone().addScaledVector(f, fwd).addScaledVector(right, side).add(new THREE.Vector3(0, h + 0.6, 0));
    props.spawn({ id: props.nextId('crate'), shape: 'box', size: [0.35, 0.35, 0.35], color: 0xd9743a, mass: 3 }, at(2.5, -1.2, this.groundDelta(feet, f, 2.5, right, -1.2)));
    props.spawn({ id: props.nextId('crate'), shape: 'box', size: [0.25, 0.25, 0.25], color: 0x4fa3d9, mass: 2 }, at(3.2, 0.6, this.groundDelta(feet, f, 3.2, right, 0.6)));
    props.spawn({ id: props.nextId('can'), shape: 'cylinder', size: [0.12, 0.2], color: 0xff3fa4, mass: 0.6 }, at(2.0, 1.4, this.groundDelta(feet, f, 2.0, right, 1.4)));
    props.spawn({ id: props.nextId('ball'), shape: 'ball', size: [0.3], color: 0x9be34a, mass: 1.5 }, at(4.5, -0.3, this.groundDelta(feet, f, 4.5, right, -0.3)));

    this.physicsReady = true;
    window.__coastPhysics = true;
    this.updateHint();
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

    if (this.isShot) {
      if (this.splat) this.splat.rotation.y = this.freezeT * 0.5; // deterministic pose for screenshots
    } else {
      this.pollInput(dt);
      this.handleEdges();
      this.simulate(dt);
      this.updateCamera(dt);
      this.updatePointer();
    }

    this.renderer.render(this.scene, this.camera);
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
    if (i.resetEdge) {
      this.placeCamera(this.sceneDef);
      if (this.character) {
        const s = this.sceneDef.spawn ?? [0, 0, 0];
        const y = this.ground ? groundHeightAt(this.ground, s[0], s[2]) : s[1];
        this.character.teleport(new THREE.Vector3(s[0], y + 0.3, s[2]));
      }
    }
    if (i.undo) this.props?.undo();
    if (i.cancel) this.props?.select(null);

    const props = this.props;
    if (!props || !this.character) return;

    // Grab / throw (PHY-2)
    if (i.interact) {
      if (props.grabbed) props.release(null);
      else {
        const near = this.nearestProp(2.6);
        if (near) props.grab(near);
      }
    }
    if (i.throwEdge && props.grabbed) {
      const v = this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(9).add(new THREE.Vector3(0, 3, 0));
      props.release(v);
    }

    // Put that there — click/tap fallback (DIR-3): click a prop to select, click the ground to place.
    if (i.select) {
      const ray = this.pointerRay();
      if (ray) {
        if (props.grabbed) {
          const v = this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(9).add(new THREE.Vector3(0, 3, 0));
          props.release(v);
        } else if (props.selected) {
          const hit = this.groundHit(ray);
          if (hit) props.placeSelectedAt(hit);
          else props.select(props.pick(ray));
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
    // Local move → world move relative to the camera yaw.
    const yaw = this.rig.yaw;
    const mx = THREE.MathUtils.clamp(i.move.x, -1, 1);
    const my = THREE.MathUtils.clamp(i.move.y, -1, 1);
    this.tmpMove.set(mx * Math.cos(yaw) - my * Math.sin(yaw), -mx * Math.sin(yaw) - my * Math.cos(yaw));
    const charInput = { move: this.tmpMove, jump: i.jump, sprint: i.sprint };
    physics.step(dt, (fixedDt) => {
      this.props?.beforeStep();
      ch.step(fixedDt, charInput);
      charInput.jump = false; // edge consumed by the first sub-step
      if (this.props?.grabbed) this.props.updateGrabbed(this.holdPoint());
    });
    window.__coastSteps = physics.stepCount;
    if (this.rig.mode === 'actor') ch.yaw = this.rig.yaw;
    this.props?.sync(physics.alpha);
    // Fell through the world? Respawn on the ground.
    if (ch.feet(this.tmpV).y < -40) i.resetEdge = true;
  }

  private updateCamera(dt: number) {
    const ch = this.character;
    const feet = ch ? ch.feet(this.tmpV) : this.tmpV.set(...(this.sceneDef.spawn ?? [0, 0, 0]));
    const look = { yaw: this.input.look.x, pitch: this.input.look.y, zoom: this.input.zoom };
    if (ch) {
      this.rig.update(dt, this.camera, { feet, yaw: ch.yaw, eyeHeight: EYE_HEIGHT }, look);
      this.playerMesh.visible = this.rig.mode !== 'actor';
      this.playerMesh.position.copy(feet);
      this.playerMesh.rotation.y = ch.yaw;
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

  private holdPoint(): THREE.Vector3 {
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    if (this.rig.mode === 'actor') return this.camera.position.clone().addScaledVector(fwd, 1.5);
    const feet = this.character!.feet(new THREE.Vector3());
    const f = this.rig.forwardXZ(new THREE.Vector3());
    return feet.addScaledVector(f, 1.2).add(new THREE.Vector3(0, 1.0, 0));
  }

  private updateHint() {
    const p = this.props;
    if (!this.physicsReady) this.hint = 'loading physics…';
    else if (p?.grabbed) this.hint = 'E drop · F / click throw';
    else if (p?.selected) this.hint = 'click the ground = put it there · Esc cancel · Z undo';
    else if (this.rig.mode === 'actor') this.hint = 'click to lock the mouse · WASD · Space jump · Shift sprint · E grab · click a prop then the ground = put that there';
    else if (this.rig.mode === 'director') this.hint = 'drag to orbit · wheel zoom · WASD move · click a prop then the ground = put that there · E grab';
    else this.hint = 'overhead: drag to orbit · wheel zoom · click a prop, then click where it goes';
  }

  private renderHud() {
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const fps = this.frameTimes.length ? 1000 / (this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length) : 0;
    const title = this.usingFallback ? 'offline → local butterfly' : this.sceneDef.title;
    const label = this.cellId ? `cell ${this.cellId}` : title;
    if (!this.hint) this.updateHint();
    this.opts.hud.innerHTML =
      `<b>$COAST</b> M3 playground · <b>${label}</b>${this.loading ? ' · loading…' : ''}<br>` +
      `tier <b>${this.opts.platform.tier}</b> · xr:${this.opts.platform.webxr} · ${fps.toFixed(0)} fps · p95 ${p95.toFixed(1)} ms (target ${this.budgets.frameBudgetMs}) · ` +
      `splats ${(this.spark.display?.numSplats ?? 0).toLocaleString()} / ${this.budgets.lodSplatCount.toLocaleString()}` +
      (this.physicsReady ? ` · physics ${this.character?.grounded ? 'grounded' : 'air'}` : '') +
      `<br>mode <b>${this.rig.mode}</b> (Tab) · time <b>${this.timePreset}</b> (T) · scenes 1–4 · C collider · R reset<br><span style="opacity:.8">${this.hint}</span>`;
  }
}
