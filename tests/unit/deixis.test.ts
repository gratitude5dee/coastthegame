import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DeixisBuffer, type DeixisSample } from '../../packages/engine/src/intents/intents';
import {
  resolveObject,
  resolvePlace,
  nominalTime,
  pointingEvents,
  type SceneIndex,
  type ResolveContext,
} from '../../packages/director/src/deixis';
import { toRealtimeTools, ALL_TOOL_NAMES, TOOL_MODES } from '../../packages/director/src/schema';

/** A tiny scene index shared by fixtures. */
const scene: SceneIndex = {
  byDescription: (d) => (d.includes('car') ? ['car_red', 'car_blue'] : d.includes('truck') ? ['taco_truck'] : []),
  positionOf: (id) =>
    ({ car_red: [2, 0, 0], car_blue: [10, 0, 0], taco_truck: [0, 0, -5], can_red: [1, 0, 1], cone_orange: [3, 0, 3] })[id] as
      [number, number, number] | undefined,
  radiusOf: () => 1,
};

function ctx(partial: Partial<ResolveContext> & { buffer?: DeixisBuffer } = {}): ResolveContext {
  return {
    buffer: partial.buffer ?? new DeixisBuffer(),
    scene,
    speech: partial.speech ?? { startMs: 0, endMs: 1000 },
    deicticTotal: partial.deicticTotal ?? 1,
    speakerForward: partial.speakerForward ?? [0, -1],
    lastMentioned: partial.lastMentioned,
  };
}

// ── Fixture suite (goal.md QB-6 / SCH-6): precision is computed, not asserted as a constant ──
interface Fixture {
  name: string;
  speech: { startMs: number; endMs: number };
  deicticTotal: number;
  buffer: DeixisSample[];
  cases: {
    ref: unknown;
    kind: 'object' | 'place';
    expect: { id?: string; pos?: number[]; minConfidence?: number; maxConfidence?: number; question?: string };
  }[];
}
const fixturesDir = join(__dirname, '../fixtures/deixis');
const fixtures: Fixture[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')));

describe('deixis fixture suite', () => {
  let total = 0;
  let correct = 0;
  for (const fx of fixtures) {
    it(fx.name, () => {
      const buffer = new DeixisBuffer();
      for (const s of fx.buffer) buffer.push(s);
      const c = ctx({ buffer, speech: fx.speech, deicticTotal: fx.deicticTotal });
      for (const cs of fx.cases) {
        total++;
        if (cs.kind === 'object') {
          const r = resolveObject(cs.ref as never, c);
          if (cs.expect.question) {
            expect(r.value).toBeUndefined();
            expect(r.question).toBe(cs.expect.question);
            correct++;
            continue;
          }
          const ok =
            r.value === cs.expect.id && r.confidence >= (cs.expect.minConfidence ?? 0) && r.confidence <= (cs.expect.maxConfidence ?? 1);
          expect({ value: r.value, confidence: r.confidence, source: r.source }).toMatchObject({ value: cs.expect.id });
          if (cs.expect.minConfidence !== undefined) expect(r.confidence).toBeGreaterThanOrEqual(cs.expect.minConfidence);
          if (cs.expect.maxConfidence !== undefined) expect(r.confidence).toBeLessThanOrEqual(cs.expect.maxConfidence);
          if (ok) correct++;
        } else {
          const r = resolvePlace(cs.ref as never, c);
          expect(r.value).toEqual(cs.expect.pos);
          if (cs.expect.minConfidence !== undefined) expect(r.confidence).toBeGreaterThanOrEqual(cs.expect.minConfidence);
          correct++;
        }
      }
    });
  }
  it('reports precision (QB-6 gate is ≥0.9 with pointer/hand, evaluated on the pointer/hand subset in M5)', () => {
    const precision = total ? correct / total : 0;
    console.log(`deixis fixture precision: ${correct}/${total} = ${precision.toFixed(3)}`);
    expect(precision).toBeGreaterThanOrEqual(0.9);
  });
});

// ── Unit behaviour ──
describe('timing model', () => {
  it('maps the k-th of n deictics proportionally into the speech window', () => {
    expect(nominalTime({ startMs: 0, endMs: 1000 }, 1, 1)).toBe(500);
    expect(nominalTime({ startMs: 0, endMs: 900 }, 1, 2)).toBe(300);
    expect(nominalTime({ startMs: 0, endMs: 900 }, 2, 2)).toBe(600);
    expect(nominalTime({ startMs: 0, endMs: 900 }, 5, 2)).toBe(600); // clamps ordinal to n
  });
  it("Bolt's rule: n pointing events for n deictics are paired in order", () => {
    const b = new DeixisBuffer();
    b.push({ t: 200, pointerHit: 'car_blue', clickEdge: true });
    b.push({ t: 900, pointerHit: 'car_red', clickEdge: true });
    const c = ctx({ buffer: b, speech: { startMs: 0, endMs: 1000 }, deicticTotal: 2 });
    expect(resolveObject({ deictic: 'that', ordinal: 1 }, c).value).toBe('car_blue');
    expect(resolveObject({ deictic: 'that', ordinal: 2 }, c).value).toBe('car_red');
  });
  it('clusters a held pinch into one event at its peak', () => {
    const ev = pointingEvents([
      { t: 0, pinchStrength: 0.75, handHit: { hand: 'right', id: 'a', point: [0, 0, 0] } },
      { t: 33, pinchStrength: 0.95, handHit: { hand: 'right', id: 'b', point: [0, 0, 0] } },
      { t: 66, pinchStrength: 0.8, handHit: { hand: 'right', id: 'c', point: [0, 0, 0] } },
      { t: 99, pinchStrength: 0.1 },
      { t: 500, clickEdge: true, pointerHit: 'd' },
    ]);
    expect(ev.map((e) => e.handHit?.id ?? e.pointerHit)).toEqual(['b', 'd']);
  });
  it('prefers an explicit pointing event inside ±700 ms of the nominal time over the nearest sample', () => {
    const b = new DeixisBuffer();
    b.push({ t: 100, pointerHit: 'car_blue', clickEdge: true }); // event, 400 ms before nominal
    b.push({ t: 480, pointerHit: 'car_red' }); // nearest, no event
    b.push({ t: 1500, pointerHit: 'x', clickEdge: true }); // second event → events (2) ≠ deictics (1), so nominal-time rule applies
    const r = resolveObject({ deictic: 'that' }, ctx({ buffer: b, speech: { startMs: 0, endMs: 1000 }, deicticTotal: 1 }));
    expect(r.value).toBe('car_blue');
  });
  it('ignores pointing events outside the ±700 ms window', () => {
    const b = new DeixisBuffer();
    b.push({ t: 480, pointerHit: 'car_red' });
    b.push({ t: 1800, pointerHit: 'y', clickEdge: true }); // outside the padded window (end + 700 ms) → not an event for this utterance
    b.push({ t: 3000, pointerHit: 'car_blue', clickEdge: true });
    const r = resolveObject({ deictic: 'that' }, ctx({ buffer: b, speech: { startMs: 0, endMs: 1000 }, deicticTotal: 1 }));
    expect(r.value).toBe('car_red');
  });
});

describe('source priority', () => {
  it('hand > pointer > head > selection > last-mentioned', () => {
    const mk = (s: Partial<DeixisSample>) => {
      const b = new DeixisBuffer();
      b.push({ t: 500, ...s });
      return ctx({ buffer: b, speech: { startMs: 0, endMs: 1000 }, deicticTotal: 1, lastMentioned: 'last_obj' });
    };
    expect(
      resolveObject(
        { deictic: 'that' },
        mk({ handHit: { hand: 'right', id: 'h', point: [0, 0, 0] }, pointerHit: 'p', headHit: 'g', selection: 's' }),
      ).source,
    ).toBe('hand');
    expect(resolveObject({ deictic: 'that' }, mk({ pointerHit: 'p', headHit: 'g', selection: 's' })).source).toBe('pointer');
    expect(resolveObject({ deictic: 'that' }, mk({ headHit: 'g', selection: 's' })).source).toBe('head');
    expect(resolveObject({ deictic: 'that' }, mk({ selection: 's' })).source).toBe('selection');
    expect(resolveObject({ deictic: 'it' }, mk({})).source).toBe('last');
  });
});

describe('descriptions and relations', () => {
  it('returns top-2 candidates and a question when ambiguous', () => {
    const r = resolveObject({ desc: 'the car' }, ctx());
    expect(r.candidates).toHaveLength(2);
    expect(r.question).toBe('this one?');
    expect(r.confidence).toBeLessThan(0.8);
  });
  it('disambiguates by proximity to a "near" anchor', () => {
    expect(resolveObject({ desc: 'the car', near: { id: 'car_blue' } }, ctx()).value).toBe('car_blue');
  });
  it('"left of the truck" resolves in the speaker frame (three.js: forward -Z, right +X)', () => {
    const r = resolvePlace({ relative: { to: { id: 'taco_truck' }, rel: 'left', distance_m: 2 } }, ctx());
    expect(r.value).toEqual([-2, 0, -5]);
    const behind = resolvePlace({ relative: { to: { id: 'taco_truck' }, rel: 'behind', distance_m: 2 } }, ctx());
    expect(behind.value).toEqual([0, 0, -7]);
  });
});

describe('realtime tool schema (DIR-2 / CAM-8)', () => {
  it('exposes every act and query op from goal.md DIR-2', () => {
    for (const n of [
      'query_scene',
      'resolve_ref',
      'get_shot_state',
      'list_assets',
      'spawn',
      'move',
      'rotate',
      'scale',
      'delete',
      'set_material',
      'group',
      'ungroup',
      'set_time',
      'set_weather',
      'play_anim',
      'possess',
      'replay_take',
      'camera',
      'record',
      'mark_beat',
      'undo',
    ])
      expect(ALL_TOOL_NAMES).toContain(n);
  });
  it('every tool has a mode assignment and mode filtering hides the rest', () => {
    for (const n of ALL_TOOL_NAMES) expect(TOOL_MODES[n]?.length).toBeGreaterThan(0);
    const actor = toRealtimeTools('actor').map((t) => t.name);
    expect(actor).toContain('query_scene');
    expect(actor).not.toContain('delete');
    expect(toRealtimeTools('director').map((t) => t.name)).toContain('camera');
    expect(toRealtimeTools('producer').map((t) => t.name)).toContain('set_material');
  });
  it('uses anyOf + $defs (no oneOf, no recursion) and never asks the model for timestamps', () => {
    const json = JSON.stringify(toRealtimeTools());
    expect(json).not.toContain('oneOf');
    expect(json).not.toContain('utterance_t');
    expect(json).not.toContain('request_id');
    expect(json).toContain('$defs');
  });
});
