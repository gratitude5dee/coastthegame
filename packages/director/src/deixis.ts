import type { DeixisBuffer, DeixisSample } from '@coast/engine';
import type { ObjectRef, PlaceRef } from './schema';

/**
 * Deterministic deixis resolution (goal.md DIR-3). Pure functions → fixture-tested (tests/fixtures/deixis/*.json).
 *
 * Timing model: the model never supplies timestamps. The client stamps the speech window [start, end]; the model passes
 * each deictic word's ordinal k among ALL deictic words (that/this/it/there/here) in the utterance, n in total.
 *  1. Bolt's rule: if the number of explicit pointing EVENTS (pinch peak, click edge, controller trigger) inside the
 *     padded window equals n, pair them in order — the k-th event belongs to the k-th deictic.
 *  2. Otherwise nominal time t_k = start + (end - start) * k / (n + 1); prefer an event within ±700 ms of t_k,
 *     else the sample nearest t_k.
 * Source priority: hand/controller ray > pointer > head ray > selection > last-mentioned.
 */
export interface SceneIndex {
  byDescription(desc: string): string[]; // best first
  positionOf(id: string): [number, number, number] | undefined;
  radiusOf(id: string): number;
}

export interface SpeechWindow {
  startMs: number;
  endMs: number;
}

export interface ResolveContext {
  buffer: DeixisBuffer;
  scene: SceneIndex;
  speech: SpeechWindow;
  /** Number of deictic words (that/this/it/there/here) in the utterance — supplied by the client from the transcript. */
  deicticTotal: number;
  lastMentioned?: string;
  /** Speaker forward vector (XZ) for left/right/behind/in_front in the speaker's frame. */
  speakerForward: [number, number];
  /**
   * The speaker's own object id (e.g. 'me'). Relations are viewer-relative — "behind the car" is the car's far side —
   * except around the speaker: "in front of me" is along my forward, "behind me" is at my back.
   */
  speakerId?: string;
}

export type Source = 'hand' | 'pointer' | 'head' | 'selection' | 'last' | 'desc' | 'explicit' | 'none';

export interface Resolution<T> {
  value?: T;
  candidates: T[];
  confidence: number; // 0..1
  question?: string;
  source: Source;
}

export const SOURCE_CONF: Record<Exclude<Source, 'desc' | 'explicit' | 'none'>, number> = {
  hand: 0.95,
  pointer: 0.9,
  head: 0.72,
  selection: 0.8,
  last: 0.6,
};

export const EVENT_WINDOW_MS = 700;
export const PINCH_EVENT_THRESHOLD = 0.7;

/** Nominal time of the k-th deictic of n in the speech window. */
export function nominalTime(speech: SpeechWindow, ordinal: number, count: number): number {
  const n = Math.max(1, count);
  const k = Math.min(Math.max(1, ordinal), n);
  return speech.startMs + ((speech.endMs - speech.startMs) * k) / (n + 1);
}

function isPointingEvent(s: DeixisSample): boolean {
  return !!s.clickEdge || (s.pinchStrength ?? 0) >= PINCH_EVENT_THRESHOLD;
}

/** Cluster consecutive pointing samples (a held pinch spans several samples) into single events at the peak. */
export function pointingEvents(samples: DeixisSample[]): DeixisSample[] {
  const events: DeixisSample[] = [];
  let cur: DeixisSample | undefined;
  for (const s of samples) {
    if (isPointingEvent(s)) {
      if (!cur || (s.pinchStrength ?? 0) > (cur.pinchStrength ?? 0) || s.clickEdge)
        cur = cur && !s.clickEdge && (s.pinchStrength ?? 0) <= (cur.pinchStrength ?? 0) ? cur : s;
      if (s.clickEdge) {
        events.push(s);
        cur = undefined;
      }
    } else if (cur) {
      events.push(cur);
      cur = undefined;
    }
  }
  if (cur) events.push(cur);
  return events;
}

/** Pick the sample for the k-th of n deictics (see file header). */
export function pickSample(buffer: DeixisBuffer, speech: SpeechWindow, ordinal: number, total: number): DeixisSample | undefined {
  const n = Math.max(1, total);
  const k = Math.min(Math.max(1, ordinal), n);
  const events = pointingEvents(buffer.between(speech.startMs - EVENT_WINDOW_MS, speech.endMs + EVENT_WINDOW_MS));
  if (events.length === n) return events[k - 1]; // Bolt's rule
  const tk = nominalTime(speech, k, n);
  let best: DeixisSample | undefined;
  let bestD = Infinity;
  for (const s of events) {
    const d = Math.abs(s.t - tk);
    if (d <= EVENT_WINDOW_MS && d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best ?? buffer.at(tk);
}

function fromSample(s: DeixisSample | undefined, ctx: ResolveContext): Resolution<string> {
  if (s?.handHit) return { value: s.handHit.id, candidates: [s.handHit.id], confidence: SOURCE_CONF.hand, source: 'hand' };
  if (s?.pointerHit) return { value: s.pointerHit, candidates: [s.pointerHit], confidence: SOURCE_CONF.pointer, source: 'pointer' };
  if (s?.headHit) return { value: s.headHit, candidates: [s.headHit], confidence: SOURCE_CONF.head, source: 'head' };
  if (s?.selection) return { value: s.selection, candidates: [s.selection], confidence: SOURCE_CONF.selection, source: 'selection' };
  if (ctx.lastMentioned) return { value: ctx.lastMentioned, candidates: [ctx.lastMentioned], confidence: SOURCE_CONF.last, source: 'last' };
  return { candidates: [], confidence: 0, source: 'none', question: 'which?' };
}

export function resolveObject(ref: ObjectRef, ctx: ResolveContext): Resolution<string> {
  if ('id' in ref) return { value: ref.id, candidates: [ref.id], confidence: 1, source: 'explicit' };
  if ('deictic' in ref) return fromSample(pickSample(ctx.buffer, ctx.speech, ref.ordinal ?? 1, ctx.deicticTotal), ctx);
  let cands = ctx.scene.byDescription(ref.desc);
  if (ref.near) {
    const anchor = resolveObject(ref.near as ObjectRef, ctx);
    const ap = anchor.value ? ctx.scene.positionOf(anchor.value) : undefined;
    if (ap) cands = [...cands].sort((a, b) => dist(ctx.scene.positionOf(a), ap) - dist(ctx.scene.positionOf(b), ap));
  }
  if (cands.length === 0) return { candidates: [], confidence: 0, source: 'none', question: 'which?' };
  if (cands.length === 1) return { value: cands[0], candidates: cands, confidence: 0.85, source: 'desc' };
  return { value: cands[0], candidates: cands.slice(0, 2), confidence: 0.5, source: 'desc', question: 'this one?' };
}

export function resolvePlace(ref: PlaceRef, ctx: ResolveContext): Resolution<[number, number, number]> {
  if ('pos' in ref) return { value: ref.pos, candidates: [ref.pos], confidence: 1, source: 'explicit' };
  if ('deictic' in ref) {
    const s = pickSample(ctx.buffer, ctx.speech, ref.ordinal ?? 1, ctx.deicticTotal);
    if (s?.handHit?.point) return { value: s.handHit.point, candidates: [s.handHit.point], confidence: SOURCE_CONF.hand, source: 'hand' };
    if (s?.groundPoint) {
      const conf = s.clickEdge ? SOURCE_CONF.pointer : s.headHit ? SOURCE_CONF.head : SOURCE_CONF.pointer;
      return { value: s.groundPoint, candidates: [s.groundPoint], confidence: conf, source: s.clickEdge ? 'pointer' : 'pointer' };
    }
    return { candidates: [], confidence: 0, source: 'none', question: 'where?' };
  }
  const anchor = resolveObject(ref.relative.to, ctx);
  const ap = anchor.value ? ctx.scene.positionOf(anchor.value) : undefined;
  if (!ap || !anchor.value) return { candidates: [], confidence: 0, source: 'none', question: 'next to what?' };
  const d = ref.relative.distance_m ?? Math.max(1, ctx.scene.radiusOf(anchor.value) * 1.5);
  const [fx, fz] = normalize2(ctx.speakerForward);
  // right = forward × up in a Y-up right-handed frame: (fx,0,fz)×(0,1,0) = (-fz, 0, fx)
  const rx = -fz;
  const rz = fx;
  // Around the speaker the depth axis flips: "behind the car" is its far side, "behind me" is at my back.
  const depth = ctx.speakerId !== undefined && anchor.value === ctx.speakerId ? -1 : 1;
  let p: [number, number, number] = [ap[0], ap[1], ap[2]];
  switch (ref.relative.rel) {
    case 'left':
      p = [ap[0] - rx * d, ap[1], ap[2] - rz * d];
      break;
    case 'right':
      p = [ap[0] + rx * d, ap[1], ap[2] + rz * d];
      break;
    case 'behind':
      p = [ap[0] + fx * d * depth, ap[1], ap[2] + fz * d * depth];
      break;
    case 'in_front':
      p = [ap[0] - fx * d * depth, ap[1], ap[2] - fz * d * depth];
      break;
    case 'on_top':
      p = [ap[0], ap[1] + ctx.scene.radiusOf(anchor.value) * 2, ap[2]];
      break;
    case 'inside':
      p = [ap[0], ap[1], ap[2]];
      break;
    case 'next_to':
      p = [ap[0] + rx * d, ap[1], ap[2] + rz * d];
      break;
  }
  return { value: p, candidates: [p], confidence: Math.min(0.85, anchor.confidence), source: anchor.source };
}

function dist(a?: [number, number, number], b?: [number, number, number]) {
  if (!a || !b) return Infinity;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function normalize2([x, z]: [number, number]): [number, number] {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}
