/**
 * The post stack (goal.md W-5 "post LUT", MIS-6 / STU-4 "the LUT named by the mission's look", AF-7 `postprocessing`):
 * scene → (bloom for the neon) → chromatic aberration → the look's 3D LUT → vignette → grain → screen. Desktop runs it
 * live (`Budgets.postProcessing === 'full'`); every tier runs it for the cut export, which is offline; XR never does
 * (the composer draws to the canvas, not the layer) — the per-splat grade in `world/grade.ts` carries those.
 *
 * The buffers are *display-referred* (ADR-0010): the scene is rendered into an RGBA8 target that three treats like
 * the canvas — materials encode to sRGB in-shader and the target is allocated linear (three does that for a target it
 * takes for an XR layer, `isXRRenderTarget`), so the splats keep writing and blending sRGB values exactly as they do
 * on screen (the way they were trained) and the meshes land next to them looking the same. The effects then work on
 * finished pixels — a LUT is a display-space transform anyway — and the last pass hands them to the canvas unencoded.
 * A `clean` look at noon is therefore the picture without the stack, to the bit.
 */
import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  LookupTexture,
  LUT3DEffect,
  NoiseEffect,
  Pass,
  RenderPass,
  VignetteEffect,
} from 'postprocessing';
import { bakeLut, isLookName, lookRecipe, NEUTRAL_POST, type LookRecipe, type PostGrade } from './looks';

export interface PostOptions {
  /** Side of the LUT cube (32 is plenty for smooth grades; 17 for a cheaper rebake). */
  lutSize?: number;
  /** Bloom available at all (off on tiers whose export should stay cheap). */
  bloom?: boolean;
}

export interface PostState {
  enabled: boolean;
  look: string;
  bloom: number;
  contrast: number;
  lift: number;
  lutSize: number;
  passes: string[];
}

/** Reads the renderer's draw-call count right after the scene pass (the fullscreen passes would hide it). */
class DrawProbe extends Pass {
  calls = 0;
  constructor() {
    super('DrawProbe');
    this.needsSwap = false;
  }
  override render(renderer: THREE.WebGLRenderer) {
    this.calls = renderer.info.render.calls;
  }
}

/**
 * Make a render target take colour the way the canvas does (see the module note): the XR flag + an sRGB colour space
 * make three's materials encode in-shader, and the explicit `RGBA8` keeps the storage linear — without it three (r180)
 * allocates `SRGB8_ALPHA8` for a texture attachment and the hardware encodes a second time.
 */
function displayReferred(target: THREE.WebGLRenderTarget) {
  (target as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  target.texture.colorSpace = THREE.SRGBColorSpace;
  target.texture.internalFormat = 'RGBA8';
}

export class PostStack {
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly bloomPass: EffectPass;
  readonly gradePass: EffectPass;
  readonly bloom: BloomEffect;
  readonly lut: LUT3DEffect;
  readonly vignette: VignetteEffect;
  readonly grain: NoiseEffect;
  readonly aberration: ChromaticAberrationEffect;
  readonly lutSize: number;
  private readonly probe = new DrawProbe();
  private readonly lutTexture: LookupTexture;
  private readonly lutData: Float32Array;
  private readonly bloomAllowed: boolean;
  private lookName = 'clean';
  private recipe: LookRecipe = lookRecipe('clean');
  private readonly post: PostGrade = { ...NEUTRAL_POST };
  private neon = 0;
  private bakedKey = '';
  private readonly drawingSize = new THREE.Vector2();
  private readonly aberrationOffset = new THREE.Vector2();

  constructor(
    readonly renderer: THREE.WebGLRenderer,
    readonly scene: THREE.Scene,
    readonly camera: THREE.Camera,
    opts: PostOptions = {},
  ) {
    this.lutSize = opts.lutSize ?? 32;
    this.bloomAllowed = opts.bloom ?? true;
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.UnsignedByteType, multisampling: 0 });
    displayReferred(this.composer.inputBuffer);
    displayReferred(this.composer.outputBuffer);
    this.renderPass = new RenderPass(scene, camera);

    this.lutData = bakeLut(this.recipe, this.post, this.lutSize);
    this.lutTexture = new LookupTexture(this.lutData, this.lutSize);
    this.lutTexture.name = 'coast-look';
    // The buffer already holds display values: no conversion before the lookup, none after.
    this.lut = new LUT3DEffect(this.lutTexture, { tetrahedralInterpolation: true, inputColorSpace: THREE.LinearSRGBColorSpace });
    this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.72, luminanceSmoothing: 0.25, intensity: 0, radius: 0.7 });
    this.vignette = new VignetteEffect({ offset: 0.32, darkness: 0 });
    this.grain = new NoiseEffect({ blendFunction: BlendFunction.SOFT_LIGHT });
    this.aberration = new ChromaticAberrationEffect({ offset: this.aberrationOffset, radialModulation: true, modulationOffset: 0.2 });

    this.bloomPass = new EffectPass(camera, this.bloom);
    this.gradePass = new EffectPass(camera, this.aberration, this.lut, this.vignette, this.grain);
    for (const p of [this.bloomPass, this.gradePass]) {
      p.encodeOutput = false;
      // Read the 8-bit buffer through a mediump sampler, not the lowp one postprocessing picks for byte buffers: lowp
      // texels are 1/256 steps, which turn k/255 values into ±1 noise on every pixel (SwiftShader and mobile GPUs honour it).
      const material = p.fullscreenMaterial as THREE.ShaderMaterial;
      material.defines.FRAMEBUFFER_PRECISION_HIGH = '1';
      material.needsUpdate = true;
    }
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.probe);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.gradePass);
    this.bloomPass.enabled = false;
    this.applyLook();
  }

  /** Draw calls of the scene pass in the last frame (what `renderer.info` would say without the stack). */
  get sceneDraws() {
    return this.probe.calls;
  }

  /** The look on the picture, by name. */
  get look() {
    return this.lookName;
  }

  /** The look by name (`clean` when unknown); returns whether the name was known. */
  setLook(name: string): boolean {
    const known = isLookName(name);
    this.lookName = known ? name : 'clean';
    this.recipe = lookRecipe(this.lookName);
    this.applyLook();
    return known;
  }

  /** The time-of-day's share (`GradeState.postContrast/postLift/neon`), every frame — rebakes the LUT when it moved. */
  setGrade(contrast: number, lift: number, neon: number) {
    this.post.contrast = contrast;
    this.post.lift = lift;
    this.neon = neon;
    this.applyBloom();
  }

  /** Render the frame through the stack (resizes the buffers to the renderer's drawing buffer first). */
  render(dt = 1 / 60) {
    const d = this.renderer.getDrawingBufferSize(this.drawingSize);
    if (this.composer.inputBuffer.width !== d.x || this.composer.inputBuffer.height !== d.y) {
      const s = this.renderer.getSize(tmpSize);
      this.composer.setSize(s.x, s.y, false);
    }
    this.bake();
    this.composer.render(dt);
  }

  state(): PostState {
    return {
      enabled: true,
      look: this.lookName,
      bloom: this.bloomPass.enabled ? this.bloom.intensity : 0,
      contrast: this.post.contrast,
      lift: this.post.lift,
      lutSize: this.lutSize,
      passes: this.composer.passes.filter((p) => p.enabled && p !== this.probe).map((p) => p.name),
    };
  }

  dispose() {
    this.composer.dispose();
    this.lutTexture.dispose();
  }

  private applyLook() {
    const l = this.recipe;
    this.vignette.darkness = l.vignette;
    this.vignette.blendMode.opacity.value = l.vignette > 0 ? 1 : 0;
    this.grain.blendMode.opacity.value = l.grain * 0.4;
    this.aberrationOffset.set(0.0025 * l.aberration, 0.0015 * l.aberration);
    this.aberration.blendMode.opacity.value = l.aberration > 0 ? 1 : 0;
    this.applyBloom();
  }

  private applyBloom() {
    const intensity = this.bloomAllowed ? this.neon * this.recipe.bloom * 1.4 : 0;
    this.bloom.intensity = intensity;
    this.bloomPass.enabled = intensity > 0.02;
  }

  private bake() {
    const key = `${this.lookName}|${this.post.contrast.toFixed(3)}|${this.post.lift.toFixed(3)}`;
    if (key === this.bakedKey) return;
    this.bakedKey = key;
    bakeLut(this.recipe, this.post, this.lutSize, this.lutData);
    this.lutTexture.needsUpdate = true;
  }
}

const tmpSize = new THREE.Vector2();
