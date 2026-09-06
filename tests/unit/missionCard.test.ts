// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMissionCard } from '../../apps/web/src/ui/missionCard';
import { ShotMeter, MISSION_LOW_AND_SLOW, type MeterSample, type Verdict } from '../../packages/studio/src/missions';

/**
 * Mission card (goal.md MIS-1…3, UX-1/UX-4) rendered in happy-dom: brief → chips, live update → bars/values/REC clock,
 * verdict → stars, ≤3 hints, Retake/Playback/Download with 44 px touch targets that accept pointer events.
 */
const frame = (over: Partial<MeterSample> = {}): MeterSample => ({
  t: 0,
  cameraHeightM: 0.42,
  cameraPitchDeg: -4,
  subjectInFrame: true,
  timePreset: 'golden',
  cell: 'valley',
  ...over,
});

const q = <T extends Element>(root: Element, sel: string) => root.querySelector<T>(sel)!;
const texts = (root: Element, sel: string) => Array.from(root.querySelectorAll(sel)).map((e) => e.textContent);

beforeEach(() => {
  document.body.replaceChildren();
  document.getElementById('coast-mission-card-css')?.remove();
});

describe('missionCard', () => {
  it('brief() renders the clapperboard: title, subtitle, one chip per constraint with its goal, idle state; CSS injected once', () => {
    const card = createMissionCard(document.body);
    createMissionCard(document.body);
    expect(document.querySelectorAll('#coast-mission-card-css')).toHaveLength(1);
    expect(document.getElementById('coast-mission-card-css')!.textContent).toContain('prefers-reduced-motion');

    card.brief(MISSION_LOW_AND_SLOW);
    expect(card.el.hidden).toBe(false);
    expect(q(card.el, '.mc-title').textContent).toBe('Mission·Low & slow');
    expect(q(card.el, '.mc-sub').textContent).toBe('Verse 2 · bars 9–16 · look: 35mm dusk');
    expect(q(card.el, '.mc-take').textContent).toBe('takes 0/3');
    expect(texts(card.el, '.mc-chip .mc-k')).toEqual(['height', 'subject', 'light', 'length']);
    expect(texts(card.el, '.mc-chip .mc-g')).toEqual(['≤ 0.9 m', 'crate ≥ 70%', 'golden', '6 s ±25%']);
    expect(q(card.el, '.mc-state').textContent).toBe('Press Enter or ACTION to roll');
    expect(q<HTMLElement>(card.el, '.mc-verdict').hidden).toBe(true);

    card.setStatus('Say: camera low, follow me.');
    expect(q(card.el, '.mc-state').textContent).toBe('Say: camera low, follow me.');
    card.hide();
    expect(card.el.hidden).toBe(true);
  });

  it('update() drives the chips from ShotMeter.live(): fill = score, pass colour, value text, REC clock and take count', () => {
    const card = createMissionCard(document.body);
    card.brief(MISSION_LOW_AND_SLOW);
    const meter = new ShotMeter(MISSION_LOW_AND_SLOW);
    for (let i = 0; i < 10; i++) meter.push(frame({ t: i / 30, subjectInFrame: i < 4 })); // 40% subject → 0.4/0.7 = 57% fill, failing

    card.update(meter.live(4.2), 4.2, true, 1, 3);
    const chips = Array.from(card.el.querySelectorAll<HTMLElement>('.mc-chip'));
    const byKind = Object.fromEntries(chips.map((c) => [c.dataset.kind, c]));
    expect(byKind.cameraHeight!.dataset.pass).toBe('1');
    expect(q<HTMLElement>(byKind.cameraHeight!, '.mc-fill').style.width).toBe('100%');
    expect(q(byKind.cameraHeight!, '.mc-val').textContent).toBe('0.42 m');
    expect(byKind.subjectInFrame!.dataset.pass).toBe('0');
    expect(q<HTMLElement>(byKind.subjectInFrame!, '.mc-fill').style.width).toBe('57%');
    expect(q(byKind.subjectInFrame!, '.mc-val').textContent).toBe('40%');
    expect(q(byKind.duration_s!, '.mc-val').textContent).toBe('4.2 / 6 s');
    expect(q<HTMLElement>(byKind.duration_s!, '.mc-fill').style.width).toBe('70%');
    expect(q(byKind.timePreset!, '.mc-val').textContent).toBe('golden');

    const state = q<HTMLElement>(card.el, '.mc-state');
    expect(state.dataset.rec).toBe('1');
    expect(state.textContent).toBe('● REC 00:04');
    expect(q(card.el, '.mc-take').textContent).toBe('takes 1/3');

    card.update(meter.live(0), 0, false, 1, 3);
    expect(state.dataset.rec).toBe('0');
    expect(state.textContent).toBe('Press Enter or ACTION to roll');
  });

  it('verdict() shows ★ 0–3, at most three numeric hints, and 44 px buttons that accept pointer events; Retake counts takes left', () => {
    const card = createMissionCard(document.body);
    card.brief(MISSION_LOW_AND_SLOW);
    const meter = new ShotMeter(MISSION_LOW_AND_SLOW);
    for (let i = 0; i < 60; i++) meter.push(frame({ t: i / 30, cameraHeightM: 1.3 }));
    card.update(meter.live(6), 6, true, 1, 3);
    const v = meter.finish(6);
    expect(v.stars).toBe(2);

    const onRetake = vi.fn();
    const onPlayback = vi.fn();
    card.verdict(v, { downloadUrl: 'blob:take-1', onRetake, onPlayback });

    expect(card.el.dataset.view).toBe('verdict');
    expect(q(card.el, '.mc-state').textContent).toBe('CUT — verdict');
    expect(q(card.el, '.mc-stars').getAttribute('aria-label')).toBe('2 of 3 stars');
    expect(texts(card.el, '.mc-stars span')).toEqual(['★', '★', '☆']);
    expect(card.el.querySelectorAll('.mc-stars .on')).toHaveLength(2);
    expect(texts(card.el, '.mc-hints li')).toEqual(['camera too high — 1.3 m, keep it under 0.9 m']);
    expect(q<HTMLElement>(card.el, '.mc-chip[data-kind="cameraHeight"]').dataset.pass).toBe('0');

    const retake = q<HTMLButtonElement>(card.el, '[data-act="retake"]');
    expect(retake.textContent).toBe('Retake (2 left)');
    expect(retake.disabled).toBe(false);
    retake.click();
    expect(onRetake).toHaveBeenCalledTimes(1);
    q<HTMLButtonElement>(card.el, '[data-act="playback"]').click();
    expect(onPlayback).toHaveBeenCalledTimes(1);

    const dl = q<HTMLAnchorElement>(card.el, 'a[data-act="download"]');
    expect(dl.textContent).toBe('Download .webm');
    expect(dl.getAttribute('href')).toBe('blob:take-1');
    expect(dl.getAttribute('download')).toBe('m01-low-and-slow-m01-low-and-slow-take-1.webm');

    // Touch targets: the buttons are the only interactive surface of an otherwise pass-through card.
    const btnCss = /\.mc-btn\{[^}]*\}/.exec(document.getElementById('coast-mission-card-css')!.textContent!)![0];
    expect(btnCss).toContain('pointer-events:auto');
    expect(btnCss).toContain('min-height:44px');
    expect(btnCss).toContain('min-width:44px');
    expect(/\.mc\{[^}]*pointer-events:none/.test(document.getElementById('coast-mission-card-css')!.textContent!)).toBe(true);

    // A clean take, no takes left: three stars, no hints, Retake disabled.
    const clean: Verdict = {
      missionId: 'm01-low-and-slow',
      takeId: 't3',
      results: v.results.map((r) => ({ ...r, pass: true, hint: undefined })),
      stars: 3,
    };
    card.update(meter.live(6), 6, false, 3, 3);
    expect(card.el.dataset.view).toBe('meter'); // a new take resets the view
    card.verdict(clean, { onRetake, downloadUrl: 'blob:take-3', downloadName: 'low-and-slow-3.webm' });
    expect(card.el.querySelectorAll('.mc-stars .on')).toHaveLength(3);
    expect(texts(card.el, '.mc-hints li')).toEqual(['clean take — print it']);
    expect(q<HTMLButtonElement>(card.el, '[data-act="retake"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>(card.el, '[data-act="retake"]').textContent).toBe('No takes left');
    expect(q<HTMLAnchorElement>(card.el, 'a[data-act="download"]').getAttribute('download')).toBe('low-and-slow-3.webm');
    expect(card.el.querySelector('[data-act="playback"]')).toBeNull();
  });
});
