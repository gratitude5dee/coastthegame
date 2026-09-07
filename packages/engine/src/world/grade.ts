/**
 * Time of day + weather as a grade (goal.md W-5, W-4 fog): the splats carry baked light, so a preset is a *look*, not
 * a light — a dyno colour modifier on every splat (tint · exposure, saturation, lift, and distance fog), a sky dome
 * shader (zenith / horizon / ground gradient, a sun, stars at night), matching three lights for the GLB props and
 * NPCs, and `scene.fog` with the same colour and density so meshes fade like splats. Presets tween into each other
 * so "golden hour" said out loud is a dissolve, not a cut. The post LUT (AF-7 `postprocessing`) is the next layer.
 */
import * as THREE from 'three';
import { dyno, type SplatMesh } from '@sparkjsdev/spark';
import type { GsplatModifier } from '@sparkjsdev/spark';

export type TimeOfDay = 'noon' | 'golden' | 'blue' | 'night' | 'fog_noon';
export type Weather = 'clear' | 'fog' | 'rain';

export const TIME_ORDER: TimeOfDay[] = ['noon', 'golden', 'blue', 'night', 'fog_noon'];

export interface Grade {
  label: string;
  /** Per-splat multiply (sRGB) — exposure folded in. */
  tint: [number, number, number];
  saturation: number;
  /** Added after the tint (a lift for the shadows, a colour cast). */
  lift: [number, number, number];
  sky: {
    zenith: number;
    horizon: number;
    ground: number;
    sunColor: number;
    sunElevationDeg: number;
    sunAzimuthDeg: number;
    /** Angular size of the disc, 0 hides the sun. */
    sunSize: number;
    sunGlow: number;
    stars: number;
  };
  sun: { color: number; intensity: number };
  hemi: { sky: number; ground: number; intensity: number };
  /** Base atmosphere of the preset; the weather adds to it. */
  fog: { color: number; density: number };
  /** Emissive boost for signage and the lowrider's lights (night-neon). */
  neon: number;
}

export const GRADES: Record<TimeOfDay, Grade> = {
  noon: {
    label: 'noon',
    tint: [1, 1, 1],
    saturation: 1,
    lift: [0, 0, 0],
    sky: {
      zenith: 0x4f86c6,
      horizon: 0xc9dbe8,
      ground: 0x6e7a86,
      sunColor: 0xfff4dc,
      sunElevationDeg: 62,
      sunAzimuthDeg: 200,
      sunSize: 0.8,
      sunGlow: 0.5,
      stars: 0,
    },
    sun: { color: 0xffe9c8, intensity: 1.6 },
    hemi: { sky: 0xdbe8f5, ground: 0x2e3540, intensity: 1.0 },
    fog: { color: 0xc9dbe8, density: 0.004 },
    neon: 0,
  },
  golden: {
    label: 'golden hour',
    tint: [1.12, 0.93, 0.76],
    saturation: 1.12,
    lift: [0.03, 0.01, 0],
    sky: {
      zenith: 0x3d5a8a,
      horizon: 0xf5a95a,
      ground: 0x4c3a38,
      sunColor: 0xffb060,
      sunElevationDeg: 7,
      sunAzimuthDeg: 250,
      sunSize: 1.4,
      sunGlow: 1.2,
      stars: 0,
    },
    sun: { color: 0xffb26a, intensity: 1.9 },
    hemi: { sky: 0xffcf9a, ground: 0x3a2c30, intensity: 0.8 },
    fog: { color: 0xf1b27a, density: 0.006 },
    neon: 0.2,
  },
  blue: {
    label: 'blue hour',
    tint: [0.78, 0.86, 1.08],
    saturation: 0.9,
    lift: [0.0, 0.02, 0.06],
    sky: {
      zenith: 0x0d1b3a,
      horizon: 0x6f7fb8,
      ground: 0x1c2233,
      sunColor: 0xffc7a0,
      sunElevationDeg: -4,
      sunAzimuthDeg: 255,
      sunSize: 0,
      sunGlow: 0.9,
      stars: 0.3,
    },
    sun: { color: 0x8fa6ff, intensity: 0.5 },
    hemi: { sky: 0x7d8fc7, ground: 0x151a26, intensity: 0.7 },
    fog: { color: 0x5f6f9e, density: 0.007 },
    neon: 0.7,
  },
  night: {
    label: 'night',
    tint: [0.5, 0.56, 0.82],
    saturation: 0.8,
    lift: [0.0, 0.0, 0.05],
    sky: {
      zenith: 0x05070f,
      horizon: 0x1a2140,
      ground: 0x0a0c14,
      sunColor: 0xcfd8ff,
      sunElevationDeg: 35,
      sunAzimuthDeg: 120,
      sunSize: 0.35,
      sunGlow: 0.25,
      stars: 1,
    },
    sun: { color: 0xa9b8ff, intensity: 0.35 },
    hemi: { sky: 0x2a3560, ground: 0x0b0d14, intensity: 0.55 },
    fog: { color: 0x141a30, density: 0.009 },
    neon: 1,
  },
  fog_noon: {
    label: 'fog noon',
    tint: [0.98, 0.99, 1.0],
    saturation: 0.72,
    lift: [0.06, 0.06, 0.06],
    sky: {
      zenith: 0xb8c2cc,
      horizon: 0xd9dee3,
      ground: 0x9aa2aa,
      sunColor: 0xfff8ec,
      sunElevationDeg: 55,
      sunAzimuthDeg: 200,
      sunSize: 2.5,
      sunGlow: 0.3,
      stars: 0,
    },
    sun: { color: 0xf3f1ea, intensity: 0.9 },
    hemi: { sky: 0xe4e8ec, ground: 0x7a828a, intensity: 1.1 },
    fog: { color: 0xd6dce2, density: 0.035 },
    neon: 0.1,
  },
};

/** Extra fog density the weather adds on top of the preset (`amount` 0..1). */
export function weatherFog(kind: Weather, amount = 0.6): number {
  const a = Math.min(1, Math.max(0, amount));
  if (kind === 'fog') return 0.02 + a * 0.06;
  if (kind === 'rain') return 0.008 + a * 0.02;
  return 0;
}

/** Sun direction (unit, world Y-up) from elevation / azimuth in degrees; azimuth 0 = +Z, 90 = +X. */
export function sunDirection(elevationDeg: number, azimuthDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  return out.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
}

/** A numeric snapshot of a grade (colours as linear Vector3-ish triples) that can be lerped. */
export interface GradeState {
  tint: THREE.Vector3;
  saturation: number;
  lift: THREE.Vector3;
  zenith: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
  sunColor: THREE.Color;
  sunDir: THREE.Vector3;
  sunSize: number;
  sunGlow: number;
  stars: number;
  sunLight: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  fogColor: THREE.Color;
  fogDensity: number;
  neon: number;
}

export function gradeState(g: Grade, extraFog = 0, out?: GradeState): GradeState {
  const s: GradeState = out ?? {
    tint: new THREE.Vector3(),
    saturation: 1,
    lift: new THREE.Vector3(),
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    ground: new THREE.Color(),
    sunColor: new THREE.Color(),
    sunDir: new THREE.Vector3(),
    sunSize: 0,
    sunGlow: 0,
    stars: 0,
    sunLight: new THREE.Color(),
    sunIntensity: 0,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 0,
    fogColor: new THREE.Color(),
    fogDensity: 0,
    neon: 0,
  };
  s.tint.set(g.tint[0], g.tint[1], g.tint[2]);
  s.saturation = g.saturation;
  s.lift.set(g.lift[0], g.lift[1], g.lift[2]);
  s.zenith.set(g.sky.zenith);
  s.horizon.set(g.sky.horizon);
  s.ground.set(g.sky.ground);
  s.sunColor.set(g.sky.sunColor);
  sunDirection(g.sky.sunElevationDeg, g.sky.sunAzimuthDeg, s.sunDir);
  s.sunSize = g.sky.sunSize;
  s.sunGlow = g.sky.sunGlow;
  s.stars = g.sky.stars;
  s.sunLight.set(g.sun.color);
  s.sunIntensity = g.sun.intensity;
  s.hemiSky.set(g.hemi.sky);
  s.hemiGround.set(g.hemi.ground);
  s.hemiIntensity = g.hemi.intensity;
  s.fogColor.set(g.fog.color);
  s.fogDensity = g.fog.density + extraFog;
  s.neon = g.neon;
  return s;
}

/** `out = out + (target − out) · t` for every field (colours in linear). */
export function lerpGradeState(out: GradeState, target: GradeState, t: number): GradeState {
  out.tint.lerp(target.tint, t);
  out.saturation += (target.saturation - out.saturation) * t;
  out.lift.lerp(target.lift, t);
  out.zenith.lerp(target.zenith, t);
  out.horizon.lerp(target.horizon, t);
  out.ground.lerp(target.ground, t);
  out.sunColor.lerp(target.sunColor, t);
  out.sunDir.lerp(target.sunDir, t).normalize();
  out.sunSize += (target.sunSize - out.sunSize) * t;
  out.sunGlow += (target.sunGlow - out.sunGlow) * t;
  out.stars += (target.stars - out.stars) * t;
  out.sunLight.lerp(target.sunLight, t);
  out.sunIntensity += (target.sunIntensity - out.sunIntensity) * t;
  out.hemiSky.lerp(target.hemiSky, t);
  out.hemiGround.lerp(target.hemiGround, t);
  out.hemiIntensity += (target.hemiIntensity - out.hemiIntensity) * t;
  out.fogColor.lerp(target.fogColor, t);
  out.fogDensity += (target.fogDensity - out.fogDensity) * t;
  out.neon += (target.neon - out.neon) * t;
  return out;
}

/**
 * The per-splat grade + fog as a Spark world modifier (one shared dyno, its uniforms driven from `GradeState`).
 * Fog is exp² in distance from the camera — the same curve three's `FogExp2` applies to the meshes.
 */
export class SplatGrade {
  readonly modifier: GsplatModifier;
  private readonly tint = new dyno.DynoVec3({ value: new THREE.Vector3(1, 1, 1) });
  private readonly saturation = new dyno.DynoFloat({ value: 1 });
  private readonly lift = new dyno.DynoVec3({ value: new THREE.Vector3() });
  private readonly fogColor = new dyno.DynoVec3({ value: new THREE.Vector3(0.8, 0.85, 0.9) });
  private readonly fogDensity = new dyno.DynoFloat({ value: 0 });
  private readonly camPos = new dyno.DynoVec3({ value: new THREE.Vector3() });

  constructor() {
    const { tint, saturation, lift, fogColor, fogDensity, camPos } = this;
    this.modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
      if (!gsplat) throw new Error('grade modifier needs a gsplat input');
      const graded = dyno.dyno({
        inTypes: {
          gsplat: dyno.Gsplat,
          tint: 'vec3',
          saturation: 'float',
          lift: 'vec3',
          fogColor: 'vec3',
          fogDensity: 'float',
          camPos: 'vec3',
        },
        outTypes: { gsplat: dyno.Gsplat },
        inputs: { gsplat, tint, saturation, lift, fogColor, fogDensity, camPos },
        statements: ({ inputs, outputs }) => [
          `${outputs.gsplat} = ${inputs.gsplat};`,
          `{`,
          `  vec3 rgb = ${inputs.gsplat}.rgba.rgb * ${inputs.tint};`,
          `  float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));`,
          `  rgb = mix(vec3(lum), rgb, ${inputs.saturation}) + ${inputs.lift};`,
          `  float d = length(${inputs.gsplat}.center - ${inputs.camPos}) * ${inputs.fogDensity};`,
          `  rgb = mix(rgb, ${inputs.fogColor}, 1.0 - exp(-d * d));`,
          `  ${outputs.gsplat}.rgba.rgb = clamp(rgb, 0.0, 1.0);`,
          `}`,
        ],
      });
      return { gsplat: graded.outputs.gsplat };
    });
  }

  /** Put the grade on a splat mesh (once per mesh; the uniforms are shared). */
  apply(mesh: SplatMesh) {
    mesh.worldModifier = this.modifier;
    mesh.updateGenerator();
  }

  set(s: GradeState) {
    this.tint.value.copy(s.tint);
    this.saturation.value = s.saturation;
    this.lift.value.copy(s.lift);
    // The splats are graded in sRGB-ish display space; three keeps colours linear — hand the fog over as sRGB.
    this.fogColor.value.set(...srgb(s.fogColor));
    this.fogDensity.value = s.fogDensity;
  }

  setCamera(pos: THREE.Vector3) {
    this.camPos.value.copy(pos);
  }
}

function srgb(c: THREE.Color): [number, number, number] {
  const t = c.clone().convertLinearToSRGB();
  return [t.r, t.g, t.b];
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // always at the far plane
}`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 zenith, horizon, ground, sunDir, sunColor;
uniform float sunSize, sunGlow, stars;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(horizon, zenith, pow(h, 0.6)) : mix(horizon, ground, pow(-h, 0.35));
  float s = max(dot(d, sunDir), 0.0);
  if (sunSize > 0.0) col += sunColor * pow(s, 400.0 / sunSize);
  col += sunColor * pow(s, 6.0) * sunGlow * 0.35;
  if (stars > 0.0 && h > 0.0) {
    vec3 cell = floor(d * 260.0);
    float n = hash(cell);
    float twinkle = 0.7 + 0.3 * hash(cell + 1.0);
    col += vec3(step(0.9965, n) * stars * twinkle * smoothstep(0.0, 0.25, h));
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** The dome: a far sphere around the camera with the gradient shader; `follow(camera)` every frame. */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly uniforms = {
    zenith: { value: new THREE.Color() },
    horizon: { value: new THREE.Color() },
    ground: { value: new THREE.Color() },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunColor: { value: new THREE.Color() },
    sunSize: { value: 0 },
    sunGlow: { value: 0 },
    stars: { value: 0 },
  };

  constructor(radius = 900) {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
    this.mesh.name = 'coast-sky';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
  }

  set(s: GradeState) {
    const u = this.uniforms;
    u.zenith.value.copy(s.zenith);
    u.horizon.value.copy(s.horizon);
    u.ground.value.copy(s.ground);
    u.sunDir.value.copy(s.sunDir);
    u.sunColor.value.copy(s.sunColor);
    u.sunSize.value = s.sunSize;
    u.sunGlow.value = s.sunGlow;
    u.stars.value = s.stars;
  }

  follow(cameraWorldPos: THREE.Vector3) {
    this.mesh.position.copy(cameraWorldPos);
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export interface AtmosphereOptions {
  /** Seconds a preset change takes to dissolve. */
  tweenSeconds?: number;
  skyRadius?: number;
  /** Off = the flat look (no sky dome, no per-splat modifier; lights and `scene.fog` still follow the preset). */
  enabled?: boolean;
}

/**
 * Everything W-5 in one place: the current (tweened) grade state applied each frame to the splat modifier, the sky,
 * the lights and `scene.fog`. `setTime` / `setWeather` are what the director's `set_time` / `set_weather` call.
 */
export class Atmosphere {
  readonly sky: SkyDome;
  readonly splats = new SplatGrade();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fog: THREE.FogExp2;
  readonly state: GradeState;
  private target: GradeState;
  private readonly tweenSeconds: number;
  private time: TimeOfDay = 'noon';
  private weather: Weather = 'clear';
  private weatherAmount = 0.6;
  private settled = true;
  readonly enabled: boolean;

  constructor(
    private readonly scene: THREE.Scene,
    opts: AtmosphereOptions = {},
  ) {
    this.tweenSeconds = opts.tweenSeconds ?? 1.2;
    this.enabled = opts.enabled ?? true;
    this.sky = new SkyDome(opts.skyRadius ?? 900);
    this.sky.mesh.visible = this.enabled;
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 1);
    this.fog = new THREE.FogExp2(0xffffff, 0);
    this.state = gradeState(GRADES.noon);
    this.target = gradeState(GRADES.noon);
    scene.add(this.sky.mesh, this.sun, this.hemi);
    scene.fog = this.fog;
    scene.background = null;
    this.applyNow();
  }

  get timeOfDay() {
    return this.time;
  }

  get weatherKind() {
    return this.weather;
  }

  /** Still dissolving towards the last preset? */
  get tweening() {
    return !this.settled;
  }

  /** The current fog colour (sRGB hex) — for anything that paints its own atmosphere (road fog sprites). */
  get fogColorHex(): number {
    return this.state.fogColor.getHex();
  }

  setTime(t: TimeOfDay, immediate = false) {
    this.time = t;
    this.retarget(immediate);
  }

  setWeather(kind: Weather, amount = 0.6, immediate = false) {
    this.weather = kind;
    this.weatherAmount = amount;
    this.retarget(immediate);
  }

  /** Attach the grade to a splat mesh (every resident cell). */
  grade(mesh: SplatMesh) {
    if (this.enabled) this.splats.apply(mesh);
  }

  /** Per frame: advance the dissolve and point the sky / fog at the camera. */
  update(dt: number, camera: THREE.Camera) {
    if (!this.settled) {
      const t = Math.min(1, (dt / Math.max(0.016, this.tweenSeconds)) * 3);
      lerpGradeState(this.state, this.target, t);
      if (Math.abs(this.state.fogDensity - this.target.fogDensity) < 1e-4 && this.state.tint.distanceTo(this.target.tint) < 1e-3) {
        this.settled = true;
        lerpGradeState(this.state, this.target, 1);
      }
      this.applyNow();
    }
    this.frame(camera);
  }

  /** The camera-dependent part alone (the export loop calls this per rendered frame). */
  frame(camera: THREE.Camera) {
    const p = camera.getWorldPosition(tmpV);
    this.sky.follow(p);
    this.splats.setCamera(p);
  }

  private retarget(immediate: boolean) {
    this.target = gradeState(GRADES[this.time], weatherFog(this.weather, this.weatherAmount), this.target);
    if (immediate) {
      lerpGradeState(this.state, this.target, 1);
      this.settled = true;
      this.applyNow();
    } else this.settled = false;
  }

  private applyNow() {
    const s = this.state;
    this.splats.set(s);
    this.sky.set(s);
    this.sun.color.copy(s.sunLight);
    this.sun.intensity = s.sunIntensity;
    this.sun.position.copy(s.sunDir).multiplyScalar(50);
    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGround);
    this.hemi.intensity = s.hemiIntensity;
    this.fog.color.copy(s.fogColor);
    this.fog.density = s.fogDensity;
  }

  dispose() {
    this.scene.remove(this.sky.mesh, this.sun, this.hemi);
    this.scene.fog = null;
    this.sky.dispose();
  }
}

const tmpV = new THREE.Vector3();
