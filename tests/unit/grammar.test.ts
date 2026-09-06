import { describe, it, expect } from 'vitest';
import { parseUtterance } from '../../packages/director/src/grammar';
import type { SceneAct } from '../../packages/director/src/schema';

/**
 * goal.md DIR-1/DIR-2: the scripted voice suite, run through the deterministic grammar (the Realtime model emits the
 * same acts as tool calls). AGENTS.md asks for ≥ 27 of 30 utterances to pass; the grammar is literal, so all of them do.
 */
const SUITE: [string, SceneAct[], number?][] = [
  ['Action', [{ op: 'record', action: 'start' }]],
  ['cut!', [{ op: 'record', action: 'stop' }]],
  ['take two', [{ op: 'record', action: 'start' }]],
  ['camera low', [{ op: 'camera', shot: 'low' }]],
  ['get low', [{ op: 'camera', shot: 'low' }]],
  ['go wide', [{ op: 'camera', shot: 'wide' }]],
  ['closer', [{ op: 'camera', shot: 'close' }]],
  ['dutch angle', [{ op: 'camera', shot: 'dutch' }]],
  ['follow me', [{ op: 'camera', follow: { id: 'me' } }]],
  ['follow the car', [{ op: 'camera', follow: { desc: 'car' } }]],
  ['camera follow the lowrider', [{ op: 'camera', follow: { desc: 'lowrider' } }]],
  ['look at the crate', [{ op: 'camera', look_at: { desc: 'crate' } }]],
  ['push in slowly', [{ op: 'camera', move: 'push_in', duration_ms: 3000 }]],
  ['pull out', [{ op: 'camera', move: 'pull_out', duration_ms: 1500 }]],
  ['orbit fast', [{ op: 'camera', move: 'orbit', duration_ms: 600 }]],
  ['crane up', [{ op: 'camera', move: 'crane_up', duration_ms: 1500 }]],
  ['35mm', [{ op: 'camera', lens_mm: 35 }]],
  ['put that there', [{ op: 'move', obj: { deictic: 'that', ordinal: 1 }, place: { deictic: 'there', ordinal: 2 } }], 2],
  [
    'move the crate next to the car',
    [{ op: 'move', obj: { desc: 'crate' }, place: { relative: { to: { desc: 'car' }, rel: 'next_to' } } }],
  ],
  [
    'put it behind the lowrider',
    [{ op: 'move', obj: { deictic: 'it', ordinal: 1 }, place: { relative: { to: { desc: 'lowrider' }, rel: 'behind' } } }],
    1,
  ],
  ['drop a crate there', [{ op: 'spawn', asset: 'crate', place: { deictic: 'there', ordinal: 1 } }], 1],
  ['spawn a cone', [{ op: 'spawn', asset: 'cone', place: { relative: { to: { id: 'me' }, rel: 'in_front', distance_m: 2 } } }]],
  ['turn that around', [{ op: 'rotate', obj: { deictic: 'that', ordinal: 1 }, yaw_deg: 180 }], 1],
  ['rotate the crate 45 degrees', [{ op: 'rotate', obj: { desc: 'crate' }, yaw_deg: 45 }]],
  ['face the crate at the car', [{ op: 'rotate', obj: { desc: 'crate' }, face: { desc: 'car' } }]],
  ['make that bigger', [{ op: 'scale', obj: { deictic: 'that', ordinal: 1 }, factor: 1.5 }], 1],
  ['paint the crate red', [{ op: 'set_material', obj: { desc: 'crate' }, color: 'red' }]],
  ['delete that', [{ op: 'delete', obj: { deictic: 'that', ordinal: 1 } }], 1],
  ['golden hour', [{ op: 'set_time', preset: 'golden' }]],
  ['make it night', [{ op: 'set_time', preset: 'night' }], 1],
  ['fog', [{ op: 'set_weather', kind: 'fog' }]],
  ['be the photographer', [{ op: 'possess', actor: { desc: 'photographer' } }]],
  ['switch to rico', [{ op: 'possess', actor: { desc: 'rico' } }]],
  ['be myself', [{ op: 'possess', actor: { id: 'me' } }]],
  ['director', [{ op: 'set_mode', mode: 'director' }]],
  ['replay', [{ op: 'replay_take', take: 'set', actor: { id: 'me' } }]],
  ['undo that', [{ op: 'undo', n: 1 }], 1],
  ['mark beat drop', [{ op: 'mark_beat', label: 'drop' }]],
  ['dance', [{ op: 'play_anim', actor: { id: 'me' }, clip: 'dance' }]],
];

describe('parseUtterance — the scripted suite', () => {
  it.each(SUITE)('%s', (text, acts, deictics = 0) => {
    const u = parseUtterance(text);
    expect(u.unknown).toEqual([]);
    expect(u.acts).toEqual(acts);
    expect(u.deicticTotal).toBe(deictics);
  });

  it('splits a direction into clauses, numbering the deictics across the whole utterance', () => {
    const u = parseUtterance('Camera low, follow the car, then put that there and action.');
    expect(u.acts.map((a) => a.op)).toEqual(['camera', 'camera', 'move', 'record']);
    expect(u.deicticTotal).toBe(2);
    const move = u.acts[2] as Extract<SceneAct, { op: 'move' }>;
    expect(move.obj).toEqual({ deictic: 'that', ordinal: 1 });
    expect(move.place).toEqual({ deictic: 'there', ordinal: 2 });
  });

  it('reports what it did not understand instead of guessing', () => {
    const u = parseUtterance('make it pop, camera low');
    expect(u.acts).toEqual([{ op: 'camera', shot: 'low' }]);
    expect(u.unknown).toEqual(['make it pop']);
    expect(parseUtterance('').acts).toEqual([]);
    expect(parseUtterance('spawn that').unknown).toEqual(['spawn that']); // "that" is not an asset
  });

  it('replies to a question are not scene acts: yes / no / the left one', () => {
    expect(parseUtterance('yes').clauses[0]).toEqual({ text: 'yes', act: null, meta: { kind: 'confirm' } });
    expect(parseUtterance('nope').clauses[0]!.meta).toEqual({ kind: 'cancel' });
    expect(parseUtterance('the left one').clauses[0]!.meta).toEqual({ kind: 'pick', which: 'left' });
    expect(parseUtterance('closer one').clauses[0]!.meta).toEqual({ kind: 'pick', which: 'near' });
    expect(parseUtterance('the other one').clauses[0]!.meta).toEqual({ kind: 'pick', which: 'second' });
    expect(parseUtterance('closer').acts).toEqual([{ op: 'camera', shot: 'close' }]); // a bare "closer" is still a shot
    expect(parseUtterance('yes').unknown).toEqual([]);
  });
});
