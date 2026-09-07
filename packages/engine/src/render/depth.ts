/**
 * The depth control pass (goal.md STU-2): the picture as linearised depth — near white, far black, between a per-clip
 * near/far the camera file carries — for the splats *and* the meshes in one image. Splats: a Spark world modifier
 * turns every splat's colour into its depth along the view axis (the "render depth" pattern: the same alpha, so the
 * accumulated depth is opacity-weighted like the picture). Meshes: their materials are swapped for one shader that
 * writes the same encoding, transparent things (fog sprites, ghosts on set) are skipped, the sky is hidden and the
 * clear colour is black (far). `apply` before the pass, `restore` after — the scene is left as it was.
 */
import * as THREE from 'three';
import { dyno, type SplatMesh } from '@sparkjsdev/spark';
import type { GsplatModifier } from '@sparkjsdev/spark';

/** Metres along the view axis → 0..1 (near = 1). Mirrors `encodeDepth` in packages/studio. */
const DEPTH_GLSL = /* glsl */ `1.0 - clamp((z - near) / max(1e-6, far - near), 0.0, 1.0)`;

/** The per-splat depth modifier (one shared dyno; uniforms driven per frame). */
export class SplatDepth {
  readonly modifier: GsplatModifier;
  private readonly camPos = new dyno.DynoVec3({ value: new THREE.Vector3() });
  private readonly camForward = new dyno.DynoVec3({ value: new THREE.Vector3(0, 0, -1) });
  private readonly near = new dyno.DynoFloat({ value: 0.25 });
  private readonly far = new dyno.DynoFloat({ value: 60 });

  constructor() {
    const { camPos, camForward, near, far } = this;
    this.modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
      if (!gsplat) throw new Error('depth modifier needs a gsplat input');
      const d = dyno.dyno({
        inTypes: { gsplat: dyno.Gsplat, camPos: 'vec3', camForward: 'vec3', near: 'float', far: 'float' },
        outTypes: { gsplat: dyno.Gsplat },
        inputs: { gsplat, camPos, camForward, near, far },
        statements: ({ inputs, outputs }) => [
          `${outputs.gsplat} = ${inputs.gsplat};`,
          `{`,
          `  float z = dot(${inputs.gsplat}.center - ${inputs.camPos}, ${inputs.camForward});`,
          `  float near = ${inputs.near};`,
          `  float far = ${inputs.far};`,
          `  ${outputs.gsplat}.rgba.rgb = vec3(${DEPTH_GLSL});`,
          `}`,
        ],
      });
      return { gsplat: d.outputs.gsplat };
    });
  }

  setRange(near: number, far: number) {
    this.near.value = near;
    this.far.value = far;
  }

  setCamera(camera: THREE.Camera) {
    camera.getWorldPosition(this.camPos.value);
    camera.getWorldDirection(this.camForward.value);
  }
}

const MESH_DEPTH_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
varying float vViewZ;
void main() {
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const MESH_DEPTH_FRAG = /* glsl */ `
uniform float near;
uniform float far;
varying float vViewZ;
void main() {
  float z = vViewZ;
  gl_FragColor = vec4(vec3(${DEPTH_GLSL}), 1.0);
}`;

interface Swapped {
  mesh: THREE.Mesh;
  material: THREE.Material | THREE.Material[];
}

/**
 * Puts a scene into depth: every splat mesh gets the depth modifier in place of its grade, every opaque mesh the depth
 * material, transparent meshes and the sky are hidden, the renderer clears to black. `restore` undoes all of it.
 */
export class DepthPass {
  readonly splats = new SplatDepth();
  private readonly material: THREE.ShaderMaterial;
  private readonly swapped: Swapped[] = [];
  private readonly hidden: THREE.Object3D[] = [];
  private readonly splatMods: { mesh: SplatMesh; modifiers: GsplatModifier[] | undefined }[] = [];
  private clear: { color: THREE.Color; alpha: number } | null = null;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: { near: { value: 0.25 }, far: { value: 60 } },
      vertexShader: MESH_DEPTH_VERT,
      fragmentShader: MESH_DEPTH_FRAG,
      fog: false,
      toneMapped: false,
    });
  }

  setRange(near: number, far: number) {
    this.material.uniforms.near!.value = near;
    this.material.uniforms.far!.value = far;
    this.splats.setRange(near, far);
  }

  /** Per frame, after the camera is placed. */
  frame(camera: THREE.Camera) {
    this.splats.setCamera(camera);
  }

  apply(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.clear = { color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha() };
    renderer.setClearColor(0x000000, 1);
    scene.traverse((o) => {
      if (!o.visible) return;
      if (isSplatMesh(o)) {
        this.splatMods.push({ mesh: o, modifiers: o.worldModifiers });
        o.worldModifier = this.splats.modifier;
        o.updateGenerator();
        return;
      }
      const m = o as THREE.Mesh;
      if (!m.isMesh || isSparkRenderer(o)) return; // the SparkRenderer mesh draws the splats: its material stays
      if (m.name === 'coast-sky' || isTransparent(m.material)) {
        m.visible = false;
        this.hidden.push(m);
        return;
      }
      this.swapped.push({ mesh: m, material: m.material });
      m.material = this.material;
    });
  }

  restore(renderer: THREE.WebGLRenderer) {
    for (const s of this.swapped) s.mesh.material = s.material;
    this.swapped.length = 0;
    for (const o of this.hidden) o.visible = true;
    this.hidden.length = 0;
    for (const { mesh, modifiers } of this.splatMods) {
      mesh.worldModifiers = modifiers;
      mesh.updateGenerator();
    }
    this.splatMods.length = 0;
    if (this.clear) renderer.setClearColor(this.clear.color, this.clear.alpha);
    this.clear = null;
  }

  dispose() {
    this.material.dispose();
  }
}

function isSplatMesh(o: THREE.Object3D): o is SplatMesh {
  const s = o as Partial<SplatMesh>;
  return typeof s.updateGenerator === 'function' && 'generatorDirty' in o;
}

function isSparkRenderer(o: THREE.Object3D): boolean {
  return 'maxStdDev' in o && 'enableLod' in o && !('generatorDirty' in o);
}

function isTransparent(m: THREE.Material | THREE.Material[]): boolean {
  return Array.isArray(m) ? m.some((x) => x.transparent) : m.transparent;
}
