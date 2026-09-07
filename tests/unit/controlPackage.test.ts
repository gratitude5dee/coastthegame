import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildControlPackage } from '../../apps/web/src/studio/controlPackage';
import type { ControlResult } from '../../apps/web/src/studio/control';
import { cameraFrame, cameraJson, type ControlPlan } from '../../packages/studio/src/control';
import { buildControlPrompts } from '../../packages/studio/src/controlPrompts';

function fixture(ext: 'mp4' | 'webm' = 'mp4', overrides: Partial<ControlPlan> = {}) {
  const plan: ControlPlan = {
    width: 1280,
    height: 720,
    fps: 30,
    frameCount: 2,
    startS: 2,
    endS: 2 + 2 / 30,
    near: 0.25,
    far: 60,
    ...overrides,
  };
  const camera = cameraJson(plan);
  camera.frames = Array.from({ length: plan.frameCount }, (_, i) => cameraFrame(plan, i / plan.fps, [0, 1, 3], [0, 0, 0, 1], 50));
  const video = {
    blob: new Blob([new Uint8Array(513).fill(37)], { type: `video/${ext}` }),
    mime: `video/${ext}; codecs="avc1"`,
    codec: 'avc',
    ext,
    frames: plan.frameCount,
    seconds: plan.frameCount / plan.fps,
  };
  const result: ControlResult = {
    passes: { beauty: video, depth: video, pose: video },
    camera,
    hero: {
      blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
      mime: 'image/png',
      width: plan.width,
      height: plan.height,
      timeS: plan.startS,
      frame: 0,
      preview: 'data:image/png;base64,PRIVATE',
    },
    preview: { beauty: 'data:image/png;base64,PRIVATE' },
  };
  const prompts = buildControlPrompts({
    plan,
    camera,
    takes: [
      {
        v: 1,
        id: 'take-1',
        actorId: 'player',
        cellVersion: '1',
        hz: 30,
        startedAt: 'ignored',
        durationS: 4,
        samples: [{ t: 0, pos: [0, 0, 0], yaw: 0, speed: 0, grounded: true, driving: false, camPos: [0, 1, 3], camQuat: [0, 0, 0, 1] }],
        worldEdits: [],
      },
    ],
    context: { cell: 'pier', timePreset: 'golden', look: 'clean', cameraSource: 'take' },
  });
  prompts.prompt += '\nCafé — 海岸';
  return { result, prompts };
}

function parseTar(buffer: ArrayBuffer): Map<string, Uint8Array> {
  const bytes = new Uint8Array(buffer);
  const text = (start: number, length: number) => new TextDecoder().decode(bytes.subarray(start, start + length)).replace(/\0.*$/s, '');
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (bytes[offset] !== 0) {
    expect(offset % 512).toBe(0);
    const name = text(offset, 100);
    expect(name).toMatch(/^(?:(?:beauty|depth|pose)\.(?:mp4|webm)|hero\.png|(?:camera|prompts|package)\.json|prompts\.txt)$/);
    expect(entries.has(name)).toBe(false);
    expect(text(offset + 257, 6)).toBe('ustar');
    expect(text(offset + 263, 2)).toBe('00');
    expect(text(offset + 156, 1)).toBe('0');
    expect(parseInt(text(offset + 136, 12), 8)).toBe(0);
    const header = bytes.slice(offset, offset + 512);
    const checksum = parseInt(text(offset + 148, 8), 8);
    header.fill(32, 148, 156);
    expect(header.reduce((sum, value) => sum + value, 0)).toBe(checksum);
    const size = parseInt(text(offset + 124, 12), 8);
    const start = offset + 512;
    const next = start + Math.ceil(size / 512) * 512;
    entries.set(name, bytes.slice(start, start + size));
    expect(bytes.subarray(start + size, next).every((n) => n === 0)).toBe(true);
    offset = next;
  }
  expect(bytes.length - offset).toBe(1024);
  expect(bytes.subarray(offset).every((n) => n === 0)).toBe(true);
  return entries;
}

async function expectInvalidPlan(input: ReturnType<typeof fixture>, message: RegExp) {
  const digest = vi.fn();
  const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
  vi.stubGlobal('crypto', { subtle: { digest } });
  await expect(buildControlPackage(input.result, input.prompts)).rejects.toThrow(message);
  expect(read).not.toHaveBeenCalled();
  expect(digest).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('local control package TAR (STU-2/STU-5)', () => {
  it.each(['mp4', 'webm'] as const)(
    'writes fixed %s names, valid ustar checksums and padding, UTF-8 sizes and verifiable hashes',
    async (ext) => {
      const { result, prompts } = fixture(ext);
      const { blob, manifest } = await buildControlPackage(result, prompts);
      expect(blob.type).toBe('application/x-tar');
      expect(blob.size % 512).toBe(0);
      const entries = parseTar(await blob.arrayBuffer());
      expect([...entries.keys()]).toEqual([
        `beauty.${ext}`,
        `depth.${ext}`,
        `pose.${ext}`,
        'hero.png',
        'camera.json',
        'prompts.json',
        'prompts.txt',
        'package.json',
      ]);
      for (const file of manifest.files) {
        const bytes = entries.get(file.name)!;
        expect(file.bytes).toBe(bytes.byteLength);
        expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      }
      const decode = (name: string) => new TextDecoder().decode(entries.get(name)!);
      expect(JSON.parse(decode('package.json'))).toEqual(manifest);
      expect(JSON.parse(decode('camera.json'))).toEqual(result.camera);
      expect(JSON.parse(decode('prompts.json'))).toEqual(prompts);
      expect(decode('prompts.txt')).toContain('Café — 海岸');
      expect(entries.get('prompts.txt')!.byteLength).toBeGreaterThan(decode('prompts.txt').length);
      expect(manifest.hero).toMatchObject({ file: 'hero.png', frame: 0, timeS: 2, width: 1280, height: 720 });
      expect(manifest.geometry).toEqual({ width: 1280, height: 720 });
      expect(manifest.timing).toMatchObject({ startS: 2, fps: 30, frames: 2 });
      expect(manifest.hashScope).toBe('payload-files-excluding-package.json');
      expect(manifest.limitations.join(' ')).toMatch(
        /mapped rig joints.*unavailable face landmarks.*procedural legacy fallback.*not recorded bone motion or occlusion-aware.*no audio.*no model API.*No upload/s,
      );
      expect(manifest).not.toHaveProperty('poseSources');
    },
  );

  it.each([
    { unit: 'actor-frame' as const, rig: 5, procedural: 2, omitted: 3 },
    { unit: 'actor-frame' as const, rig: 0, procedural: 0, omitted: 0 },
  ])('preserves allowlisted pose source counts in the existing manifest without another archive file: %j', async (sources) => {
    const { result, prompts } = fixture();
    result.poseSources = { ...sources };
    Object.assign(result.poseSources, { arbitrary: 'PRIVATE', url: 'https://private.example', preview: 'PRIVATE' });
    const { blob, manifest } = await buildControlPackage(result, prompts);
    expect(manifest.poseSources).toEqual(sources);
    expect(manifest.poseSources).not.toBe(result.poseSources);
    const entries = parseTar(await blob.arrayBuffer());
    expect(entries.size).toBe(8);
    expect(manifest.files).toHaveLength(7);
    const text = new TextDecoder().decode(entries.get('package.json')!);
    expect(JSON.parse(text)).toEqual(manifest);
    expect(text).not.toMatch(/PRIVATE|arbitrary|private\.example/);
    expect(entries.get('hero.png')).toEqual(new Uint8Array(await result.hero.blob.arrayBuffer()));
  });

  it.each([
    null,
    [],
    'actor-frame',
    {},
    { unit: 'frame', rig: 1, procedural: 0, omitted: 0 },
    { unit: 'actor-frame', rig: 1, procedural: 0 },
    ...['rig', 'procedural', 'omitted'].flatMap((key) =>
      [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null].map((value) => ({
        unit: 'actor-frame',
        rig: 0,
        procedural: 0,
        omitted: 0,
        [key]: value,
      })),
    ),
  ])('rejects invalid pose source counts before hashing: %j', async (poseSources) => {
    const input = fixture();
    Object.assign(input.result, { poseSources });
    await expectInvalidPlan(input, /Control package: invalid pose source counts/);
  });

  it.each([
    [1280, 720],
    [720, 1280],
  ])('accepts near zero at the full 5-second, 60-fps, %sx%s envelope', async (width, height) => {
    const { result, prompts } = fixture('mp4', { width, height, near: 0, fps: 60, frameCount: 300, endS: 7 });
    const { blob, manifest } = await buildControlPackage(result, prompts);
    const entries = parseTar(await blob.arrayBuffer());
    expect(JSON.parse(new TextDecoder().decode(entries.get('camera.json')!)).depth).toEqual({
      encoding: 'linear-near-white',
      near: 0,
      far: 60,
    });
    expect(manifest.geometry).toEqual({ width, height });
    expect(manifest.timing).toEqual({ startS: 2, endS: 7, durationS: 5, fps: 60, frames: 300 });
  });

  it.each([60.01, 61, 120])('rejects an otherwise aligned %s-fps override without allocating hash buffers', async (fps) => {
    const input = fixture();
    input.result.camera.fps = fps;
    input.result.camera.frames.forEach((frame, i) => {
      frame.t = i / fps;
    });
    input.prompts.span.durationS = 2 / fps;
    input.prompts.span.endS = input.prompts.span.startS + 2 / fps;
    for (const video of Object.values(input.result.passes)) video.seconds = 2 / fps;
    await expectInvalidPlan(input, /Control package: invalid or inconsistent timing/);
  });

  it.each([
    [1282, 720],
    [720, 1282],
    [1280, 722],
    [722, 1280],
    [8192, 2],
    [1279, 720],
    [1, 2],
  ])('rejects a %sx%s geometry override without allocating hash buffers', async (width, height) => {
    const input = fixture();
    Object.assign(input.result.camera, { width, height });
    Object.assign(input.result.hero, { width, height });
    await expectInvalidPlan(input, /Control package: invalid control geometry/);
  });

  it.each([
    [-1, 60],
    [NaN, 60],
    [0, Infinity],
    [0, NaN],
    [Infinity, Infinity],
    [0, 0],
    [1, 0.5],
  ])('rejects depth near=%s far=%s without allocating hash buffers', async (near, far) => {
    const input = fixture();
    Object.assign(input.result.camera.depth, { near, far });
    await expectInvalidPlan(input, /Control package: invalid camera depth range/);
  });

  it('rejects an aligned duration override above 5 seconds before reading Blobs or hashing', async () => {
    const input = fixture('mp4', { fps: 60, frameCount: 300, endS: 7 });
    input.result.camera.frames.push({ ...input.result.camera.frames[0]!, t: 5 });
    input.prompts.span.durationS = 301 / 60;
    input.prompts.span.endS = input.prompts.span.startS + 301 / 60;
    for (const video of Object.values(input.result.passes)) {
      video.frames = 301;
      video.seconds = 301 / 60;
    }
    await expectInvalidPlan(input, /Control package: invalid or inconsistent timing/);
  });

  it('is readable by native tar -tf and -xOf without writing extracted paths', async () => {
    const { result, prompts } = fixture();
    const { blob } = await buildControlPackage(result, prompts);
    const dir = await mkdtemp(join(tmpdir(), 'coast-control-package-'));
    const path = join(dir, 'control.tar');
    try {
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      expect(execFileSync('tar', ['-tf', path], { encoding: 'utf8' }).trim().split('\n')).toEqual([
        'beauty.mp4',
        'depth.mp4',
        'pose.mp4',
        'hero.png',
        'camera.json',
        'prompts.json',
        'prompts.txt',
        'package.json',
      ]);
      expect(JSON.parse(execFileSync('tar', ['-xOf', path, 'camera.json'], { encoding: 'utf8' }))).toEqual(result.camera);
      expect(execFileSync('tar', ['-xOf', path, 'prompts.txt'], { encoding: 'utf8' })).toContain('Café — 海岸');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is byte-deterministic and never reads video bytes more than once or calls the network', async () => {
    const { result, prompts } = fixture();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const videoRead = vi.spyOn(result.passes.beauty!.blob, 'arrayBuffer');
    const first = await buildControlPackage(result, prompts);
    expect(videoRead).toHaveBeenCalledTimes(3);
    const second = await buildControlPackage(result, prompts);
    expect(second.manifest).toEqual(first.manifest);
    expect(new Uint8Array(await second.blob.arrayBuffer())).toEqual(new Uint8Array(await first.blob.arrayBuffer()));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('omits previews, capture metadata and URLs, ignoring arbitrary source filenames', async () => {
    const { result, prompts } = fixture();
    Object.assign(result, { url: 'blob:PRIVATE', captures: ['PRIVATE'], filename: '../../PRIVATE' });
    Object.assign(result.camera, { preview: 'PRIVATE', source: 'https://private.example' });
    Object.assign(prompts.context, { url: 'https://private.example', captures: ['PRIVATE'] });
    prompts.prompt += ' https://private.example?token=PRIVATE';
    const { blob } = await buildControlPackage(result, prompts);
    const entries = parseTar(await blob.arrayBuffer());
    const allMetadata = ['camera.json', 'prompts.json', 'prompts.txt', 'package.json']
      .map((name) => new TextDecoder().decode(entries.get(name)!))
      .join('\n');
    expect(allMetadata).not.toMatch(/PRIVATE|private\.example|https:|blob:|data:image|captures|preview/);
    expect(allMetadata).toContain('hero.png');
  });

  it('supports partial pass sets without inventing missing videos', async () => {
    const { result, prompts } = fixture();
    delete result.passes.depth;
    delete result.passes.pose;
    const { manifest } = await buildControlPackage(result, prompts);
    expect(manifest.files.map((file) => file.name)).toEqual(['beauty.mp4', 'hero.png', 'camera.json', 'prompts.json', 'prompts.txt']);
    expect(manifest).not.toHaveProperty('poseSources');
  });

  it.each(['missing crypto', 'digest rejects'])('fails cleanly when %s', async (reason) => {
    const { result, prompts } = fixture();
    vi.stubGlobal(
      'crypto',
      reason === 'missing crypto' ? undefined : { subtle: { digest: vi.fn().mockRejectedValue(new Error('private internal cause')) } },
    );
    await expect(buildControlPackage(result, prompts)).rejects.toThrow(/Control package: SHA-256/);
  });

  it.each([
    'oversize',
    'metadata size',
    'empty',
    'unknown pass',
    'extension',
    'mime',
    'timing',
    'duration',
    'hero frame',
    'hero geometry',
    'hero time',
    'camera clock',
    'nan camera',
  ])('rejects %s before hashing', async (reason) => {
    const { result, prompts } = fixture();
    switch (reason) {
      case 'oversize':
        Object.defineProperty(result.passes.beauty!.blob, 'size', { value: 256 * 1024 * 1024 });
        break;
      case 'metadata size':
        prompts.prompt = 'x'.repeat(65537);
        break;
      case 'empty':
        result.passes = {};
        break;
      case 'unknown pass':
        Object.assign(result.passes, { '../escape': result.passes.beauty });
        break;
      case 'extension':
        Object.assign(result.passes.beauty!, { ext: '../escape' });
        break;
      case 'mime':
        result.passes.beauty!.mime = 'image/png';
        break;
      case 'timing':
        result.passes.beauty!.frames++;
        break;
      case 'duration':
        prompts.span.durationS = 6;
        break;
      case 'hero frame':
        result.hero.frame = 1;
        break;
      case 'hero geometry':
        result.hero.width++;
        break;
      case 'hero time':
        result.hero.timeS++;
        break;
      case 'camera clock':
        result.camera.frames[1]!.t = 1;
        break;
      case 'nan camera':
        result.camera.frames[0]!.pos[0] = NaN;
        break;
    }
    const digest = vi.fn();
    vi.stubGlobal('crypto', { subtle: { digest } });
    await expect(buildControlPackage(result, prompts)).rejects.toThrow(/Control package:/);
    expect(digest).not.toHaveBeenCalled();
  });
});
