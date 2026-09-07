/**
 * Scene-op tool schema for the voice director (goal.md DIR-2, CAM-8).
 * These TypeScript types are the source of truth; `toRealtimeTools(mode)` emits the JSON-schema function tools
 * handed to the OpenAI Realtime session (`session.update({ tools })`) — only the active mode's tools are exposed.
 *
 * Design rules:
 *  - query tools vs act tools; every act returns `{ ok, affected, preview_thumb?, confidence, question? }`.
 *  - The model NEVER supplies timestamps or ids it invents: acts are keyed by the Realtime `call_id`; deictic
 *    references carry only the word and its ordinal within the utterance. The client attaches the speech window
 *    (`{startMs,endMs}` from PTT press/release or `input_audio_buffer.speech_started/stopped`) — see deixis.ts.
 *  - JSON schema uses `anyOf` + `$defs` (no `oneOf`, no recursion); the client validates with zod before executing.
 */

export type RigMode = 'actor' | 'director' | 'producer';

export type DeicticWord = 'that' | 'this' | 'it';
export type DeicticPlaceWord = 'there' | 'here';

export type ObjectRef =
  { id: string } | { deictic: DeicticWord; ordinal?: number } | { desc: string; near?: { id: string } | { desc: string } };

export type Relation = 'left' | 'right' | 'behind' | 'in_front' | 'on_top' | 'inside' | 'next_to';

export type PlaceRef =
  | { pos: [number, number, number] }
  | { deictic: DeicticPlaceWord; ordinal?: number }
  | { relative: { to: ObjectRef; rel: Relation; distance_m?: number } };

export type ShotName = 'wide' | 'medium' | 'close' | 'low' | 'high' | 'dutch';
export type CameraMove = 'push_in' | 'pull_out' | 'orbit' | 'crane_up' | 'crane_down' | 'dolly_left' | 'dolly_right';
/** Keyframed paths (CAM-7): drop a key where the camera is, play the path (locked shot), stop / hand back, clear, drop the last key. */
export type CameraPathOp = 'key' | 'play' | 'stop' | 'clear' | 'undo_key';

/** The looks a mission names (MIS-6): the post LUT on the picture, live and in the cut (`packages/engine/src/render/looks.ts`). */
export type LookName = 'clean' | '35mm-dusk' | 'vhs-1994' | 'noir' | 'neon-night';
export const LOOK_NAMES: readonly LookName[] = ['clean', '35mm-dusk', 'vhs-1994', 'noir', 'neon-night'];

export type SceneAct =
  | { op: 'spawn'; asset?: string; prompt?: string; place: PlaceRef; scale?: number; tags?: string[] }
  | { op: 'move'; obj: ObjectRef; place: PlaceRef; animate_ms?: number }
  | { op: 'rotate'; obj: ObjectRef; yaw_deg?: number; face?: ObjectRef }
  | { op: 'scale'; obj: ObjectRef; factor?: number; size_m?: number }
  | { op: 'delete'; obj: ObjectRef }
  | { op: 'set_material'; obj: ObjectRef; color?: string; preset?: string; prompt?: string }
  | { op: 'group'; objs: ObjectRef[]; name?: string }
  | { op: 'ungroup'; obj: ObjectRef }
  | { op: 'set_time'; preset?: 'golden' | 'blue' | 'night' | 'fog_noon'; hour?: number }
  | { op: 'set_weather'; kind: 'fog' | 'clear' | 'rain'; amount?: number }
  | { op: 'set_look'; preset: LookName }
  | { op: 'loadout'; outfit?: string; pattern?: string }
  | { op: 'play_anim'; actor: ObjectRef; clip: string; loop?: boolean }
  | { op: 'possess'; actor: ObjectRef }
  | { op: 'replay_take'; take: string; actor: ObjectRef }
  | {
      op: 'camera';
      shot?: ShotName;
      follow?: ObjectRef;
      move?: CameraMove;
      duration_ms?: number;
      lens_mm?: number;
      look_at?: ObjectRef;
      path?: CameraPathOp;
      /** With `path: 'play'`: play the path over this many seconds (re-timed) and whether it loops. */
      path_seconds?: number;
      loop?: boolean;
    }
  | { op: 'record'; action: 'start' | 'stop' }
  | { op: 'mark_beat'; label: string }
  | { op: 'undo'; n?: number }
  | { op: 'set_mode'; mode: RigMode };

/** What the client wraps around every tool call before execution (DIR-1/DIR-3). */
export interface ActEnvelope {
  callId: string; // Realtime function call id — idempotency key
  mode: RigMode; // mode active when the utterance started
  speech: { startMs: number; endMs: number }; // client-stamped speech window
  deicticTotal: number; // number of deictic words (that/this/it/there/here) in the transcript, counted by the client
  act: SceneAct;
}

export interface ActResult {
  ok: boolean;
  affected: string[];
  preview_thumb?: string; // tiny data URL
  confidence: number; // 0..1 — gates ghost preview / confirmation (DIR-3)
  question?: string; // one-word clarification if ambiguous
  error?: string;
}

/** Tool → modes that expose it (CAM-8). Queries are always available. */
export const TOOL_MODES: Record<string, RigMode[]> = {
  query_scene: ['actor', 'director', 'producer'],
  resolve_ref: ['actor', 'director', 'producer'],
  get_shot_state: ['actor', 'director', 'producer'],
  list_assets: ['director', 'producer'],
  // producer — world state
  spawn: ['producer', 'director'], // director may say "put that there": runtime hops to producer for the act (CAM-8)
  move: ['producer', 'director'],
  rotate: ['producer', 'director'],
  scale: ['producer'],
  delete: ['producer'],
  set_material: ['producer'],
  group: ['producer'],
  ungroup: ['producer'],
  set_time: ['producer', 'director'],
  set_weather: ['producer', 'director'],
  set_look: ['producer', 'director'],
  loadout: ['actor', 'director', 'producer'], // "wear the gold fit", "three-wheel motion" — the reel's unlocks (MIS-4)
  // director — camera + performance + record
  play_anim: ['director'],
  possess: ['director', 'producer'],
  replay_take: ['director'],
  camera: ['director'],
  record: ['director'],
  mark_beat: ['director', 'producer'],
  undo: ['director', 'producer'],
  set_mode: ['actor', 'director', 'producer'], // "director" / "actor" / "producer" said out loud (§3.1 step 4)
};

const DEFS = {
  ObjectRef: {
    anyOf: [
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      {
        type: 'object',
        properties: {
          deictic: { enum: ['that', 'this', 'it'] },
          ordinal: {
            type: 'integer',
            minimum: 1,
            description: '1-based position of this word among ALL deictic words (that/this/it/there/here) in the utterance',
          },
        },
        required: ['deictic'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          desc: { type: 'string' },
          near: {
            anyOf: [
              { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
              { type: 'object', properties: { desc: { type: 'string' } }, required: ['desc'], additionalProperties: false },
            ],
          },
        },
        required: ['desc'],
        additionalProperties: false,
      },
    ],
  },
  PlaceRef: {
    anyOf: [
      {
        type: 'object',
        properties: { pos: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } },
        required: ['pos'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          deictic: { enum: ['there', 'here'] },
          ordinal: {
            type: 'integer',
            minimum: 1,
            description: '1-based position of this word among ALL deictic words (that/this/it/there/here) in the utterance',
          },
        },
        required: ['deictic'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          relative: {
            type: 'object',
            properties: {
              to: { $ref: '#/$defs/ObjectRef' },
              rel: { enum: ['left', 'right', 'behind', 'in_front', 'on_top', 'inside', 'next_to'] },
              distance_m: { type: 'number' },
            },
            required: ['to', 'rel'],
            additionalProperties: false,
          },
        },
        required: ['relative'],
        additionalProperties: false,
      },
    ],
  },
} as const;

const REF = { $ref: '#/$defs/ObjectRef' } as const;
const PLACE = { $ref: '#/$defs/PlaceRef' } as const;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'function' as const,
    name,
    description,
    parameters: { type: 'object', properties, required, $defs: DEFS },
  };
}

const ALL_TOOLS = [
  tool('query_scene', 'List objects/actors matching a filter with ids, tags and positions.', { filter: { type: 'string' } }),
  tool('resolve_ref', 'Resolve a possibly-deictic reference to candidate object ids.', { ref: REF }, ['ref']),
  tool('get_shot_state', 'Current camera mode, shot preset, recording state, active mission.', {}),
  tool('list_assets', 'Search spawnable assets by text.', { query: { type: 'string' } }, ['query']),
  tool(
    'spawn',
    'Spawn an asset (by id) or generate one from a prompt at a place.',
    {
      asset: { type: 'string' },
      prompt: { type: 'string' },
      place: PLACE,
      scale: { type: 'number' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    ['place'],
  ),
  tool('move', 'Move an object to a place ("put that there").', { obj: REF, place: PLACE, animate_ms: { type: 'number' } }, [
    'obj',
    'place',
  ]),
  tool('rotate', 'Rotate an object by yaw or to face another object.', { obj: REF, yaw_deg: { type: 'number' }, face: REF }, ['obj']),
  tool(
    'scale',
    'Scale an object by a factor or to an absolute size in metres.',
    { obj: REF, factor: { type: 'number' }, size_m: { type: 'number' } },
    ['obj'],
  ),
  tool('delete', 'Delete an object (requires confirmation below 0.8 confidence).', { obj: REF }, ['obj']),
  tool(
    'set_material',
    'Change colour/material preset of an object.',
    { obj: REF, color: { type: 'string' }, preset: { type: 'string' }, prompt: { type: 'string' } },
    ['obj'],
  ),
  tool('group', 'Group objects so they move together.', { objs: { type: 'array', items: REF, minItems: 2 }, name: { type: 'string' } }, [
    'objs',
  ]),
  tool('ungroup', 'Dissolve a group.', { obj: REF }, ['obj']),
  tool('set_time', 'Set time-of-day preset or hour.', {
    preset: { enum: ['golden', 'blue', 'night', 'fog_noon'] },
    hour: { type: 'number' },
  }),
  tool('set_weather', 'Set weather.', { kind: { enum: ['fog', 'clear', 'rain'] }, amount: { type: 'number' } }, ['kind']),
  tool('set_look', 'Put a look (film stock LUT) on the picture, live and in the cut.', { preset: { enum: [...LOOK_NAMES] } }, ['preset']),
  tool('loadout', 'Wear an unlocked outfit or run an unlocked hydraulic pattern (ids from the reel, or "default" / "classic").', {
    outfit: { type: 'string' },
    pattern: { type: 'string' },
  }),
  tool('play_anim', 'Play an animation clip on an actor.', { actor: REF, clip: { type: 'string' }, loop: { type: 'boolean' } }, [
    'actor',
    'clip',
  ]),
  tool('possess', 'Give the player control of an actor.', { actor: REF }, ['actor']),
  tool('replay_take', 'Replay a recorded take on an actor.', { take: { type: 'string' }, actor: REF }, ['take', 'actor']),
  tool('camera', 'Set a shot preset, follow target, perform a camera move, or work the keyframed path (key / play / stop / clear).', {
    shot: { enum: ['wide', 'medium', 'close', 'low', 'high', 'dutch'] },
    follow: REF,
    move: { enum: ['push_in', 'pull_out', 'orbit', 'crane_up', 'crane_down', 'dolly_left', 'dolly_right'] },
    duration_ms: { type: 'number' },
    lens_mm: { type: 'number' },
    look_at: REF,
    path: { enum: ['key', 'play', 'stop', 'clear', 'undo_key'] },
    path_seconds: { type: 'number' },
    loop: { type: 'boolean' },
  }),
  tool('record', 'Start ("action") or stop ("cut") recording the current shot.', { action: { enum: ['start', 'stop'] } }, ['action']),
  tool('mark_beat', 'Drop a labelled marker on the timeline.', { label: { type: 'string' } }, ['label']),
  tool('undo', 'Undo the last n acts.', { n: { type: 'integer', minimum: 1 } }),
  tool(
    'set_mode',
    'Switch the perspective: actor (first person), director (camera + takes), producer (world).',
    {
      mode: { enum: ['actor', 'director', 'producer'] },
    },
    ['mode'],
  ),
];

export const ALL_TOOL_NAMES = ALL_TOOLS.map((t) => t.name);

/** Tools exposed to the Realtime session for a given mode (CAM-8). Omit `mode` for the full list. */
export function toRealtimeTools(mode?: RigMode) {
  if (!mode) return ALL_TOOLS;
  return ALL_TOOLS.filter((t) => (TOOL_MODES[t.name] ?? []).includes(mode));
}
