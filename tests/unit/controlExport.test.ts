import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  cameraFrame,
  projectPoint,
  skeletonFor,
  type ActorPose,
  type ControlPass,
  type ControlPlan,
} from '../../packages/studio/src/control';
import { drawPose, exportControl, type ControlScene } from '../../apps/web/src/studio/control';

const mock = vi.hoisted(() => ({
  events: [] as string[],
  fail: '',
  cleanupFails: [] as string[],
  depth: false,
  codec: 'avc' as string | null,
  sources: [] as { samples: { pixel: string; t: number; dt: number; width: number; height: number }[]; close: ReturnType<typeof vi.fn> }[],
  outputs: [] as { cancel: ReturnType<typeof vi.fn> }[],
}));

function step(name: string) {
  mock.events.push(name);
  if (mock.fail === name) {
    mock.fail = '';
    throw new Error(name);
  }
  if (mock.cleanupFails.includes(name)) throw new Error(`cleanup:${name}`);
}

vi.mock('../../apps/web/src/studio/exporter', () => ({
  loadMediabunny: vi.fn(async () => ({
    getFirstEncodableVideoCodec: vi.fn(async () => {
      step('codec');
      return mock.codec;
    }),
    QUALITY_HIGH: 1,
    Mp4OutputFormat: class {},
    WebMOutputFormat: class {},
    BufferTarget: class {
      buffer = new ArrayBuffer(4);
    },
    Output: class {
      cancel = vi.fn(async () => {
        step('cancel');
      });
      constructor() {
        mock.outputs.push(this);
      }
      addVideoTrack() {
        step('track');
      }
      async start() {
        step('start');
      }
      async finalize() {
        step('finalize');
      }
      async getMimeType() {
        return mock.codec === 'vp8' ? 'video/webm' : 'video/mp4';
      }
    },
    CanvasSource: class {
      samples: { pixel: string; t: number; dt: number; width: number; height: number }[] = [];
      close = vi.fn(() => {
        step('close');
      });
      constructor(private canvas: { pixel: string; width: number; height: number }) {
        step('source');
        mock.sources.push(this);
      }
      async add(t: number, dt: number) {
        step('add');
        this.samples.push({ pixel: this.canvas.pixel, t, dt, width: this.canvas.width, height: this.canvas.height });
      }
    },
  })),
}));

vi.mock('@coast/engine', () => ({
  DepthPass: class {
    setRange() {
      step('depth.range');
    }
    apply() {
      mock.depth = true;
      step('depth.apply');
    }
    frame() {
      step('depth.frame');
    }
    restore() {
      mock.depth = false;
      step('depth.restore');
    }
    dispose() {
      step('depth.dispose');
    }
  },
}));

const plan: ControlPlan = { fps: 30, width: 1280, height: 720, startS: 3, endS: 3.1, frameCount: 3, near: 0.25, far: 60 };

function poseContext() {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  };
}

function fixture() {
  const size = new THREE.Vector2(900, 600);
  let dpr = 2;
  let time = 0;
  let renders = 0;
  const screen = { pixel: '' };
  const camera = new THREE.PerspectiveCamera(65, 1.5, 0.1, 200);
  camera.position.set(8, 9, 10);
  camera.rotation.set(0.1, 0.2, 0.3);
  const position = camera.position.clone();
  const quaternion = camera.quaternion.clone();
  const renderer = {
    domElement: screen,
    getSize: (v: THREE.Vector2) => v.copy(size),
    getPixelRatio: () => dpr,
    setPixelRatio: (v: number) => {
      dpr = v;
      step('ratio');
    },
    setSize: (w: number, h: number) => {
      size.set(w, h);
      step('size');
    },
    render: vi.fn(() => {
      step(mock.depth ? 'depth.render' : 'direct.render');
      screen.pixel = `${mock.depth ? 'depth' : 'direct'}:${time}`;
    }),
  };
  const target = {
    renderer: renderer as unknown as THREE.WebGLRenderer,
    scene: new THREE.Scene(),
    camera,
    prepare: vi.fn(async () => {
      step('prepare');
    }),
    begin: vi.fn(() => {
      camera.position.set(99, 99, 99);
      step('begin');
    }),
    end: vi.fn(() => {
      step('end');
    }),
    seek: vi.fn((t: number) => {
      time = t;
      camera.position.set(t, 2, 5);
      camera.rotation.set(0, t / 10, 0);
      camera.fov = 50;
      camera.updateProjectionMatrix();
      step(`seek:${t}`);
    }),
    frame: vi.fn(() => {
      step('frame');
    }),
    settle: vi.fn(async () => {
      step(mock.depth ? 'depth.settle' : 'settle');
      camera.position.y = 4;
    }),
    render: vi.fn((_dt?: number) => {
      expect(mock.depth).toBe(false);
      step('beauty.render');
      screen.pixel = `beauty:${time}:${++renders}`;
    }),
    look: () => '35mm-dusk',
    actors: vi.fn((): ActorPose[] => [{ feet: [0, 0, 0], yaw: 0 }]),
  } satisfies ControlScene;
  const canvases: { pixel: string; width: number; height: number }[] = [];
  vi.stubGlobal('document', {
    createElement: vi.fn(() => {
      const canvas = {
        pixel: '',
        width: 0,
        height: 0,
        getContext: () => {
          if (mock.fail === 'context') return null;
          return {
            ...poseContext(),
            drawImage: (source: { pixel: string }) => {
              canvas.pixel = source.pixel;
              step('copy');
            },
            fillRect: () => {
              canvas.pixel = `pose:${time}`;
            },
          };
        },
        toDataURL: () => `data:image/png;${canvas.pixel}`,
        toBlob: (callback: (blob: Blob | null) => void, mime: string) => {
          step('png');
          const pixel = canvas.pixel;
          setTimeout(() => {
            mock.events.push('png.done');
            callback(mock.fail === 'png.null' ? null : new Blob([pixel], { type: mime }));
          }, 0);
        },
      };
      canvases.push(canvas);
      return canvas;
    }),
  });
  const restored = (endCalls = 1) => {
    expect(size.toArray()).toEqual([900, 600]);
    expect(dpr).toBe(2);
    expect(camera.aspect).toBe(1.5);
    expect(camera.fov).toBe(65);
    expect(camera.position).toEqual(position);
    expect(camera.quaternion.toArray()).toEqual(quaternion.toArray());
    expect(mock.depth).toBe(false);
    expect(target.end).toHaveBeenCalledTimes(endCalls);
  };
  return { target, renderer, restored, canvases };
}

beforeEach(() => {
  mock.events = [];
  mock.fail = '';
  mock.cleanupFails = [];
  mock.depth = false;
  mock.codec = 'avc';
  mock.sources = [];
  mock.outputs = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rig-aware pose drawing (STU-2)', () => {
  const cam = cameraFrame(plan, 0, [0, 1, 5], [0, 0, 0, 1], 50);

  it('draws only mapped partial-rig joints and complete limbs without inventing face or elbow landmarks', () => {
    const ctx = poseContext();
    const joints: NonNullable<ActorPose['rigJoints']> = {
      mixamorigNeck: [0, 1.5, 0],
      mixamorigRightArm: [-0.3, 1.4, 0],
      mixamorigRightHand: [-0.8, 0.9, 0],
      mixamorigHead: [0, 1.7, 0],
    };
    const sources = drawPose(
      ctx as unknown as CanvasRenderingContext2D,
      plan,
      cam,
      [{ feet: [99, 99, 99], yaw: 2, height: 12, rigJoints: joints }],
      4,
    );
    expect(sources).toEqual({ unit: 'actor-frame', rig: 1, procedural: 0, omitted: 0 });
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1280, 720);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    expect(ctx.arc).toHaveBeenCalledTimes(3);
    const projected = ['mixamorigNeck', 'mixamorigRightArm', 'mixamorigRightHand'].map((name) => projectPoint(joints[name]!, cam));
    expect(ctx.moveTo).toHaveBeenCalledWith(projected[0]!.x, projected[0]!.y);
    expect(ctx.lineTo).toHaveBeenCalledWith(projected[1]!.x, projected[1]!.y);
    projected.forEach((p, i) => expect(ctx.arc).toHaveBeenNthCalledWith(i + 1, p.x, p.y, 4, 0, Math.PI * 2));
    expect(ctx.strokeStyle).toBe('rgb(255,0,0)');
    expect(ctx.lineWidth).toBe(4);
    expect(ctx.lineCap).toBe('round');
  });

  it.each([null, {}])('leaves known unrigged or unmapped actors black without fallback: %j', (rigJoints) => {
    const ctx = poseContext();
    const sources = drawPose(ctx as unknown as CanvasRenderingContext2D, plan, cam, [{ feet: [0, 0, 0], yaw: 0, rigJoints }], 4);
    expect(sources).toEqual({ unit: 'actor-frame', rig: 0, procedural: 0, omitted: 1 });
    expect(ctx.fillStyle).toBe('#000');
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1280, 720);
    expect(ctx.beginPath).not.toHaveBeenCalled();
    expect(ctx.arc).not.toHaveBeenCalled();
    expect(ctx.stroke).not.toHaveBeenCalled();
  });

  it('counts sources before visibility culling and never connects a limb behind the camera', () => {
    const ctx = poseContext();
    const sources = drawPose(
      ctx as unknown as CanvasRenderingContext2D,
      plan,
      cam,
      [
        { feet: [0, 0, 0], yaw: 0, rigJoints: { mixamorigNeck: [0, 1.5, 0], mixamorigRightArm: [0, 1, 10] } },
        { feet: [0, 0, 0], yaw: 0, rigJoints: { mixamorigNeck: [10000, 1, 0] } },
        { feet: [0, 0, 10], yaw: 0 },
        { feet: [0, 0, 0], yaw: 0, rigJoints: null },
      ],
      4,
    );
    expect(sources).toEqual({ unit: 'actor-frame', rig: 2, procedural: 1, omitted: 1 });
    expect(ctx.arc).toHaveBeenCalledTimes(1);
    expect(ctx.stroke).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, 1.5])('preserves legacy procedural gait time overrides: %s', (t) => {
    const ctx = poseContext();
    const actor: ActorPose = { feet: [0, 0, 0], yaw: 0, speed: 2, t };
    const sources = drawPose(ctx as unknown as CanvasRenderingContext2D, plan, cam, [actor], 4);
    expect(sources).toEqual({ unit: 'actor-frame', rig: 0, procedural: 1, omitted: 0 });
    const projected = skeletonFor({ ...actor, t: t ?? 4 }).map((point) => projectPoint(point, cam));
    expect(ctx.arc).toHaveBeenCalledTimes(18);
    projected.forEach((p, i) => expect(ctx.arc).toHaveBeenNthCalledWith(i + 1, p.x, p.y, 4, 0, Math.PI * 2));
  });
});

describe('control export hero and beauty (STU-2 / GEN-2)', () => {
  it.each([
    ['beauty', 'depth', 'pose'],
    ['depth', 'pose', 'beauty'],
  ] as ControlPass[][])(
    'shares the first postprocessed beauty frame and captures hero before depth: %j',
    async (...passes: ControlPass[]) => {
      const { target, restored } = fixture();
      const progress = vi.fn();
      const result = await exportControl(plan, target, passes, progress, { preview: true });
      expect(result.hero).toMatchObject({ mime: 'image/png', width: 1280, height: 720, timeS: 3, frame: 0 });
      expect(await result.hero.blob.text()).toBe('beauty:3:1');
      expect(result.hero.preview).toBe('data:image/png;beauty:3:1');
      expect(target.render).toHaveBeenCalledTimes(plan.frameCount);
      expect(target.render.mock.calls.every(([dt]) => dt === 1 / plan.fps)).toBe(true);
      const beauty = mock.sources[passes.indexOf('beauty')]!;
      expect(beauty.samples[0]!.pixel).toBe(await result.hero.blob.text());
      for (const source of mock.sources) {
        expect(source.samples.map(({ t, dt }) => [t, dt])).toEqual([
          [0, 1 / 30],
          [1 / 30, 1 / 30],
          [2 / 30, 1 / 30],
        ]);
        expect(source.close).toHaveBeenCalledTimes(1);
      }
      expect(mock.events.indexOf('seek:3')).toBeLessThan(mock.events.indexOf('frame'));
      expect(mock.events.indexOf('frame')).toBeLessThan(mock.events.indexOf('settle'));
      expect(mock.events.indexOf('settle')).toBeLessThan(mock.events.indexOf('beauty.render'));
      expect(mock.events.indexOf('beauty.render')).toBeLessThan(mock.events.indexOf('png'));
      expect(mock.events.indexOf('png.done')).toBeLessThan(mock.events.indexOf('depth.apply'));
      expect(result.poseSources).toEqual({ unit: 'actor-frame', rig: 0, procedural: 3, omitted: 0 });
      expect(target.actors).toHaveBeenCalledTimes(3);
      expect(result.camera.frames).toHaveLength(3);
      expect(result.camera.frames[0]).toMatchObject({ t: 0, pos: [3, 4, 5], fovDeg: 50 });
      expect(result.camera.frames[1]!.t).toBeCloseTo(1 / 30);
      expect(result.preview!.beauty).toBe(`data:image/png;${beauty.samples[2]!.pixel}`);
      expect(progress).toHaveBeenLastCalledWith(9, 9);
      restored();
    },
  );

  it.each(['depth', 'pose'] as ControlPass[])('keeps explicit %s-only exports compatible and includes a hero', async (pass) => {
    const { target, restored } = fixture();
    const result = await exportControl(plan, target, [pass]);
    expect(Object.keys(result.passes)).toEqual([pass]);
    expect(await result.hero.blob.text()).toBe('beauty:3:1');
    expect(result.hero.preview).toBeUndefined();
    expect(result.preview).toBeUndefined();
    if (pass === 'pose') expect(result.poseSources).toEqual({ unit: 'actor-frame', rig: 0, procedural: 3, omitted: 0 });
    else expect(result).not.toHaveProperty('poseSources');
    expect(target.actors).toHaveBeenCalledTimes(pass === 'pose' ? 3 : 0);
    expect(target.render).toHaveBeenCalledTimes(1);
    restored();
  });

  it('keeps portrait dimensions throughout and falls back to a direct beauty render / WebM', async () => {
    const { target, renderer, restored, canvases } = fixture();
    const { render: _render, ...direct } = target;
    mock.codec = 'vp8';
    const result = await exportControl({ ...plan, width: 720, height: 1280 }, direct, ['beauty']);
    expect(await result.hero.blob.text()).toBe('direct:3');
    expect(result.hero).toMatchObject({ width: 720, height: 1280 });
    expect(result.camera).toMatchObject({ width: 720, height: 1280 });
    expect(result.passes.beauty).toMatchObject({ mime: 'video/webm', ext: 'webm', frames: 3, seconds: 0.1 });
    expect(result).not.toHaveProperty('poseSources');
    expect(target.actors).not.toHaveBeenCalled();
    expect(canvases.every((c) => c.width === 720 && c.height === 1280)).toBe(true);
    expect(mock.sources[0]!.samples.every((s) => s.width === 720 && s.height === 1280)).toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(3);
    restored();
  });

  it('aggregates each pose actor-frame once across changing actor lists, including offscreen sources', async () => {
    const { target, restored } = fixture();
    const rig: ActorPose = { feet: [0, 0, 0], yaw: 0, rigJoints: { mixamorigNeck: [10000, 1, 0] } };
    const omitted: ActorPose = { feet: [0, 0, 0], yaw: 0, rigJoints: null };
    target.actors
      .mockReturnValueOnce([rig, { feet: [0, 0, 0], yaw: 0 }, omitted])
      .mockReturnValueOnce([rig])
      .mockReturnValueOnce([omitted, omitted]);
    const result = await exportControl(plan, target, ['beauty', 'depth', 'pose']);
    expect(result.poseSources).toEqual({ unit: 'actor-frame', rig: 2, procedural: 1, omitted: 3 });
    expect(target.actors).toHaveBeenCalledTimes(plan.frameCount);
    expect(await result.hero.blob.text()).toBe('beauty:3:1');
    expect(mock.sources[0]!.samples[0]!.pixel).toBe(await result.hero.blob.text());
    restored();
  });

  it('reports zero actor-frame counts for an empty pose pass', async () => {
    const { target, restored } = fixture();
    target.actors.mockReturnValue([]);
    const result = await exportControl(plan, target, ['pose']);
    expect(result.poseSources).toEqual({ unit: 'actor-frame', rig: 0, procedural: 0, omitted: 0 });
    restored();
  });

  it.each([
    'begin',
    'ratio',
    'size',
    'context',
    'png',
    'png.null',
    'source',
    'track',
    'start',
    'add',
    'finalize',
    'settle',
    'beauty.render',
    'depth.apply',
    'depth.settle',
    'depth.render',
  ])('restores state and closes/cancels allocated encoders after %s failure', async (failure) => {
    const { target, restored } = fixture();
    mock.fail = failure;
    await expect(exportControl(plan, target, ['depth'])).rejects.toThrow();
    restored();
    for (const source of mock.sources) expect(source.close).toHaveBeenCalledTimes(1);
    for (const output of mock.outputs) expect(output.cancel).toHaveBeenCalledTimes(1);
  });

  it('restores preparation mutations without ending a host whose begin was never invoked', async () => {
    const { target, restored } = fixture();
    target.prepare.mockImplementation(async () => {
      target.renderer.setSize(4, 6, false);
      target.camera.position.set(20, 30, 40);
      target.camera.fov = 40;
      throw new Error('prepare');
    });
    await expect(exportControl(plan, target, ['beauty'])).rejects.toThrow('prepare');
    expect(target.begin).not.toHaveBeenCalled();
    restored(0);
  });

  it.each(['cancel', 'close', 'depth.restore', 'depth.dispose'])(
    'still restores the host and preserves the encoding error when %s cleanup also fails',
    async (cleanupFailure) => {
      const { target, restored } = fixture();
      mock.fail = 'add';
      mock.cleanupFails = [cleanupFailure];
      await expect(exportControl(plan, target, ['depth'])).rejects.toThrow('add');
      restored();
      expect(mock.sources[0]!.close).toHaveBeenCalledTimes(1);
      expect(mock.outputs[0]!.cancel).toHaveBeenCalledTimes(1);
    },
  );

  it('captures one frame at an absolute nonzero 24fps time without any duplicate beauty render', async () => {
    const { target, restored } = fixture();
    const single = { ...plan, fps: 24, frameCount: 1, startS: 7, endS: 7 + 1 / 24 };
    const result = await exportControl(single, target, ['pose', 'depth', 'beauty']);
    expect(result.hero.timeS).toBe(7);
    expect(await result.hero.blob.text()).toBe('beauty:7:1');
    expect(result.camera.frames).toHaveLength(1);
    expect(result.camera.frames[0]!.t).toBe(0);
    expect(target.render).toHaveBeenCalledTimes(1);
    expect(target.render).toHaveBeenCalledWith(1 / 24);
    expect(mock.sources.every((s) => s.samples.length === 1 && s.samples[0]!.t === 0 && s.samples[0]!.dt === 1 / 24)).toBe(true);
    restored();
  });

  it.each(['codec', 'unavailable'])('leaves the host untouched on %s failure', async (failure) => {
    const { target } = fixture();
    if (failure === 'codec') mock.fail = 'codec';
    else mock.codec = null;
    await expect(exportControl(plan, target, ['depth'])).rejects.toThrow();
    expect(target.begin).not.toHaveBeenCalled();
    expect(target.end).not.toHaveBeenCalled();
    expect(target.camera.position.toArray()).toEqual([8, 9, 10]);
    expect(mock.outputs).toHaveLength(0);
  });

  it.each([
    { fps: 0 },
    { fps: NaN },
    { fps: Infinity },
    { fps: 120, frameCount: 12 },
    { endS: 9, frameCount: 180 },
    { endS: 8 + 1 / 30, frameCount: 151 },
    { width: 1282 },
    { height: 722 },
    { width: 720, height: 1282 },
    { width: 722, height: 1280 },
    { width: 1e12, height: 2 },
    { width: 0 },
    { height: 1.5 },
    { width: 1279 },
    { frameCount: -1 },
    { frameCount: 1.5 },
    { frameCount: 0 },
    { startS: NaN },
    { startS: -1 },
    { endS: Infinity },
    { endS: 2 },
    { endS: 4 },
    { near: -1 },
    { far: 0.25 },
    { far: NaN },
  ])('rejects malformed plans before codec/host work: %j', async (bad) => {
    const { target } = fixture();
    await expect(exportControl({ ...plan, ...bad }, target, ['depth'])).rejects.toThrow();
    expect(mock.events).toEqual([]);
    expect(document.createElement).not.toHaveBeenCalled();
    expect(mock.outputs).toHaveLength(0);
  });

  it.each([[], ['depth', 'depth'], ['normal'], ['wat'], Array<string>(1)].map((passes) => ({ passes })))(
    'rejects empty, duplicate or invalid passes: $passes',
    async ({ passes }) => {
      const { target } = fixture();
      await expect(exportControl(plan, target, passes as ControlPass[])).rejects.toThrow();
      expect(mock.events).toEqual([]);
    },
  );
});
