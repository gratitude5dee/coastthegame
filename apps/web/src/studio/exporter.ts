/**
 * Cut export (goal.md STU-1/STU-3): a fixed-step offline re-render of the set — every take performing solid, the
 * camera driven by one take's recorded camera track — at 1080p30, each frame encoded with WebCodecs and muxed by
 * Mediabunny into an MP4 (H.264 where the browser can, else VP9/AV1; VP8 → WebM). Never a real-time capture: a phone
 * that plays at 20 fps still exports a clean 30. Audio is muxed server-side in v1 (STU-3); the clip is video-only.
 *
 * The caller owns the scene: `seek(t)` puts the world in the state for set time `t` and points the camera; `begin`
 * and `end` bracket the render (pause the live loop, hide the live body, restore sizes).
 */
import * as THREE from 'three';
import { captionsAt, frameTime, type Caption, type CutPlan } from '@coast/studio';

export interface ExportScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  seek: (tS: number) => void;
  /** Async set-up before `begin` (the post stack loads on demand). */
  prepare?: () => Promise<void>;
  begin: () => void;
  end: () => void;
  /** Camera-dependent per-frame work the live loop normally does (sky follow, fog origin) — after `seek`, before the render. */
  frame?: () => void;
  /** Waits for the splat renderer to accumulate and sort for the frame's camera (Spark updates asynchronously otherwise). */
  settle?: () => Promise<void>;
  /** Draws the frame — through the post stack (the mission's look as a LUT, W-5/MIS-6) when the host has one; else `renderer.render`. */
  render?: () => void;
  /** The look on the picture (the post stack's, which the director may have changed from the mission's) — for the manifest. */
  look?: () => string;
}

/** What goes over the picture (cut assembly): the caption track. The look is rendered, not composited (see `render`). */
export interface Overlay {
  captions?: Caption[];
}

export interface ExportResult {
  blob: Blob;
  mime: string;
  codec: string;
  ext: 'mp4' | 'webm';
  frames: number;
  seconds: number;
}

export type ExportProgress = (done: number, total: number) => void;

let mediabunnyPromise: Promise<typeof import('mediabunny')> | null = null;
/** Mediabunny loads on demand (it is not part of play; QB-3). */
export function loadMediabunny() {
  mediabunnyPromise ??= import('mediabunny');
  return mediabunnyPromise;
}

/** Whether this browser can encode video at all (WebCodecs); the export button hides without it. */
export async function canExport(): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    const mb = await loadMediabunny();
    return (await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1', 'vp8'], { width: 1280, height: 720 })) !== null;
  } catch {
    return false;
  }
}

const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

export async function exportCut(
  plan: CutPlan,
  target: ExportScene,
  onProgress?: ExportProgress,
  overlay: Overlay = {},
): Promise<ExportResult> {
  if (plan.frameCount === 0) throw new Error('nothing to export — the set is empty');
  const mb = await loadMediabunny();
  const codec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1', 'vp8'], { width: plan.width, height: plan.height });
  if (!codec) throw new Error('this browser has no video encoder (WebCodecs)');
  const ext: 'mp4' | 'webm' = codec === 'vp8' ? 'webm' : 'mp4';
  const format = ext === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat();
  const bufferTarget = new mb.BufferTarget();
  const output = new mb.Output({ format, target: bufferTarget });

  const { renderer, scene, camera } = target;
  const canvas = renderer.domElement;
  const draw = target.render ?? (() => renderer.render(scene, camera));
  // The picture is composed on a 2D canvas: the WebGL frame (already graded by the post stack), then the captions.
  const compositor = new Compositor(plan.width, plan.height, overlay);
  const source = new mb.CanvasSource(compositor.canvas, { codec, quality: mb.QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: plan.fps });

  await target.prepare?.();
  const prevSize = renderer.getSize(new THREE.Vector2());
  const prevPixelRatio = renderer.getPixelRatio();
  const prevAspect = camera.aspect;
  const prevFov = camera.fov;
  target.begin();
  renderer.setPixelRatio(1);
  renderer.setSize(plan.width, plan.height, false);
  camera.aspect = plan.width / plan.height;
  camera.updateProjectionMatrix();
  try {
    await output.start();
    const dt = 1 / plan.fps;
    for (let i = 0; i < plan.frameCount; i++) {
      const t = frameTime(plan, i);
      target.seek(t);
      target.frame?.();
      await target.settle?.();
      draw();
      compositor.compose(canvas, t - plan.startS);
      await source.add(i * dt, dt);
      onProgress?.(i + 1, plan.frameCount);
      if (i % 4 === 3) await nextTask(); // let the page breathe (progress paints, input stays alive)
    }
    await output.finalize();
  } finally {
    renderer.setPixelRatio(prevPixelRatio);
    renderer.setSize(prevSize.x, prevSize.y, false);
    camera.aspect = prevAspect;
    camera.fov = prevFov;
    camera.updateProjectionMatrix();
    target.end();
  }
  const buffer = bufferTarget.buffer;
  if (!buffer) throw new Error('export produced no data');
  const mime = await output.getMimeType();
  return { blob: new Blob([buffer], { type: mime }), mime, codec, ext, frames: plan.frameCount, seconds: plan.frameCount / plan.fps };
}

/** The 2D pass over each frame: the captions (title card, markers, end card) over the rendered picture. */
class Compositor {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly captions: Caption[];

  constructor(
    readonly width: number,
    readonly height: number,
    overlay: Overlay,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('no 2D canvas for the compositor');
    this.ctx = ctx;
    this.captions = overlay.captions ?? [];
  }

  compose(frame: HTMLCanvasElement, tS: number) {
    const { ctx, width: w, height: h } = this;
    ctx.drawImage(frame, 0, 0, w, h);
    const portrait = h > w;
    const base = Math.round(Math.min(w, h) / (portrait ? 18 : 16));
    for (const c of captionsAt(this.captions, tS)) {
      const fade = Math.min(1, (tS - c.from) / 0.3, (c.to - tS) / 0.3);
      ctx.globalAlpha = Math.max(0, Math.min(1, fade));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,.7)';
      ctx.shadowBlur = base * 0.5;
      if (c.kind === 'title') {
        const [title, sub] = c.text.split('\n');
        ctx.fillStyle = '#ffb54a';
        ctx.font = `600 ${base * 1.6}px system-ui, sans-serif`;
        ctx.fillText(title ?? '', w / 2, h * 0.42);
        if (sub) {
          ctx.fillStyle = '#f2ecdc';
          ctx.font = `${base * 0.8}px system-ui, sans-serif`;
          ctx.fillText(sub, w / 2, h * 0.42 + base * 1.6);
        }
      } else if (c.kind === 'marker') {
        ctx.fillStyle = '#f2ecdc';
        ctx.font = `600 ${base}px system-ui, sans-serif`;
        ctx.fillText(c.text.toUpperCase(), w / 2, h * 0.86);
      } else if (c.kind === 'end') {
        ctx.fillStyle = 'rgba(11,10,16,.55)';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#ffb54a';
        ctx.font = `600 ${base * 1.4}px system-ui, sans-serif`;
        ctx.fillText(c.text, w / 2, h * 0.47);
      } else {
        ctx.fillStyle = '#f2ecdc';
        ctx.font = `${base * 0.75}px system-ui, sans-serif`;
        ctx.fillText(c.text, w / 2, h * 0.47 + base * 1.5);
      }
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }
}
