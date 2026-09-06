// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLoadingScreen } from '../../apps/web/src/ui/loading';

/** goal.md UX-3: weighted stages → one bar, reveal timed by the game (next beat), and a stall fallback so it never looks stuck. */
describe('loading screen', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const width = (el: HTMLElement) => Number.parseInt((el.querySelector('.cl-fill') as HTMLElement).style.width || '0', 10);

  it('starts hidden, shows on begin, fills by stage weight and wipes when every stage is done', () => {
    const s = createLoadingScreen(document.body, 'WASD');
    expect(s.visible).toBe(false);
    s.begin('Valley', { stages: ['fetch', 'lod', 'physics'] });
    expect(s.visible).toBe(true);
    expect(s.el.querySelector('.cl-title')!.textContent).toBe('Valley');
    expect(s.el.querySelector('.cl-note')!.textContent).toMatch(/streaming/);
    s.progress('fetch', 0.5);
    expect(width(s.el)).toBe(Math.round(0.55 * 0.5 * 100));
    s.progress('fetch', 1);
    s.progress('lod', 1);
    expect(width(s.el)).toBe(85);
    expect(s.el.querySelector('.cl-note')!.textContent).toMatch(/physics/);
    s.progress('physics', 1);
    expect(width(s.el)).toBe(100);
    vi.advanceTimersByTime(1); // reveal delay 0 → wipe starts
    expect(s.el.dataset.wipe).toBe('1');
    expect(s.visible).toBe(true);
    vi.advanceTimersByTime(700);
    expect(s.visible).toBe(false);
  });

  it('only waits for the stages the load declares and never goes backwards', () => {
    const s = createLoadingScreen(document.body, '');
    s.begin('Butterfly', { stages: ['fetch', 'lod'] });
    s.progress('fetch', 1);
    s.progress('fetch', 0.2); // late, smaller report is ignored
    expect(width(s.el)).toBe(Math.round((0.55 / 0.85) * 100));
    s.progress('lod', 1);
    vi.advanceTimersByTime(700);
    expect(s.visible).toBe(false);
  });

  it('delays the wipe by what reveal() returns (the next beat), capped', () => {
    const s = createLoadingScreen(document.body, '');
    s.reveal = () => 400;
    s.begin('Pier');
    s.finish();
    vi.advanceTimersByTime(350);
    expect(s.el.dataset.wipe).toBeUndefined();
    vi.advanceTimersByTime(60);
    expect(s.el.dataset.wipe).toBe('1');
    s.reveal = () => 9_999;
    s.begin('Pier again');
    s.finish();
    vi.advanceTimersByTime(1510);
    expect(s.el.dataset.wipe).toBe('1');
  });

  it('steps aside after the stall timeout and still finishes later; hide() is immediate; begin() cancels a pending reveal', () => {
    const s = createLoadingScreen(document.body, '');
    s.begin('Slow cell', { stallAfterMs: 1000 });
    vi.advanceTimersByTime(1001);
    expect(s.el.dataset.stalled).toBe('1');
    expect(s.el.querySelector('.cl-note')!.textContent).toMatch(/background/);
    s.finish();
    vi.advanceTimersByTime(700);
    expect(s.visible).toBe(false);
    expect(s.el.dataset.stalled).toBeUndefined();

    s.begin('A');
    s.finish();
    s.begin('B'); // a new load before the wipe: the old reveal must not hide the new card
    vi.advanceTimersByTime(2000);
    expect(s.visible).toBe(true);
    expect(s.el.querySelector('.cl-title')!.textContent).toBe('B');
    s.hide();
    expect(s.visible).toBe(false);
  });
});
