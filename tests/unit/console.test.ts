// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { DeixisBuffer } from '../../packages/engine/src/intents/intents';
import type { SceneOps } from '../../packages/director/src/executor';
import { DirectorConsole, summarize } from '../../apps/web/src/director/console';

/** goal.md DIR-1 fallback: the `/` bar directs through the same executor the voice model will drive. */
function ops(log: string[]): SceneOps {
  return {
    byDescription: (d) => (/car/.test(d) ? ['lowrider'] : []),
    positionOf: () => [0, 0, 0],
    radiusOf: () => 1,
    move: () => false,
    rotate: () => false,
    scale: () => false,
    remove: () => false,
    setMaterial: () => false,
    spawn: () => null,
    setTime: (p) => {
      log.push(`time ${p}`);
      return true;
    },
    setWeather: () => false,
    setLook: () => false,
    setLoadout: () => 'nothing unlocked yet',
    possess: () => false,
    playAnim: () => false,
    replay: () => false,
    record: () => false,
    markBeat: () => false,
    undo: () => 0,
    camera: (r) => {
      log.push(`camera ${JSON.stringify(r)}`);
      return true;
    },
    setMode: () => true,
  };
}

describe('DirectorConsole', () => {
  it('opens on demand, takes the keyboard, directs on Enter and hands the keyboard back', () => {
    document.body.innerHTML = '';
    const log: string[] = [];
    const focus = vi.fn();
    const outcomes: string[] = [];
    const c = new DirectorConsole(document.body, ops(log), new DeixisBuffer(), {
      mode: () => 'director',
      forward: () => [0, -1],
      onOutcome: (text, o) => outcomes.push(`${text} → ${summarize(o)}`),
      onFocus: focus,
    });
    const el = document.getElementById('coast-say') as HTMLDivElement;
    const input = el.querySelector('input') as HTMLInputElement;
    expect(el.style.display).toBe('none');
    c.toggle();
    expect(el.style.display).toBe('flex');
    expect(focus).toHaveBeenLastCalledWith(true);
    input.value = 'camera low, follow the car, golden hour, make it pop';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(el.style.display).toBe('none'); // closed first: direct, then play
    expect(focus).toHaveBeenLastCalledWith(false);
    expect(log).toEqual(['camera {"shot":"low"}', 'camera {"followId":"lowrider"}', 'time golden']);
    expect(outcomes).toEqual([
      'camera low, follow the car, golden hour, make it pop → ✓ camera low · ✓ follow the car · ✓ golden hour · ✗ didn\'t get "make it pop"',
    ]);
    expect(c.history).toHaveLength(1);
    expect(c.lastOutcome?.results.map((r) => r.ok)).toEqual([true, true, true, false]);
    c.show();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(c.isOpen).toBe(false);
  });

  it('samples pointing every nth frame but never drops a click', () => {
    document.body.innerHTML = '';
    const buffer = new DeixisBuffer();
    const c = new DirectorConsole(document.body, ops([]), buffer, {
      mode: () => 'director',
      forward: () => [0, -1],
      onOutcome: () => {},
      onFocus: () => {},
    });
    for (let i = 0; i < 6; i++) c.sample({ t: i * 16, pointerHit: 'crate_1' }, 3);
    expect(buffer.between(0, 1000)).toHaveLength(2); // frames 0 and 3
    c.sample({ t: 100, clickEdge: true }, 3);
    expect(buffer.between(0, 1000)).toHaveLength(3);
  });
});
