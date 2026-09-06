/**
 * Act executor (goal.md DIR-1/DIR-3): runs `SceneAct`s — from the grammar or from the Realtime model's tool calls —
 * against a small `SceneOps` surface the game implements. References resolve deterministically through deixis.ts;
 * an act below the confidence bar does not fire, it asks (one word: "which?", "where?", "this one?"), and every act
 * returns the `ActResult` envelope the model is shown. Pure TypeScript: unit-tested with a fake `SceneOps`.
 */
import type { DeixisBuffer } from '@coast/engine';
import { resolveObject, resolvePlace, type ResolveContext, type SceneIndex, type SpeechWindow } from './deixis';
import { parseUtterance, type Meta, type Utterance } from './grammar';
import type { ActEnvelope, ActResult, CameraMove, ObjectRef, RigMode, SceneAct, ShotName } from './schema';

export type TimePresetName = 'golden' | 'blue' | 'night' | 'fog_noon';
export type WeatherKind = 'fog' | 'clear' | 'rain';

export interface CameraRequest {
  shot?: ShotName;
  followId?: string;
  lookAtId?: string;
  move?: CameraMove;
  durationMs?: number;
  lensMm?: number;
}

/** What the game exposes to the director. Every mutator returns whether it happened (false = not possible here). */
export interface SceneOps extends SceneIndex {
  move(id: string, pos: [number, number, number]): boolean;
  rotate(id: string, yawDeg: number | undefined, faceId: string | undefined): boolean;
  scale(id: string, factor: number): boolean;
  remove(id: string): boolean;
  setMaterial(id: string, color: string): boolean;
  /** Returns the new object's id, or null when the asset is unknown. */
  spawn(asset: string, pos: [number, number, number]): string | null;
  setTime(preset: TimePresetName): boolean;
  setWeather(kind: WeatherKind, amount?: number): boolean;
  possess(id: string): boolean;
  playAnim(id: string, clip: string): boolean;
  replay(): boolean;
  record(action: 'start' | 'stop'): boolean;
  markBeat(label: string): boolean;
  /** Undo up to n acts; returns how many were undone. */
  undo(n: number): number;
  camera(req: CameraRequest): boolean;
  setMode(mode: RigMode): boolean;
  /** Ghost preview of a pending move (DIR-3): `pos` null clears it. Optional — a scene without ghosts just asks. */
  preview?(id: string | null, pos: [number, number, number] | null): void;
}

export interface ExecuteOptions {
  /** Acts whose reference resolved below this confidence ask instead of acting (DIR-3 confirmation gate). */
  confirmBelow?: number;
  /** Destructive acts (delete) need more. */
  confirmDeleteBelow?: number;
}

export interface UtteranceContext {
  buffer: DeixisBuffer;
  speech: SpeechWindow;
  mode: RigMode;
  speakerForward: [number, number];
  /** Realtime `call_id` prefix for idempotency keys (typed commands mint their own). */
  callId?: string;
}

export interface UtteranceOutcome {
  utterance: Utterance;
  results: ActResult[];
}

const NOT_HERE = (what: string): ActResult => ({ ok: false, affected: [], confidence: 1, error: `${what} is not available here` });

/** A question left open by the last act: the reply ("yes", "the left one", "no") finishes it. */
interface Pending {
  act: SceneAct;
  kind: 'object' | 'place';
  objects: string[];
  places: [number, number, number][];
  ctx: ResolveContext;
  /** A ghost is on screen for this question. */
  previewing: boolean;
}

export class ActExecutor {
  /** The object the last successful act touched — what "it" means next. */
  lastMentioned: string | undefined;
  private pending: Pending | null = null;
  private ambiguity: { kind: 'object' | 'place'; objects: string[]; places: [number, number, number][] } | null = null;
  private readonly confirmBelow: number;
  private readonly confirmDeleteBelow: number;
  private serial = 0;

  constructor(
    private readonly ops: SceneOps,
    opts: ExecuteOptions = {},
  ) {
    this.confirmBelow = opts.confirmBelow ?? 0.6;
    this.confirmDeleteBelow = opts.confirmDeleteBelow ?? 0.8;
  }

  /** Parse and run a spoken / typed direction; every clause yields one result, in order. */
  say(text: string, ctx: UtteranceContext): UtteranceOutcome {
    const utterance = parseUtterance(text);
    const results: ActResult[] = [];
    for (const clause of utterance.clauses) {
      if (clause.meta) {
        results.push(this.reply(clause.meta, ctx.speakerForward));
        continue;
      }
      if (!clause.act) {
        results.push({ ok: false, affected: [], confidence: 0, error: `didn't get "${clause.text}"` });
        continue;
      }
      results.push(
        this.execute(
          {
            callId: `${ctx.callId ?? 'say'}-${++this.serial}`,
            mode: ctx.mode,
            speech: ctx.speech,
            deicticTotal: utterance.deicticTotal,
            act: clause.act,
          },
          ctx.buffer,
          ctx.speakerForward,
        ),
      );
    }
    return { utterance, results };
  }

  /** Run one enveloped act (a Realtime tool call, or one clause of `say`). */
  execute(env: ActEnvelope, buffer: DeixisBuffer, speakerForward: [number, number]): ActResult {
    const ctx: ResolveContext = {
      buffer,
      scene: this.ops,
      speech: env.speech,
      deicticTotal: env.deicticTotal,
      speakerForward,
      speakerId: 'me',
      ...(this.lastMentioned ? { lastMentioned: this.lastMentioned } : {}),
    };
    this.clearPending();
    this.ambiguity = null;
    const result = this.run(env.act, ctx);
    if (result.ok && result.affected[0] && result.affected[0] !== 'me' && !/^(camera|take|mode|time|weather)$/.test(result.affected[0])) {
      this.lastMentioned = result.affected[0];
    }
    const amb = this.takeAmbiguity(); // (a method, so the type checker does not assume the field stayed null)
    if (!result.ok && result.question && amb) {
      this.pending = { act: env.act, ctx, ...amb, previewing: false };
      // A pending move with a candidate place shows where it would go.
      if (env.act.op === 'move' && amb.kind === 'place' && amb.places[0] && result.affected[0] && this.ops.preview) {
        this.ops.preview(result.affected[0], amb.places[0]);
        this.pending.previewing = true;
      }
    }
    return result;
  }

  private takeAmbiguity() {
    const a = this.ambiguity;
    this.ambiguity = null;
    return a;
  }

  /** Whether a question is waiting for a reply. */
  get hasPending() {
    return !!this.pending;
  }

  /** "yes" / "the left one" / "no": finish (or drop) the pending act. */
  reply(meta: Meta, speakerForward: [number, number]): ActResult {
    const p = this.pending;
    if (!p) return { ok: false, affected: [], confidence: 1, error: 'nothing to confirm' };
    this.clearPending();
    if (meta.kind === 'cancel') return { ok: true, affected: [], confidence: 1 };
    let act: SceneAct;
    if (p.kind === 'place') {
      const pos = p.places[0];
      if (!pos || p.act.op !== 'move') return { ok: false, affected: [], confidence: 1, error: 'nothing to confirm' };
      act = { ...p.act, place: { pos } };
    } else {
      const id = meta.kind === 'pick' ? this.pickCandidate(p.objects, meta.which, p.ctx, speakerForward) : p.objects[0];
      if (!id) return { ok: false, affected: p.objects, confidence: 0.5, question: 'which?' };
      act = withExplicitRef(p.act, id);
    }
    this.ambiguity = null;
    const result = this.run(act, p.ctx);
    if (result.ok && result.affected[0]) this.lastMentioned = result.affected[0];
    return result;
  }

  private clearPending() {
    if (this.pending?.previewing) this.ops.preview?.(null, null);
    this.pending = null;
  }

  /** Choose among candidates: by order, by side (speaker's left/right) or by distance from the speaker. */
  private pickCandidate(
    ids: string[],
    which: Extract<Meta, { kind: 'pick' }>['which'],
    ctx: ResolveContext,
    forward: [number, number],
  ): string | undefined {
    if (which === 'first') return ids[0];
    if (which === 'second') return ids[1] ?? ids[0];
    const me = ctx.scene.positionOf(ctx.speakerId ?? 'me') ?? [0, 0, 0];
    const [fx, fz] = forward;
    const len = Math.hypot(fx, fz) || 1;
    const rx = -fz / len;
    const rz = fx / len; // right = forward × up
    const scored = ids
      .map((id) => {
        const p = ctx.scene.positionOf(id);
        if (!p) return { id, side: 0, dist: Infinity };
        const dx = p[0] - me[0];
        const dz = p[2] - me[2];
        return { id, side: dx * rx + dz * rz, dist: Math.hypot(dx, dz) };
      })
      .filter((s) => Number.isFinite(s.dist));
    if (!scored.length) return undefined;
    const by = (f: (s: (typeof scored)[number]) => number) => [...scored].sort((a, b) => f(a) - f(b))[0]!.id;
    switch (which) {
      case 'left':
        return by((s) => s.side);
      case 'right':
        return by((s) => -s.side);
      case 'near':
        return by((s) => s.dist);
      case 'far':
        return by((s) => -s.dist);
    }
    return undefined;
  }

  private ref(ref: ObjectRef, ctx: ResolveContext, bar = this.confirmBelow): { id?: string; result?: ActResult } {
    if ('id' in ref && ref.id === 'me') return { id: 'me' };
    const r = resolveObject(ref, ctx);
    if (!r.value) return { result: { ok: false, affected: r.candidates, confidence: r.confidence, question: r.question ?? 'which?' } };
    if (r.confidence < bar) {
      this.ambiguity = { kind: 'object', objects: r.candidates, places: [] };
      return { result: { ok: false, affected: r.candidates, confidence: r.confidence, question: r.question ?? 'this one?' } };
    }
    return { id: r.value };
  }

  private run(act: SceneAct, ctx: ResolveContext): ActResult {
    const ops = this.ops;
    const done = (id: string, confidence = 1): ActResult => ({ ok: true, affected: [id], confidence });
    switch (act.op) {
      case 'move': {
        const o = this.ref(act.obj, ctx);
        if (!o.id) return o.result!;
        const p = resolvePlace(act.place, ctx);
        if (!p.value) return { ok: false, affected: [o.id], confidence: p.confidence, question: p.question ?? 'where?' };
        if (p.confidence < this.confirmBelow) {
          this.ambiguity = { kind: 'place', objects: [o.id], places: p.candidates };
          return { ok: false, affected: [o.id], confidence: p.confidence, question: 'there?' };
        }
        return ops.move(o.id, p.value) ? done(o.id, Math.min(p.confidence, 1)) : NOT_HERE(`moving ${o.id}`);
      }
      case 'rotate': {
        const o = this.ref(act.obj, ctx);
        if (!o.id) return o.result!;
        let faceId: string | undefined;
        if (act.face) {
          const f = this.ref(act.face, ctx);
          if (!f.id) return f.result!;
          faceId = f.id;
        }
        return ops.rotate(o.id, act.yaw_deg, faceId) ? done(o.id) : NOT_HERE(`rotating ${o.id}`);
      }
      case 'scale': {
        const o = this.ref(act.obj, ctx);
        if (!o.id) return o.result!;
        const factor = act.factor ?? (act.size_m ? act.size_m / Math.max(0.01, ops.radiusOf(o.id) * 2) : 1);
        return ops.scale(o.id, factor) ? done(o.id) : NOT_HERE(`scaling ${o.id}`);
      }
      case 'delete': {
        const o = this.ref(act.obj, ctx, this.confirmDeleteBelow);
        if (!o.id) return o.result!;
        return ops.remove(o.id) ? done(o.id) : NOT_HERE(`deleting ${o.id}`);
      }
      case 'set_material': {
        const o = this.ref(act.obj, ctx);
        if (!o.id) return o.result!;
        const color = act.color ?? act.preset ?? act.prompt ?? '';
        return ops.setMaterial(o.id, color) ? done(o.id) : NOT_HERE(`recolouring ${o.id}`);
      }
      case 'spawn': {
        const p = resolvePlace(act.place, ctx);
        if (!p.value) return { ok: false, affected: [], confidence: p.confidence, question: p.question ?? 'where?' };
        const asset = act.asset ?? act.prompt ?? '';
        const id = ops.spawn(asset, p.value);
        return id ? done(id, p.confidence) : { ok: false, affected: [], confidence: 1, error: `no asset "${asset}"` };
      }
      case 'group':
      case 'ungroup':
        return NOT_HERE('grouping');
      case 'set_time':
        return act.preset && ops.setTime(act.preset) ? done('time') : NOT_HERE('that time of day');
      case 'set_weather':
        return ops.setWeather(act.kind, act.amount) ? done('weather') : NOT_HERE(`${act.kind} weather`);
      case 'play_anim': {
        const a = this.ref(act.actor, ctx);
        if (!a.id) return a.result!;
        return ops.playAnim(a.id, act.clip) ? done(a.id) : NOT_HERE(`the ${act.clip} clip`);
      }
      case 'possess': {
        const a = this.ref(act.actor, ctx);
        if (!a.id) return a.result!;
        return ops.possess(a.id) ? done(a.id) : NOT_HERE(`possessing ${a.id}`);
      }
      case 'replay_take':
        return ops.replay() ? done('take') : NOT_HERE('replay (nothing recorded yet)');
      case 'camera': {
        const req: CameraRequest = {};
        if (act.shot) req.shot = act.shot;
        if (act.move) req.move = act.move;
        if (act.duration_ms !== undefined) req.durationMs = act.duration_ms;
        if (act.lens_mm !== undefined) req.lensMm = act.lens_mm;
        if (act.follow) {
          const f = this.ref(act.follow, ctx);
          if (!f.id) return f.result!;
          req.followId = f.id;
        }
        if (act.look_at) {
          const l = this.ref(act.look_at, ctx);
          if (!l.id) return l.result!;
          req.lookAtId = l.id;
        }
        return ops.camera(req) ? done('camera') : NOT_HERE('that camera move');
      }
      case 'record':
        return ops.record(act.action)
          ? done('take')
          : {
              ok: false,
              affected: [],
              confidence: 1,
              error: act.action === 'start' ? 'nothing to roll — get a mission from the photographer' : 'not recording',
            };
      case 'mark_beat':
        return ops.markBeat(act.label) ? done('take') : NOT_HERE('markers');
      case 'undo': {
        const n = ops.undo(act.n ?? 1);
        return n > 0 ? { ok: true, affected: [], confidence: 1 } : { ok: false, affected: [], confidence: 1, error: 'nothing to undo' };
      }
      case 'set_mode':
        return ops.setMode(act.mode) ? done('mode') : NOT_HERE(`${act.mode} mode`);
    }
  }
}

/** The act again with its ambiguous reference pinned to `id` (the first ref that is not already explicit). */
function withExplicitRef(act: SceneAct, id: string): SceneAct {
  const pin = (ref: ObjectRef | undefined): ObjectRef | undefined => (ref && !('id' in ref) ? { id } : ref);
  switch (act.op) {
    case 'move':
    case 'rotate':
    case 'scale':
    case 'delete':
    case 'set_material':
    case 'ungroup':
      return { ...act, obj: pin(act.obj)! };
    case 'play_anim':
    case 'possess':
    case 'replay_take':
      return { ...act, actor: pin(act.actor)! };
    case 'camera':
      return { ...act, ...(act.follow ? { follow: pin(act.follow)! } : {}), ...(act.look_at ? { look_at: pin(act.look_at)! } : {}) };
    default:
      return act;
  }
}
