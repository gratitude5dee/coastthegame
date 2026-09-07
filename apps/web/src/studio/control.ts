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
  CONTROL_MAX_LONG_SIDE,
  CONTROL_MAX_SECONDS,
  CONTROL_MAX_SHORT_SIDE,
  OPENPOSE_COLORS,
  OPENPOSE_LIMBS,
  cameraFrame,
  cameraJson,
  controlFrameTime,
  poseKeypointsFor,
  projectPoint,
  type ActorPose,
  type CameraJson,
  type ControlPass,
  type ControlPlan,
  type PoseSources,
} from '@coast/studio';
import { loadMediabunny, type ExportProgress, type ExportResult, type ExportScene } from './exporter';

export interface ControlScene extends ExportScene {
  /** Every actor in the shot at the current set time (the ghosts performing, the people in the cell). */
  actors: () => ActorPose[];
}

export interface ControlResult {
  hero: {
    blob: Blob;
    mime: 'image/png';
    width: number;
    height: number;
    timeS: number;
    frame: 0;
    preview?: string;
  };
  passes: Partial<Record<ControlPass, ExportResult>>;
  camera: CameraJson;
  poseSources?: PoseSources;
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
  validateControlPlan(plan);
  if (!Array.isArray(passes) || !passes.length) throw new Error('no passes asked for');
  if ([...passes].some((pass) => pass !== 'beauty' && pass !== 'depth' && pass !== 'pose')) throw new Error('invalid control pass');
  if (new Set(passes).size !== passes.length) throw new Error('duplicate control pass');
  const mb = await loadMediabunny();
  const codec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1', 'vp8'], { width: plan.width, height: plan.height });
  if (!codec) throw new Error('this browser has no video encoder (WebCodecs)');
  const ext: 'mp4' | 'webm' = codec === 'vp8' ? 'webm' : 'mp4';

  const { renderer, scene, camera } = target;
  const camFile = cameraJson(plan);
  const total = plan.frameCount * passes.length;
  const dt = 1 / plan.fps;
  const draw: (dt: number) => void = target.render?.bind(target) ?? (() => renderer.render(scene, camera));
  let done = 0;
  const prevSize = renderer.getSize(new THREE.Vector2());
  const prevPixelRatio = renderer.getPixelRatio();
  const prevAspect = camera.aspect;
  const prevFov = camera.fov;
  const prevPosition = camera.position.clone();
  const prevQuaternion = camera.quaternion.clone();
  const prevScale = camera.scale.clone();
  let begun = false;
  let failed = false;
  let depth: DepthPass | null = null;
  const captureCamera = (t: number) => {
    camera.updateMatrixWorld();
    const p = camera.getWorldPosition(tmpPos);
    const q = camera.getWorldQuaternion(tmpQuat);
    return cameraFrame(plan, t - plan.startS, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w], camera.fov);
  };
  const makeCanvas = () => {
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('no 2D canvas for the control passes');
    return { canvas, ctx };
  };
  try {
    await target.prepare?.();
    begun = true;
    target.begin();
    renderer.setPixelRatio(1);
    renderer.setSize(plan.width, plan.height, false);
    camera.aspect = plan.width / plan.height;
    camera.updateProjectionMatrix();
    const { canvas: sheet, ctx } = makeCanvas();
    const { canvas: heroSheet, ctx: heroCtx } = makeCanvas();
    const heroTime = controlFrameTime(plan, 0);
    target.seek(heroTime);
    target.frame?.();
    await target.settle?.();
    const heroCamera = captureCamera(heroTime);
    draw(dt);
    heroCtx.drawImage(renderer.domElement, 0, 0, plan.width, plan.height);
    const heroBlob = await new Promise<Blob>((resolve, reject) => {
      heroSheet.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('the hero frame could not be encoded as PNG'));
      }, 'image/png');
    });
    const result: ControlResult = {
      hero: {
        blob: heroBlob,
        mime: 'image/png',
        width: plan.width,
        height: plan.height,
        timeS: heroTime,
        frame: 0,
        ...(opts.preview ? { preview: heroSheet.toDataURL('image/png') } : {}),
      },
      passes: {},
      camera: camFile,
      ...(passes.includes('pose') ? { poseSources: { unit: 'actor-frame' as const, rig: 0, procedural: 0, omitted: 0 } } : {}),
      ...(opts.preview ? { preview: {} } : {}),
    };
    depth = passes.includes('depth') ? new DepthPass() : null;
    for (const [passIndex, pass] of passes.entries()) {
      const format = ext === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat();
      const bufferTarget = new mb.BufferTarget();
      const output = new mb.Output({ format, target: bufferTarget });
      let source: InstanceType<typeof mb.CanvasSource> | undefined;
      let sourceClosed = false;
      let passFailed = false;
      const closeSource = () => {
        if (source && !sourceClosed) {
          sourceClosed = true;
          source.close();
        }
      };
      try {
        source = new mb.CanvasSource(sheet, { codec, quality: mb.QUALITY_HIGH, keyFrameInterval: 2 });
        output.addVideoTrack(source, { frameRate: plan.fps });
        await output.start();
        if (pass === 'depth' && depth) {
          depth.setRange(plan.near, plan.far);
          depth.apply(scene, renderer);
        }
        for (let i = 0; i < plan.frameCount; i++) {
          const t = controlFrameTime(plan, i);
          const sharedHero = pass === 'beauty' && i === 0;
          if (!sharedHero) {
            target.seek(t);
            target.frame?.();
            if (pass === 'depth') depth?.frame(camera);
            await target.settle?.();
          }
          const frame = i === 0 ? heroCamera : captureCamera(t);
          if (passIndex === 0) camFile.frames.push(frame);
          if (sharedHero) {
            ctx.drawImage(heroSheet, 0, 0, plan.width, plan.height);
          } else if (pass === 'beauty' || pass === 'depth') {
            if (pass === 'beauty') draw(dt);
            else renderer.render(scene, camera);
            ctx.drawImage(renderer.domElement, 0, 0, plan.width, plan.height);
          } else {
            const sources = drawPose(ctx, plan, frame, target.actors(), t);
            result.poseSources!.rig += sources.rig;
            result.poseSources!.procedural += sources.procedural;
            result.poseSources!.omitted += sources.omitted;
          }
          await source.add(i * dt, dt);
          onProgress?.(++done, total);
          if (i % 4 === 3) await nextTask();
        }
        if (result.preview) result.preview[pass] = sheet.toDataURL('image/png');
        closeSource();
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
      } catch (error) {
        passFailed = true;
        throw error;
      } finally {
        await cleanupControl(
          [
            () => {
              if (pass === 'depth') depth?.restore(renderer);
            },
            async () => {
              if (passFailed) await output.cancel();
            },
            closeSource,
          ],
          passFailed,
        );
      }
    }
    return result;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await cleanupControl(
      [
        () => depth?.dispose(),
        () => renderer.setPixelRatio(prevPixelRatio),
        () => renderer.setSize(prevSize.x, prevSize.y, false),
        () => {
          camera.position.copy(prevPosition);
          camera.quaternion.copy(prevQuaternion);
          camera.scale.copy(prevScale);
          camera.aspect = prevAspect;
          camera.fov = prevFov;
          camera.updateProjectionMatrix();
          camera.updateMatrixWorld(true);
        },
        () => {
          if (begun) target.end();
        },
      ],
      failed,
    );
  }
}

function validateControlPlan(plan: ControlPlan) {
  if (plan.frameCount === 0) throw new Error('nothing to export — the span is empty');
  if (
    ![plan.fps, plan.startS, plan.endS, plan.near, plan.far].every(Number.isFinite) ||
    plan.fps <= 0 ||
    plan.fps > 60 ||
    plan.endS - plan.startS > CONTROL_MAX_SECONDS + 1e-9 ||
    plan.frameCount / plan.fps > CONTROL_MAX_SECONDS + 1e-9 ||
    Math.min(plan.width, plan.height) > CONTROL_MAX_SHORT_SIDE ||
    Math.max(plan.width, plan.height) > CONTROL_MAX_LONG_SIDE ||
    plan.startS < 0 ||
    plan.endS <= plan.startS ||
    plan.near < 0 ||
    plan.far <= plan.near ||
    ![plan.width, plan.height].every((n) => Number.isSafeInteger(n) && n >= 2 && n % 2 === 0) ||
    !Number.isSafeInteger(plan.frameCount) ||
    plan.frameCount < 1 ||
    !Number.isFinite(plan.frameCount / plan.fps) ||
    Math.abs(plan.endS - plan.startS - plan.frameCount / plan.fps) > 1e-6
  )
    throw new Error('invalid control plan');
}

async function cleanupControl(actions: (() => void | Promise<void>)[], suppress: boolean) {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (!suppress && errors.length) throw errors[0];
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
): PoseSources {
  const sources: PoseSources = { unit: 'actor-frame', rig: 0, procedural: 0, omitted: 0 };
  const { width: w, height: h } = plan;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const stroke = Math.max(2, Math.round(Math.min(w, h) / 180));
  ctx.lineCap = 'round';
  for (const actor of actors) {
    const { points, source } = poseKeypointsFor({ ...actor, t: actor.t ?? t });
    sources[source]++;
    const pts = points.map((p) => (p ? projectPoint(p, cam) : null));
    if (!pts.some((p) => p && p.z > 0 && p.x >= -w && p.x <= 2 * w && p.y >= -h && p.y <= 2 * h)) continue;
    OPENPOSE_LIMBS.forEach(([a, b], i) => {
      const pa = pts[a];
      const pb = pts[b];
      if (!pa || !pb || !(pa.z > 0 && pb.z > 0)) return;
      const [r, g, bl] = OPENPOSE_COLORS[i]!;
      ctx.strokeStyle = `rgb(${r},${g},${bl})`;
      ctx.lineWidth = stroke;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    });
    pts.forEach((p, i) => {
      if (!p || !(p.z > 0)) return;
      const [r, g, bl] = OPENPOSE_COLORS[i]!;
      ctx.fillStyle = `rgb(${r},${g},${bl})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, stroke, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  return sources;
}
