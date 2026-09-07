import { describe, expect, it } from 'vitest';
import { cameraFrame, cameraJson, planControl } from '../../packages/studio/src/control';
import { buildControlPrompts, type ControlPromptContext } from '../../packages/studio/src/controlPrompts';
import { planCut } from '../../packages/studio/src/export';
import type { TakeSample, TakeV1 } from '../../packages/studio/src/takes';

function sample(t: number, x: number, driving = false): TakeSample {
  return { t, pos: [x, 0, 0], yaw: 0, speed: 0, grounded: true, driving, camPos: [99, 1, 0], camQuat: [0, 0, 0, 1] };
}

function fixture(portrait = false) {
  const plan = planControl(planCut({ durationS: 10, fps: 24, width: portrait ? 1080 : 1920, height: portrait ? 1920 : 1080 }), {
    startS: 2,
    endS: 4,
  });
  const camera = cameraJson(plan);
  camera.frames = Array.from({ length: plan.frameCount }, (_, i) => cameraFrame(plan, i / plan.fps, [0, 1, 3], [0, 0, 0, 1], 50));
  const take: TakeV1 = {
    v: 1,
    id: 'take-1',
    actorId: 'player',
    avatar: { id: 'mannequin', name: 'Default mannequin', color: 0xabcdef },
    cellVersion: '1',
    hz: 30,
    startedAt: 'ignored',
    durationS: 10,
    samples: [sample(0, -100, true), sample(2, 0), sample(4, 0), sample(10, 100, true)],
    worldEdits: [],
  };
  const context: ControlPromptContext = {
    cell: 'pier',
    timePreset: 'blue',
    look: 'clean',
    cameraSource: 'path',
    mission: { id: 'm1', title: 'Desired sunset hop' },
  };
  return { plan, camera, takes: [take], context };
}

function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

describe('control prompt drafting (GEN-2, STU-2)', () => {
  it('is deterministic, JSON serializable, snapshot-only and does not mutate frozen inputs', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    freeze(input);
    const bundle = buildControlPrompts(input);
    expect(buildControlPrompts(input)).toEqual(bundle);
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
    expect(JSON.stringify(input)).toBe(before);
    expect(bundle).toMatchObject({
      v: 1,
      kind: 'coast-control-prompts',
      span: { startS: 2, endS: 4, durationS: 2 },
      references: { hero: 'hero.png', camera: 'camera.json' },
    });
    expect(bundle.context).not.toBe(input.context);
    expect(bundle.context.mission).not.toBe(input.context.mission);
    expect(bundle.subjects[0]?.avatar).not.toBe(input.takes[0]?.avatar);
    expect(bundle.subjects[0]).toMatchObject({
      takeId: 'take-1',
      actorId: 'player',
      name: 'Default mannequin',
      avatar: { id: 'mannequin', name: 'Default mannequin', color: 0xabcdef },
    });
    expect(bundle.prompt).toContain('mannequin proxy');
    expect(bundle.prompt).toContain('first captured frame');
    expect(bundle.prompt).toContain('single continuous shot');
  });

  it('describes only the subspan, not driving or motion elsewhere in the take', () => {
    const bundle = buildControlPrompts(fixture());
    expect(bundle.subjects[0]).toMatchObject({ motion: 'stationary', driving: 'none', travel_m: 0 });
    expect(bundle.prompt).toContain('stationary root position');
    expect(bundle.prompt).not.toContain('at the wheel');
    const input = fixture();
    input.takes[0]!.samples = [sample(0, 0, true), sample(10, 10, true)];
    const moving = buildControlPrompts(input);
    expect(moving.subjects[0]).toMatchObject({ motion: 'moving', driving: 'throughout' });
    expect(moving.subjects[0]!.travel_m).toBeCloseTo(47 / 24);
    expect(moving.prompt).toContain('at the wheel');
  });

  it('uses actual portrait dimensions and duration without model duration rounding', () => {
    const input = fixture(true);
    const bundle = buildControlPrompts(input);
    expect(bundle.prompt).toContain('9:16 portrait');
    expect(bundle.prompt).toContain('720x1280');
    expect(bundle.prompt).toContain('2 seconds');
    expect(bundle.prompt).toContain('24 fps');
  });

  it('uses current look and time, never desired mission state as visual facts', () => {
    const input = fixture();
    Object.assign(input.context.mission!, { look: 'noir', constraints: [{ kind: 'timePreset', is: 'golden' }] });
    const bundle = buildControlPrompts(input);
    expect(bundle.prompt).toContain('current look: clean');
    expect(bundle.prompt).toContain('time preset: blue');
    expect(bundle.prompt).not.toMatch(/sunset|hop|golden|noir/);
    expect(bundle.context.mission).toEqual({ id: 'm1', title: 'Desired sunset hop' });
  });

  it('selects safe metadata fields and normalizes bounded labels without leaking URLs or credentials', () => {
    const input = fixture();
    const privateValue = 'https://private.example/asset?token=secret-token';
    Object.assign(input.context, { source: privateValue, apiKey: 'secret-token' });
    Object.assign(input.takes[0]!, { source: privateValue });
    Object.assign(input.takes[0]!.avatar!, { source: privateValue, url: privateValue, token: 'secret-token' });
    input.context.cell = `  pier\n  boardwalk ${privateValue} `;
    input.context.subject = 'x'.repeat(1000);
    const bundle = buildControlPrompts(input);
    const json = JSON.stringify(bundle);
    expect(json).not.toMatch(/https:|private\.example|secret-token|apiKey|"url"/);
    expect(bundle.context.cell).toContain('pier boardwalk');
    expect(bundle.context.subject!.length).toBeLessThanOrEqual(120);
  });

  it('preserves an imported single-word GLB filename as a readable avatar label', () => {
    const input = fixture();
    input.takes[0]!.avatar!.name = 'character.glb';
    const bundle = buildControlPrompts(input);
    expect(bundle.subjects[0]!.name).toBe('character glb');
    expect(bundle.subjects[0]!.avatar!.name).toBe('character glb');
    expect(bundle.prompt).toContain('character glb');
  });

  it('redacts GLB query URLs and common credentials without consuming an adjacent filename', () => {
    const input = fixture();
    input.takes[0]!.avatar!.name = 'character.glb https://private.example/character.glb?signature=private-query';
    input.context.subject = 'character.glb private.example/character.glb?signature=private-bare token=private-token sk-private-key';
    const bundle = buildControlPrompts(input);
    expect(bundle.subjects[0]!.name).toBe('character glb');
    expect(bundle.context.subject).toBe('character glb');
    expect(JSON.stringify(bundle)).not.toMatch(/https:|private|signature|token=/);
  });

  it('accepts a zero near plane and exact control limits', () => {
    const input = fixture();
    Object.assign(input.plan, { near: 0, fps: 60, endS: 7, frameCount: 300, width: 1280, height: 720 });
    input.camera = cameraJson(input.plan);
    input.camera.frames = Array.from({ length: input.plan.frameCount }, (_, i) =>
      cameraFrame(input.plan, i / input.plan.fps, [0, 1, 3], [0, 0, 0, 1], 50),
    );
    expect(buildControlPrompts(input).span.durationS).toBe(5);
  });

  it.each([
    { width: 1282 },
    { height: 722 },
    { width: 721, height: 1280 },
    { width: 1 },
    { height: 719 },
    { fps: 61 },
    { endS: 8 },
    { near: -0.1 },
  ])('rejects raw plans outside control bounds even with matching cameras: %j', (overrides) => {
    const input = fixture();
    Object.assign(input.plan, overrides);
    input.plan.frameCount = (input.plan.endS - input.plan.startS) * input.plan.fps;
    input.camera = cameraJson(input.plan);
    input.camera.frames = Array.from({ length: input.plan.frameCount }, (_, i) =>
      cameraFrame(input.plan, i / input.plan.fps, [0, 1, 3], [0, 0, 0, 1], 50),
    );
    expect(() => buildControlPrompts(input)).toThrow(/Control prompts: plan/);
  });

  it('summarizes actual rendered camera travel, rotation and FOV, not take camera or selected source alone', () => {
    const input = fixture();
    expect(buildControlPrompts(input).cameraSummary).toMatchObject({
      source: 'path',
      motion: 'stationary',
      travel_m: 0,
      fovDeg: { min: 50, max: 50 },
    });
    input.camera.frames.forEach((frame, i) => {
      frame.pos[0] = i / 10;
    });
    const moving = buildControlPrompts(input);
    expect(moving.cameraSummary).toMatchObject({ source: 'path', motion: 'moving', travel_m: 4.7 });
    expect(moving.prompt).toContain('camera translates');
    input.camera.frames.forEach((frame, i) => {
      frame.pos[0] = 0;
      frame.quat = [0, Math.sin(i / 100), 0, Math.cos(i / 100)];
    });
    expect(buildControlPrompts(input).cameraSummary.motion).toBe('rotating');
  });

  it('distinguishes FOV-only reframing and quaternion sign changes from camera travel', () => {
    const input = fixture();
    input.context.cameraSource = 'take';
    input.camera.frames = input.camera.frames.map((frame, i) =>
      cameraFrame(input.plan, frame.t, frame.pos, [0, 0, 0, i % 2 ? -1 : 1], 40 + i),
    );
    expect(buildControlPrompts(input).cameraSummary).toMatchObject({
      source: 'take',
      motion: 'reframing',
      travel_m: 0,
      rotationDeg: 0,
      fovDeg: { min: 40, max: 87 },
    });
  });

  it('snapshots multiple subjects independently and detects partial driving without guessing a gait', () => {
    const input = fixture();
    const second = structuredClone(input.takes[0]!);
    second.id = 'take-2';
    second.actorId = 'npc';
    delete second.avatar;
    second.samples = [sample(0, 0), sample(3, 3, true), sample(10, 10, true)];
    input.takes.push(second);
    const bundle = buildControlPrompts(input);
    expect(bundle.subjects).toHaveLength(2);
    expect(bundle.subjects[0]).toMatchObject({ motion: 'stationary', driving: 'none' });
    expect(bundle.subjects[1]).toMatchObject({ name: 'npc', motion: 'moving', driving: 'part' });
    expect(bundle.prompt).not.toMatch(/walking|running|dancing/);
  });

  it('keeps common visual facts in every distinct plain-language model draft with adapter caveats', () => {
    const bundle = buildControlPrompts(fixture());
    expect(Object.keys(bundle.variants)).toEqual(['seedance', 'veo', 'kling', 'ltx', 'wan']);
    expect(new Set(Object.values(bundle.variants)).size).toBe(5);
    for (const variant of Object.values(bundle.variants)) {
      expect(variant).toContain(bundle.prompt);
      expect(variant).toContain('conditioning capabilities require adapter verification');
      expect(variant).toContain('Local draft only');
      expect(variant).not.toMatch(/image_url|negative_prompt|@Element|seed=/);
    }
  });

  it('clamps replay sampling to recorded poses for shorter takes without inventing motion', () => {
    const input = fixture();
    input.takes[0]!.durationS = 1;
    input.takes[0]!.samples = [sample(0, 0), sample(1, 5)];
    expect(buildControlPrompts(input).subjects[0]).toMatchObject({ motion: 'stationary', travel_m: 0 });
  });

  it.each([
    'empty takes',
    'empty samples',
    'empty camera',
    'nan plan',
    'bad duration',
    'bad dimensions',
    'bad fps',
    'bad timestamps',
    'nan pose',
    'nan camera',
    'bad quaternion',
    'bad context',
    'bad intrinsics',
    'bad depth',
    'unordered samples',
    'sparse camera',
    'sparse vector',
    'nan avatar',
  ])('rejects %s clearly', (caseName) => {
    const input = fixture();
    switch (caseName) {
      case 'empty takes':
        input.takes = [];
        break;
      case 'empty samples':
        input.takes[0]!.samples = [];
        break;
      case 'empty camera':
        input.camera.frames = [];
        break;
      case 'nan plan':
        input.plan.startS = NaN;
        break;
      case 'bad duration':
        input.plan.endS = input.plan.startS;
        break;
      case 'bad dimensions':
        input.camera.width += 2;
        break;
      case 'bad fps':
        input.camera.fps = 30;
        break;
      case 'bad timestamps':
        input.camera.frames[1]!.t = 1;
        break;
      case 'nan pose':
        input.takes[0]!.samples[1]!.pos[0] = Infinity;
        break;
      case 'nan camera':
        input.camera.frames[1]!.fovDeg = NaN;
        break;
      case 'bad quaternion':
        input.camera.frames[1]!.quat = [0, 0, 0, 0];
        break;
      case 'bad context':
        input.context.look = '';
        break;
      case 'bad intrinsics':
        input.camera.frames[0]!.fx += 10;
        break;
      case 'bad depth':
        input.camera.depth.far += 10;
        break;
      case 'unordered samples':
        input.takes[0]!.samples.reverse();
        break;
      case 'sparse camera':
        delete input.camera.frames[1];
        break;
      case 'sparse vector':
        input.camera.frames[0]!.pos = new Array(3) as [number, number, number];
        break;
      case 'nan avatar':
        input.takes[0]!.avatar!.color = NaN;
        break;
    }
    expect(() => buildControlPrompts(input)).toThrow(/Control prompts:/);
  });
});
