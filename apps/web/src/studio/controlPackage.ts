import {
  CONTROL_MAX_LONG_SIDE,
  CONTROL_MAX_SECONDS,
  CONTROL_MAX_SHORT_SIDE,
  type CameraJson,
  type ControlPromptBundle,
  type PoseSources,
} from '@coast/studio';
import type { ControlResult } from './control';

export interface ControlPackageFile {
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
}

export interface ControlPackageManifest {
  v: 1;
  kind: 'coast-control-package';
  archive: 'ustar';
  hashScope: 'payload-files-excluding-package.json';
  files: ControlPackageFile[];
  geometry: { width: number; height: number };
  timing: { startS: number; endS: number; durationS: number; fps: number; frames: number };
  hero: { file: 'hero.png'; mime: 'image/png'; width: number; height: number; timeS: number; frame: 0 };
  limitations: string[];
  poseSources?: PoseSources;
}

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_FILES = 8;
const PASSES = ['beauty', 'depth', 'pose'] as const;
const VARIANTS = ['seedance', 'veo', 'kling', 'ltx', 'wan'] as const;
const encoder = new TextEncoder();
const safeNames = new Set([
  ...PASSES.flatMap((pass) => [`${pass}.mp4`, `${pass}.webm`]),
  'hero.png',
  'camera.json',
  'prompts.json',
  'prompts.txt',
  'package.json',
]);
const LIMITATIONS = [
  'Pose uses mapped rig joints when available, omits unavailable face landmarks, and uses a procedural legacy fallback; not recorded bone motion or occlusion-aware.',
  'Videos contain no audio; music and captions are not muxed into this package.',
  'Prompts are manual guidance only; no model API, supported input format, or generation result is assumed.',
  'This archive is built locally. No upload or vendor API call occurs.',
];

type Entry = { name: string; mime: string; blob: Blob };

function requireValid(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Control package: ${message}`);
}

function metadata(value: unknown): string {
  let nodes = 0;
  const clean = (item: unknown, depth: number): unknown => {
    requireValid(++nodes <= 30000 && depth <= 16, 'metadata is too large or deeply nested');
    if (typeof item === 'string') {
      requireValid(item.length <= 65536, 'metadata text is too large');
      return item.replace(/(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:blob|data|file):|\bwww\.)\S*/gi, '[omitted]');
    }
    if (typeof item === 'number') {
      requireValid(Number.isFinite(item), 'metadata contains a non-finite number');
      return item;
    }
    if (item === null || typeof item === 'boolean') return item;
    if (Array.isArray(item)) return item.map((part) => clean(part, depth + 1));
    requireValid(typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype, 'metadata must be plain JSON');
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key, part]) => part !== undefined && !/(?:url|uri|capture|preview|thumbnail|blob|token|secret)/i.test(key))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, part]) => [key, clean(part, depth + 1)]),
    );
  };
  const text = `${JSON.stringify(clean(value, 0), null, 2)}\n`;
  requireValid(encoder.encode(text).byteLength <= MAX_METADATA_BYTES, 'metadata exceeds 1 MiB');
  return text;
}

function header(name: string, bytes: number): Uint8Array<ArrayBuffer> {
  requireValid(safeNames.has(name), 'unsafe archive filename');
  const block = new Uint8Array(512);
  const put = (offset: number, text: string) => block.set(encoder.encode(text), offset);
  const octal = (offset: number, length: number, value: number) => put(offset, `${value.toString(8).padStart(length - 1, '0')}\0`);
  put(0, name);
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, bytes);
  octal(136, 12, 0);
  put(148, '        ');
  put(156, '0');
  put(257, 'ustar\0');
  put(263, '00');
  octal(329, 8, 0);
  octal(337, 8, 0);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

function archiveBytes(entries: Entry[]): number {
  return 1024 + entries.reduce((total, entry) => total + 512 + Math.ceil(entry.blob.size / 512) * 512, 0);
}

function cameraMetadata(camera: CameraJson): CameraJson {
  return {
    v: 1,
    fps: camera.fps,
    width: camera.width,
    height: camera.height,
    depth: { encoding: camera.depth.encoding, near: camera.depth.near, far: camera.depth.far },
    frames: camera.frames.map(({ t, pos, quat, fovDeg, fx, fy, cx, cy }) => ({ t, pos, quat, fovDeg, fx, fy, cx, cy })),
  };
}

export async function buildControlPackage(
  result: ControlResult,
  prompts: ControlPromptBundle,
): Promise<{ blob: Blob; manifest: ControlPackageManifest }> {
  const subtle = globalThis.crypto?.subtle;
  requireValid(typeof subtle?.digest === 'function', 'SHA-256 requires crypto.subtle in a secure browser context');
  const { camera, hero } = result;
  const { startS, endS, durationS } = prompts.span;
  const frames = camera.frames.length;
  requireValid(
    [startS, endS, durationS, camera.fps].every(Number.isFinite) &&
      startS >= 0 &&
      durationS > 0 &&
      durationS <= CONTROL_MAX_SECONDS + 1e-9 &&
      endS - startS <= CONTROL_MAX_SECONDS + 1e-9 &&
      Math.abs(endS - startS - durationS) < 1e-7 &&
      camera.fps > 0 &&
      camera.fps <= 60 &&
      frames > 0 &&
      frames <= 60 * CONTROL_MAX_SECONDS &&
      frames / camera.fps <= CONTROL_MAX_SECONDS + 1e-9 &&
      Math.abs(frames / camera.fps - durationS) < 1e-7,
    `invalid or inconsistent timing (maximum ${CONTROL_MAX_SECONDS} seconds, 60 fps)`,
  );
  requireValid(
    [camera.width, camera.height].every((n) => Number.isSafeInteger(n) && n >= 2 && n % 2 === 0) &&
      Math.min(camera.width, camera.height) <= CONTROL_MAX_SHORT_SIDE &&
      Math.max(camera.width, camera.height) <= CONTROL_MAX_LONG_SIDE,
    'invalid control geometry',
  );
  requireValid(
    hero?.mime === 'image/png' &&
      hero.frame === 0 &&
      hero.width === camera.width &&
      hero.height === camera.height &&
      Number.isFinite(hero.timeS) &&
      Math.abs(hero.timeS - startS) < 1e-7,
    'hero must be the first beauty frame at the span start with matching geometry',
  );
  requireValid(
    camera.v === 1 &&
      camera.depth.encoding === 'linear-near-white' &&
      [camera.depth.near, camera.depth.far].every(Number.isFinite) &&
      camera.depth.near >= 0 &&
      camera.depth.far > camera.depth.near,
    'invalid camera depth range',
  );
  requireValid(
    camera.frames.every((frame, i) => Number.isFinite(frame.t) && Math.abs(frame.t - i / camera.fps) < 1e-7),
    'camera frames do not match the export clock',
  );
  requireValid(prompts.v === 1 && prompts.kind === 'coast-control-prompts' && typeof prompts.prompt === 'string', 'invalid prompt bundle');
  requireValid(
    Object.keys(result.passes).every((pass) => PASSES.some((name) => name === pass)),
    'unknown control pass',
  );
  let poseSources: PoseSources | undefined;
  if (result.poseSources !== undefined) {
    const sources = result.poseSources;
    requireValid(
      sources !== null &&
        typeof sources === 'object' &&
        !Array.isArray(sources) &&
        sources.unit === 'actor-frame' &&
        [sources.rig, sources.procedural, sources.omitted].every((n) => Number.isSafeInteger(n) && n >= 0),
      'invalid pose source counts',
    );
    poseSources = { unit: 'actor-frame', rig: sources.rig, procedural: sources.procedural, omitted: sources.omitted };
  }
  const entries: Entry[] = [];
  const add = (name: string, mime: string, blob: Blob) => {
    requireValid(blob instanceof Blob && Number.isSafeInteger(blob.size) && blob.size > 0, 'empty or invalid payload');
    entries.push({ name, mime, blob });
    requireValid(entries.length <= MAX_FILES && archiveBytes(entries) <= MAX_BYTES, 'archive exceeds 256 MiB or file count limit');
  };
  for (const pass of PASSES) {
    const video = result.passes[pass];
    if (!video) continue;
    requireValid(video.ext === 'mp4' || video.ext === 'webm', 'unsupported video extension');
    const mime = `video/${video.ext}`;
    requireValid(video.mime.split(';')[0]?.trim().toLowerCase() === mime, 'video MIME does not match its extension');
    requireValid(
      video.frames === frames && Number.isFinite(video.seconds) && Math.abs(video.seconds - durationS) < 1e-7,
      'video timing does not match the camera',
    );
    add(`${pass}.${video.ext}`, mime, video.blob);
  }
  requireValid(entries.length > 0, 'no control videos');
  add('hero.png', 'image/png', hero.blob);
  add('camera.json', 'application/json', new Blob([metadata(cameraMetadata(camera))], { type: 'application/json' }));
  const { context, cameraSummary } = prompts;
  const promptJson = metadata({
    v: 1,
    kind: 'coast-control-prompts',
    span: { startS, endS, durationS },
    context: {
      cell: context.cell,
      timePreset: context.timePreset,
      look: context.look,
      cameraSource: context.cameraSource,
      subject: context.subject,
      mission: context.mission ? { id: context.mission.id, title: context.mission.title } : undefined,
    },
    prompt: prompts.prompt,
    variants: Object.fromEntries(VARIANTS.map((key) => [key, prompts.variants[key]])),
    references: { hero: 'hero.png', camera: 'camera.json' },
    subjects: prompts.subjects.map((subject) => ({
      takeId: subject.takeId,
      actorId: subject.actorId,
      name: subject.name,
      avatar: subject.avatar ? { id: subject.avatar.id, name: subject.avatar.name, color: subject.avatar.color } : undefined,
      motion: subject.motion,
      driving: subject.driving,
      travel_m: subject.travel_m,
      startPosition_m: subject.startPosition_m,
      endPosition_m: subject.endPosition_m,
    })),
    cameraSummary: {
      source: cameraSummary.source,
      motion: cameraSummary.motion,
      travel_m: cameraSummary.travel_m,
      rotationDeg: cameraSummary.rotationDeg,
      fovDeg: { min: cameraSummary.fovDeg.min, max: cameraSummary.fovDeg.max },
    },
  });
  const safePrompts = JSON.parse(promptJson) as ControlPromptBundle;
  requireValid(
    VARIANTS.every((key) => typeof safePrompts.variants?.[key] === 'string'),
    'invalid prompt variants',
  );
  const text =
    [
      'COAST control prompts',
      safePrompts.prompt,
      ...VARIANTS.map((key) => `${key.toUpperCase()}\n${safePrompts.variants[key]}`),
      'References: hero.png (first beauty frame), camera.json',
      ...LIMITATIONS,
    ].join('\n\n') + '\n';
  requireValid(encoder.encode(text).byteLength <= MAX_METADATA_BYTES, 'prompt text exceeds 1 MiB');
  add('prompts.json', 'application/json', new Blob([promptJson], { type: 'application/json' }));
  add('prompts.txt', 'text/plain;charset=utf-8', new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const files: ControlPackageFile[] = [];
  for (const entry of entries) {
    let hash: ArrayBuffer;
    try {
      hash = await subtle.digest('SHA-256', await entry.blob.arrayBuffer());
    } catch {
      throw new Error('Control package: SHA-256 hashing failed; no archive was created');
    }
    requireValid(hash.byteLength === 32, 'SHA-256 returned an invalid digest');
    files.push({
      name: entry.name,
      mime: entry.mime,
      bytes: entry.blob.size,
      sha256: Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join(''),
    });
  }
  const manifest: ControlPackageManifest = {
    v: 1,
    kind: 'coast-control-package',
    archive: 'ustar',
    hashScope: 'payload-files-excluding-package.json',
    files,
    geometry: { width: camera.width, height: camera.height },
    timing: { startS, endS, durationS, fps: camera.fps, frames },
    hero: { file: 'hero.png', mime: 'image/png', width: hero.width, height: hero.height, timeS: hero.timeS, frame: 0 },
    limitations: [...LIMITATIONS],
    ...(poseSources ? { poseSources } : {}),
  };
  add('package.json', 'application/json', new Blob([metadata(manifest)], { type: 'application/json' }));
  const chunks: BlobPart[] = [];
  for (const entry of entries) {
    chunks.push(header(entry.name, entry.blob.size), entry.blob);
    const padding = (512 - (entry.blob.size % 512)) % 512;
    if (padding) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return { blob: new Blob(chunks, { type: 'application/x-tar' }), manifest };
}
