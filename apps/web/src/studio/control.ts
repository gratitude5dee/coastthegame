/**
 * Control passes (goal.md STU-2): for a ≤ 5 s span of a cut, at ≤ 720p — `depth` (the scene as linearised depth, splats
 * and meshes in one image, `packages/engine/src/render/depth.ts`), `pose` (every actor as an OpenPose stick figure on
 * black) and `camera.json` (intrinsics + extrinsics per frame). Each pass is its own short WebCodecs + Mediabunny
 * video, the same fixed-step loop as the beauty export (`exporter.ts`): the host seeks the set, places the camera, and
 * this module draws the frame. What a faithful render (Wan VACE) is handed next to the beauty clip (GEN-6).
 */
import * as THREE from 'three';
import { DepthPass } from '@coast/engine';
import {
  OPENPOSE_COLORS,
  OPENPOSE_LIMBS,
  cameraFrame,
  cameraJson,
  controlFrameTime,
  projectPoint,
  skeletonFor,
  type ActorPose,
  type CameraJson,
  type ControlPass,
  type ControlPlan,
} from '@coast/studio';
import { loadMediabunny, type ExportProgress, type ExportResult, type ExportScene } from './exporter';

export interface ControlScene extends Omit<ExportScene, 'render' | 'look'> {
  /** Every actor in the shot at the current set time (the ghosts performing, the people in the cell). */
  actors: () => ActorPose[];
}

export interface ControlResult {
  passes: Partial<Record<ControlPass, ExportResult>>;
  camera: CameraJson;
  /** With `preview`: the last frame of each pass as a PNG data URL (QA: look at the passes without decoding video). */
  preview?: Partial<Record<ControlPass, string>>;
}

const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

/** Render and encode the control passes of `plan`; the camera file is built from the first pass rendered. */
export async function exportControl(
  plan: ControlPlan,
  target: ControlScene,
  passes: ControlPass[],
  onProgress?: ExportProgress,
  opts: { preview?: boolean } = {},
): Promise<ControlResult> {
  if (plan.frameCount === 0) throw new Error('nothing to export — the span is empty');
  if (!passes.length) throw new Error('no passes asked for');
  const mb = await loadMediabunny();
  const codec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1', 'vp8'], { width: plan.width, height: plan.height });
  if (!codec) throw new Error('this browser has no video encoder (WebCodecs)');
  const ext: 'mp4' | 'webm' = codec === 'vp8' ? 'webm' : 'mp4';

  const { renderer, scene, camera } = target;
  const camFile = cameraJson(plan);
  const result: ControlResult = { passes: {}, camera: camFile, ...(opts.preview ? { preview: {} } : {}) };
  const total = plan.frameCount * passes.length;
  let done = 0;

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
  const sheet = document.createElement('canvas');
  sheet.width = plan.width;
  sheet.height = plan.height;
  const ctx = sheet.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('no 2D canvas for the control passes');
  const depth = passes.includes('depth') ? new DepthPass() : null;
  try {
    for (const pass of passes) {
      const format = ext === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat();
      const bufferTarget = new mb.BufferTarget();
      const output = new mb.Output({ format, target: bufferTarget });
      const source = new mb.CanvasSource(sheet, { codec, quality: mb.QUALITY_HIGH, keyFrameInterval: 2 });
      output.addVideoTrack(source, { frameRate: plan.fps });
      await output.start();
      if (pass === 'depth' && depth) {
        depth.setRange(plan.near, plan.far);
        depth.apply(scene, renderer);
      }
      const dt = 1 / plan.fps;
      try {
        for (let i = 0; i < plan.frameCount; i++) {
          const t = controlFrameTime(plan, i);
          target.seek(t);
          target.frame?.();
          camera.updateMatrixWorld();
          const p = camera.getWorldPosition(tmpPos);
          const q = camera.getWorldQuaternion(tmpQuat);
          const frame = cameraFrame(plan, t - plan.startS, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w], camera.fov);
          if (camFile.frames.length < plan.frameCount) camFile.frames.push(frame);
          if (pass === 'depth' && depth) {
            depth.frame(camera);
            await target.settle?.();
            renderer.render(scene, camera);
            ctx.drawImage(renderer.domElement, 0, 0, plan.width, plan.height);
          } else {
            drawPose(ctx, plan, frame, target.actors(), t);
          }
          await source.add(i * dt, dt);
          onProgress?.(++done, total);
          if (i % 4 === 3) await nextTask();
        }
      } finally {
        if (pass === 'depth' && depth) depth.restore(renderer);
      }
      if (result.preview) result.preview[pass] = sheet.toDataURL('image/png');
      await output.finalize();
      const buffer = bufferTarget.buffer;
      if (!buffer) throw new Error(`the ${pass} pass produced no data`);
      const mime = await output.getMimeType();
      result.passes[pass] = {
        blob: new Blob([buffer], { type: mime }),
        mime,
        codec,
        ext,
        frames: plan.frameCount,
        seconds: plan.frameCount / plan.fps,
      };
    }
  } finally {
    depth?.dispose();
    renderer.setPixelRatio(prevPixelRatio);
    renderer.setSize(prevSize.x, prevSize.y, false);
    camera.aspect = prevAspect;
    camera.fov = prevFov;
    camera.updateProjectionMatrix();
    target.end();
  }
  return result;
}

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

/** The pose pass: OpenPose's limbs in OpenPose's colours, joints as discs, on black — the actors that are in front of the camera. */
export function drawPose(
  ctx: CanvasRenderingContext2D,
  plan: { width: number; height: number },
  cam: ReturnType<typeof cameraFrame>,
  actors: ActorPose[],
  t: number,
) {
  const { width: w, height: h } = plan;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const stroke = Math.max(2, Math.round(Math.min(w, h) / 180));
  ctx.lineCap = 'round';
  for (const actor of actors) {
    const pts = skeletonFor({ ...actor, t: actor.t ?? t }).map((p) => projectPoint(p, cam));
    if (!pts.some((p) => p.z > 0 && p.x >= -w && p.x <= 2 * w && p.y >= -h && p.y <= 2 * h)) continue;
    OPENPOSE_LIMBS.forEach(([a, b], i) => {
      const pa = pts[a]!;
      const pb = pts[b]!;
      if (!(pa.z > 0 && pb.z > 0)) return;
      const [r, g, bl] = OPENPOSE_COLORS[i]!;
      ctx.strokeStyle = `rgb(${r},${g},${bl})`;
      ctx.lineWidth = stroke;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    });
    pts.forEach((p, i) => {
      if (!(p.z > 0)) return;
      const [r, g, bl] = OPENPOSE_COLORS[i]!;
      ctx.fillStyle = `rgb(${r},${g},${bl})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, stroke, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}
