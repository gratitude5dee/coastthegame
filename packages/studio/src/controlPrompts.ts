import {
  CONTROL_MAX_LONG_SIDE,
  CONTROL_MAX_SECONDS,
  CONTROL_MAX_SHORT_SIDE,
  cameraIntrinsics,
  type CameraJson,
  type ControlPlan,
} from './control';
import { TakePlayer, type TakeAvatar, type TakeV1, type Vec3 } from './takes';

export interface ControlPromptContext {
  cell: string;
  timePreset: string;
  look: string;
  cameraSource: 'take' | 'path';
  mission?: { id: string; title: string };
  subject?: string;
}

export type ControlPromptModel = 'seedance' | 'veo' | 'kling' | 'ltx' | 'wan';

export interface ControlPromptSubject {
  takeId: string;
  actorId: string;
  name: string;
  avatar?: TakeAvatar;
  motion: 'stationary' | 'moving';
  driving: 'none' | 'throughout' | 'part';
  travel_m: number;
  startPosition_m: Vec3;
  endPosition_m: Vec3;
}

export interface ControlPromptBundle {
  v: 1;
  kind: 'coast-control-prompts';
  span: { startS: number; endS: number; durationS: number };
  context: ControlPromptContext;
  prompt: string;
  variants: Record<ControlPromptModel, string>;
  references: { hero: 'hero.png'; camera: 'camera.json' };
  subjects: ControlPromptSubject[];
  cameraSummary: {
    source: 'take' | 'path';
    motion: 'stationary' | 'moving' | 'rotating' | 'reframing';
    travel_m: number;
    rotationDeg: number;
    fovDeg: { min: number; max: number };
  };
}

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Control prompts: ${message}`);
}

function finite(value: number, field: string): number {
  requireValid(typeof value === 'number' && Number.isFinite(value), `${field} must be finite`);
  return value;
}

function vector(value: number[], length: number, field: string): void {
  requireValid(Array.isArray(value) && value.length === length, `${field} must have ${length} components`);
  for (const n of value) finite(n, field);
  if (length === 4) requireValid(Math.abs(Math.hypot(...value) - 1) < 0.001, `${field} must be a unit quaternion`);
}

function label(value: string, field: string): string {
  requireValid(typeof value === 'string', `${field} must be a label`);
  const safe = value
    .normalize('NFKC')
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\/\/)[^\s]+/gi, ' ')
    .replace(/\b(?:data|blob|file):[^\s]+/gi, ' ')
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, ' ')
    .replace(/\b(?:sk|pk|sk_live|sk_test)-[a-z0-9_-]+\b/gi, ' ')
    .replace(/\S*\b[a-z0-9-]+\.(?:[a-z]{2,})(?:[/?#]\S*)?/gi, (token) =>
      /^[\p{L}\p{N}_-]+\.glb$/iu.test(token) ? token.replace('.', ' ') : ' ',
    )
    .replace(/[^\p{L}\p{N}\s$#_'(),-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
  requireValid(safe.length > 0, `${field} must contain a nonempty safe label`);
  return safe;
}

function rounded(value: number): number {
  return Number(finite(value, 'computed summary').toFixed(6));
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function validateCamera(plan: ControlPlan, camera: CameraJson): void {
  requireValid(plan && camera, 'plan and camera are required');
  for (const key of ['fps', 'width', 'height', 'startS', 'endS', 'frameCount', 'near', 'far'] as const) finite(plan[key], `plan.${key}`);
  requireValid(
    plan.fps > 0 && plan.fps <= 60 && plan.startS >= 0 && plan.endS > plan.startS,
    'plan must have a positive span and fps no greater than 60',
  );
  requireValid(plan.endS - plan.startS <= CONTROL_MAX_SECONDS, `plan span must not exceed ${CONTROL_MAX_SECONDS} seconds`);
  requireValid(Number.isSafeInteger(plan.frameCount) && plan.frameCount > 0, 'plan.frameCount must be a positive integer');
  requireValid(
    [plan.width, plan.height].every((n) => Number.isSafeInteger(n) && n >= 2 && n % 2 === 0),
    'plan dimensions must be even integers at least 2',
  );
  requireValid(
    Math.min(plan.width, plan.height) <= CONTROL_MAX_SHORT_SIDE && Math.max(plan.width, plan.height) <= CONTROL_MAX_LONG_SIDE,
    `plan dimensions must not exceed short side ${CONTROL_MAX_SHORT_SIDE} and long side ${CONTROL_MAX_LONG_SIDE}`,
  );
  requireValid(
    Math.abs((plan.endS - plan.startS) * plan.fps - plan.frameCount) < 0.00001,
    'plan duration must align with frameCount and fps',
  );
  requireValid(plan.near >= 0 && plan.far > plan.near, 'plan depth range must be nonnegative and ordered');
  requireValid(
    camera.v === 1 && camera.width === plan.width && camera.height === plan.height && camera.fps === plan.fps,
    'camera dimensions, fps and version must align with plan',
  );
  requireValid(
    camera.depth?.encoding === 'linear-near-white' && camera.depth.near === plan.near && camera.depth.far === plan.far,
    'camera depth must align with plan',
  );
  requireValid(Array.isArray(camera.frames) && camera.frames.length === plan.frameCount, 'camera frames must match planned frameCount');
  for (const [i, frame] of camera.frames.entries()) {
    requireValid(frame && typeof frame === 'object', `camera frame ${i} is required`);
    requireValid(
      Math.abs(finite(frame.t, `camera frame ${i} timestamp`) - i / plan.fps) < 0.000001,
      'camera timestamps must be span-relative and align with planned frames',
    );
    vector(frame.pos, 3, 'camera position');
    vector(frame.quat, 4, 'camera quaternion');
    requireValid(finite(frame.fovDeg, 'camera FOV') > 0 && frame.fovDeg < 180, 'camera FOV must be between 0 and 180 degrees');
    const intrinsics = cameraIntrinsics(frame.fovDeg, plan.width, plan.height);
    for (const key of ['fx', 'fy', 'cx', 'cy'] as const) {
      requireValid(
        Math.abs(finite(frame[key], `camera ${key}`) - intrinsics[key]) < 0.00001,
        'camera intrinsics must align with dimensions and FOV',
      );
    }
  }
}

function snapshotSubject(take: TakeV1, times: number[]): ControlPromptSubject {
  requireValid(take && take.v === 1, 'take must be v1');
  requireValid(finite(take.durationS, 'take duration') >= 0 && finite(take.hz, 'take hz') > 0, 'take duration and hz must be valid');
  requireValid(Array.isArray(take.samples) && take.samples.length > 0, 'take samples must not be empty');
  let previousTime = -1;
  for (const sample of take.samples) {
    requireValid(sample && typeof sample === 'object', 'take sample is required');
    requireValid(
      finite(sample.t, 'sample time') >= 0 && sample.t > previousTime && sample.t <= take.durationS + 0.00001,
      'sample times must be ordered and within take duration',
    );
    previousTime = sample.t;
    vector(sample.pos, 3, 'sample position');
    vector(sample.camPos, 3, 'sample camera position');
    vector(sample.camQuat, 4, 'sample camera quaternion');
    finite(sample.yaw, 'sample yaw');
    finite(sample.speed, 'sample speed');
    requireValid(
      typeof sample.driving === 'boolean' && typeof sample.grounded === 'boolean',
      'sample driving and grounded must be boolean',
    );
  }
  const actorId = label(take.actorId, 'actor ID');
  let avatar: TakeAvatar | undefined;
  if (take.avatar !== undefined) {
    requireValid(take.avatar && typeof take.avatar === 'object', 'avatar must be metadata');
    avatar = { id: label(take.avatar.id, 'avatar ID'), name: label(take.avatar.name, 'avatar name') };
    if (take.avatar.color !== undefined) {
      requireValid(
        Number.isInteger(finite(take.avatar.color, 'avatar color')) && take.avatar.color >= 0 && take.avatar.color <= 0xffffff,
        'avatar color must be a 24-bit color',
      );
      avatar.color = take.avatar.color;
    }
  }
  const player = new TakePlayer({ ...take, worldEdits: [], props: [] });
  const poses = times.map((t) => player.poseAt(Math.min(take.durationS, Math.max(0, t))));
  let travel = 0;
  let drivingFrames = 0;
  poses.forEach((pose, i) => {
    if (i > 0) travel += distance(poses[i - 1]!.pos, pose.pos);
    if (pose.driving) drivingFrames++;
  });
  return {
    takeId: label(take.id, 'take ID'),
    actorId,
    name: avatar?.name ?? actorId,
    ...(avatar ? { avatar } : {}),
    motion: travel > 0.001 ? 'moving' : 'stationary',
    driving: drivingFrames === 0 ? 'none' : drivingFrames === poses.length ? 'throughout' : 'part',
    travel_m: rounded(travel),
    startPosition_m: poses[0]!.pos.map(rounded) as Vec3,
    endPosition_m: poses[poses.length - 1]!.pos.map(rounded) as Vec3,
  };
}

function aspect(width: number, height: number): string {
  let a = width;
  let b = height;
  while (b) [a, b] = [b, a % b];
  return `${width / a}:${height / a} ${height > width ? 'portrait' : width > height ? 'landscape' : 'square'}`;
}

export function buildControlPrompts(input: {
  plan: ControlPlan;
  camera: CameraJson;
  takes: TakeV1[];
  context: ControlPromptContext;
}): ControlPromptBundle {
  requireValid(input && typeof input === 'object', 'input is required');
  const { plan, camera, takes, context: raw } = input;
  validateCamera(plan, camera);
  requireValid(Array.isArray(takes) && takes.length > 0, 'takes must not be empty');
  requireValid(raw && (raw.cameraSource === 'take' || raw.cameraSource === 'path'), 'context cameraSource must be take or path');
  const context: ControlPromptContext = {
    cell: label(raw.cell, 'cell'),
    timePreset: label(raw.timePreset, 'time preset'),
    look: label(raw.look, 'look'),
    cameraSource: raw.cameraSource,
  };
  if (raw.mission !== undefined) {
    requireValid(raw.mission && typeof raw.mission === 'object', 'mission must be metadata');
    context.mission = { id: label(raw.mission.id, 'mission ID'), title: label(raw.mission.title, 'mission title') };
  }
  if (raw.subject !== undefined) context.subject = label(raw.subject, 'subject');
  const times = camera.frames.map((frame) => plan.startS + frame.t);
  const subjects = Array.from(takes, (take) => snapshotSubject(take, times));
  let travel = 0;
  let rotation = 0;
  let minFov = Infinity;
  let maxFov = -Infinity;
  camera.frames.forEach((frame, i) => {
    minFov = Math.min(minFov, frame.fovDeg);
    maxFov = Math.max(maxFov, frame.fovDeg);
    if (i === 0) return;
    const previous = camera.frames[i - 1]!;
    travel += distance(previous.pos, frame.pos);
    const dot =
      frame.quat.reduce((sum, n, j) => sum + n * previous.quat[j]!, 0) / (Math.hypot(...frame.quat) * Math.hypot(...previous.quat));
    rotation += (2 * Math.acos(Math.min(1, Math.abs(dot))) * 180) / Math.PI;
  });
  const cameraSummary: ControlPromptBundle['cameraSummary'] = {
    source: context.cameraSource,
    motion: travel > 0.001 ? 'moving' : rotation > 0.1 ? 'rotating' : maxFov - minFov > 0.001 ? 'reframing' : 'stationary',
    travel_m: rounded(travel),
    rotationDeg: rounded(rotation),
    fovDeg: { min: rounded(minFov), max: rounded(maxFov) },
  };
  const span = { startS: plan.startS, endS: plan.endS, durationS: plan.endS - plan.startS };
  const blocking = subjects
    .map((subject) => {
      const identity =
        subject.avatar?.id.toLowerCase() === 'mannequin'
          ? `${subject.name} (default mannequin proxy, not a finished character)`
          : subject.name;
      const motion = subject.motion === 'moving' ? `root moves ${subject.travel_m} m` : 'stationary root position';
      const driving =
        subject.driving === 'none'
          ? ''
          : `; recorded at the wheel of the lowrider ${subject.driving === 'throughout' ? 'throughout sampled frames' : 'during part of the sampled frames'}`;
      return `${identity} [actor ${subject.actorId}, take ${subject.takeId}]: ${motion}, from (${subject.startPosition_m.join(', ')}) to (${subject.endPosition_m.join(', ')}) m${driving}.`;
    })
    .join(' ');
  const cameraMotion =
    cameraSummary.motion === 'moving'
      ? 'camera translates'
      : cameraSummary.motion === 'rotating'
        ? 'camera rotates in place'
        : cameraSummary.motion === 'reframing'
          ? 'camera stays in place with changing FOV'
          : 'stationary camera position, orientation and FOV';
  const prompt = [
    `A single continuous shot, no cuts or time jumps, lasting ${rounded(span.durationS)} seconds at ${plan.fps} fps, ${plan.width}x${plan.height}, ${aspect(plan.width, plan.height)}.`,
    'Continue from hero.png, the first captured frame of this span, not an aesthetically ranked best frame. Preserve reference composition, visible subject identity, scale, spatial relationships and blocking; retain only appearance details visible in the reference, without inventing outfits.',
    `Observed scene context: cell ${context.cell}; time preset: ${context.timePreset}; current look: ${context.look}. Preserve the reference lighting direction, palette, contrast and atmosphere under these current settings, without adding unobserved weather or lights.`,
    ...(context.subject ? [`Observed subject label: ${context.subject}.`] : []),
    `Recorded blocking in this span, world coordinates in metres: ${blocking}`,
    `Sampled ${context.cameraSource} camera: ${cameraMotion}; travel ${cameraSummary.travel_m} m; accumulated rotation ${cameraSummary.rotationDeg} degrees; vertical FOV ${cameraSummary.fovDeg.min} to ${cameraSummary.fovDeg.max} degrees. Follow the sampled framing progression in camera.json without inventing a named camera move.`,
    'Motion summaries use only rendered sample times within this span, with replay held at recorded endpoints. Root poses do not establish full skeletal motion, gait, gestures, outfit details or visibility. Preserve visible action from the references; these summaries do not guarantee full motion accuracy.',
  ].join('\n');
  const caveat =
    'Local draft only, not an API request. Provider conditioning capabilities require adapter verification for the chosen endpoint, including reference images, depth, pose, camera data, duration and aspect support. No support for these inputs is assumed.';
  const variants: Record<ControlPromptModel, string> = {
    seedance: `Seedance draft. Emphasis: first-frame continuity, then the observed camera and blocking progression.\n${prompt}\n${caveat}`,
    veo: `Veo draft. Emphasis: one coherent shot with stable spatial relationships and the current lighting and look.\n${prompt}\n${caveat}`,
    kling: `Kling draft. Emphasis: direct motion statements; let the first frame define static appearance.\n${prompt}\n${caveat}`,
    ltx: `LTX draft. Emphasis: clear subject, setting, action and camera order within the recorded duration.\n${prompt}\n${caveat}`,
    wan: `Wan draft. Emphasis: observed blocking and camera continuity; treat control files as documentation until an adapter verifies conditioning support.\n${prompt}\n${caveat}`,
  };
  return {
    v: 1,
    kind: 'coast-control-prompts',
    span,
    context,
    prompt,
    variants,
    references: { hero: 'hero.png', camera: 'camera.json' },
    subjects,
    cameraSummary,
  };
}
