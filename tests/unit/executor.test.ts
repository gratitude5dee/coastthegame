import { describe, it, expect } from 'vitest';
import { DeixisBuffer } from '../../packages/engine/src/intents/intents';
import { ActExecutor, type SceneOps } from '../../packages/director/src/executor';

/**
 * goal.md DIR-1/DIR-3: directions become acts against the scene, references resolve through the deixis buffer, and
 * anything uncertain asks instead of acting. The scene here is a fake: three props, the car, two NPCs, the player.
 */
function fakeScene() {
  const positions = new Map<string, [number, number, number]>([
    ['crate_1', [2, 0, -3]],
    ['crate_2', [8, 0, -3]],
    ['cone_1', [-2, 0, -4]],
    ['lowrider', [6, 0, 2]],
    ['photographer', [4, 0, -1]],
    ['npc_a', [9, 0, -5]],
    ['me', [0, 0, 0]],
  ]);
  const log: string[] = [];
  const ops: SceneOps = {
    byDescription: (desc) => {
      const d = desc.toLowerCase();
      if (/car|lowrider|ride/.test(d)) return ['lowrider'];
      if (/photographer/.test(d)) return ['photographer'];
      if (/rico/.test(d)) return ['npc_a'];
      if (/crate|box/.test(d)) return ['crate_1', 'crate_2'];
      if (/cone/.test(d)) return ['cone_1'];
      return [];
    },
    positionOf: (id) => positions.get(id),
    radiusOf: (id) => (id === 'lowrider' ? 2.4 : 0.5),
    move: (id, pos) => {
      log.push(`move ${id} → ${pos.map((v) => v.toFixed(1)).join(',')}`);
      positions.set(id, pos);
      return true;
    },
    rotate: (id, yaw, face) => {
      log.push(`rotate ${id} ${yaw ?? ''} ${face ?? ''}`.trim());
      return true;
    },
    scale: (id, f) => {
      log.push(`scale ${id} ${f}`);
      return true;
    },
    remove: (id) => {
      log.push(`remove ${id}`);
      return true;
    },
    setMaterial: (id, c) => {
      log.push(`paint ${id} ${c}`);
      return true;
    },
    spawn: (asset, pos) => {
      if (!/crate|cone|can/.test(asset)) return null;
      log.push(`spawn ${asset} → ${pos.map((v) => v.toFixed(1)).join(',')}`);
      return `${asset}_9`;
    },
    setTime: (p) => {
      log.push(`time ${p}`);
      return true;
    },
    setWeather: () => false,
    possess: (id) => {
      log.push(`possess ${id}`);
      return true;
    },
    playAnim: () => false,
    replay: () => {
      log.push('replay');
      return true;
    },
    record: (a) => {
      log.push(`record ${a}`);
      return a === 'stop';
    },
    markBeat: (l) => {
      log.push(`mark ${l}`);
      return true;
    },
    undo: (n) => {
      log.push(`undo ${n}`);
      return 1;
    },
    camera: (req) => {
      log.push(`camera ${JSON.stringify(req)}`);
      return true;
    },
    setMode: (m) => {
      log.push(`mode ${m}`);
      return true;
    },
  };
  return { ops, log, positions };
}

const speech = { startMs: 1000, endMs: 3000 };
const say = (ex: ActExecutor, text: string, buffer = new DeixisBuffer()) =>
  ex.say(text, { buffer, speech, mode: 'director', speakerForward: [0, -1] });

describe('ActExecutor', () => {
  it('"put that there": two clicks inside the speech window pair with the two deictics (Bolt\'s rule)', () => {
    const { ops, log } = fakeScene();
    const ex = new ActExecutor(ops);
    const buffer = new DeixisBuffer();
    buffer.push({ t: 1400, pointerHit: 'crate_1', groundPoint: [2, 0, -3], clickEdge: true });
    buffer.push({ t: 2600, groundPoint: [5, 0, -6], clickEdge: true });
    const out = say(ex, 'put that there', buffer);
    expect(out.results).toEqual([{ ok: true, affected: ['crate_1'], confidence: 0.9 }]);
    expect(log).toEqual(['move crate_1 → 5.0,0.0,-6.0']);
    expect(ex.lastMentioned).toBe('crate_1');
    // "it" now means the crate; a relative place needs no pointing at all.
    const again = say(ex, 'put it behind the car');
    expect(again.results[0]!.ok).toBe(true);
    expect(log[1]).toMatch(/^move crate_1 → 6\.0,0\.0,-1\.6/); // behind = the car's far side: 1.5 × radius along my forward (−Z)
  });

  it('asks instead of acting when a reference is ambiguous or points at nothing', () => {
    const { ops, log } = fakeScene();
    const ex = new ActExecutor(ops);
    const two = say(ex, 'move the crate next to the cone'); // two crates match the description
    expect(two.results[0]).toMatchObject({ ok: false, question: 'this one?', affected: ['crate_1', 'crate_2'] });
    const nothing = say(ex, 'delete that'); // no pointing samples, nothing mentioned before
    expect(nothing.results[0]).toMatchObject({ ok: false, question: 'which?' });
    expect(log).toEqual([]);
  });

  it('a destructive act wants more confidence than a move: a head-ray hit deletes only after a click', () => {
    const { ops, log } = fakeScene();
    const ex = new ActExecutor(ops);
    const looked = new DeixisBuffer();
    looked.push({ t: 2000, headHit: 'cone_1', groundPoint: [-2, 0, -4] });
    expect(say(ex, 'delete that', looked).results[0]).toMatchObject({ ok: false, question: 'this one?', affected: ['cone_1'] });
    expect(say(ex, 'make that bigger', looked).results[0]).toMatchObject({ ok: true, affected: ['cone_1'] }); // 0.72 clears the 0.6 bar
    const clicked = new DeixisBuffer();
    clicked.push({ t: 2000, pointerHit: 'cone_1', clickEdge: true });
    expect(say(ex, 'delete that', clicked).results[0]).toMatchObject({ ok: true, affected: ['cone_1'] });
    expect(log).toEqual(['scale cone_1 1.5', 'remove cone_1']);
  });

  it('camera, light, people and takes go straight through; unknown clauses come back as errors', () => {
    const { ops, log } = fakeScene();
    const ex = new ActExecutor(ops);
    const out = say(ex, 'camera low, follow the car, golden hour, be the photographer, make it pop, action');
    expect(out.results.map((r) => r.ok)).toEqual([true, true, true, true, false, false]);
    expect(out.results[4]!.error).toMatch(/didn't get "make it pop"/);
    expect(out.results[5]!.error).toMatch(/nothing to roll/);
    expect(log).toEqual(['camera {"shot":"low"}', 'camera {"followId":"lowrider"}', 'time golden', 'possess photographer', 'record start']);
    expect(ex.lastMentioned).toBe('photographer'); // people count as objects for "it"; camera / time do not
  });

  it('spawns "in front of me" by default and reports unknown assets', () => {
    const { ops, log } = fakeScene();
    const ex = new ActExecutor(ops);
    expect(say(ex, 'spawn a cone').results[0]).toMatchObject({ ok: true, affected: ['cone_9'] });
    expect(log[0]).toBe('spawn cone → 0.0,0.0,-2.0'); // speaker faces −Z
    expect(say(ex, 'spawn a piano').results[0]).toMatchObject({ ok: false, error: 'no asset "piano"' });
    expect(say(ex, 'cut, replay, undo, mark beat drop, director').results.every((r) => r.ok)).toBe(true);
    expect(log.slice(1)).toEqual(['record stop', 'replay', 'undo 1', 'mark drop', 'mode director']);
  });
});
