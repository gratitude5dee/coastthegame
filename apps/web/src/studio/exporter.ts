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
import { frameTime, type CutPlan } from '@coast/studio';

export interface ExportScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  seek: (tS: number) => void;
  begin: () => void;
  end: () => void;
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

export async function exportCut(plan: CutPlan, target: ExportScene, onProgress?: ExportProgress): Promise<ExportResult> {
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
  const source = new mb.CanvasSource(canvas, { codec, quality: mb.QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: plan.fps });

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
      target.seek(frameTime(plan, i));
      renderer.render(scene, camera);
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
