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

describe('missionCard control package', () => {
  const verdict: Verdict = { missionId: 'm1', takeId: 't1', stars: 3, results: [] };

  it('shows two labelled bounded inputs and calls the span callback without downloading', () => {
    const card = createMissionCard(document.body);
    const onExportControl = vi.fn();
    card.verdict(verdict, { onExportControl, controlDurationS: 12.4 });
    const inputs = Array.from(card.el.querySelectorAll<HTMLInputElement>('.mc-control input'));
    expect(inputs).toHaveLength(2);
    expect(inputs.map((field) => field.parentElement!.textContent)).toEqual(['Start (s)', 'End (s)']);
    expect(inputs.map((field) => [field.type, field.min, field.max, field.value])).toEqual([
      ['number', '0', '12.4', '0'],
      ['number', '0', '12.4', '5'],
    ]);
    const button = q<HTMLButtonElement>(card.el, '[data-act="export-control"]');
    expect(button.textContent).toBe('Control package');
    expect(card.el.querySelector('a')).toBeNull();
    button.click();
    expect(onExportControl).toHaveBeenCalledTimes(1);
    expect(onExportControl).toHaveBeenCalledWith({ startS: 0, endS: 5 });
    expect(card.el.querySelector('a')).toBeNull();
    expect(q(card.el, '.mc-control-status').textContent).toBe('Preparing control package');
  });

  it.each([0.5, 3, 5, 8])('defaults to at most 5 seconds for a %s second take', (duration) => {
    const card = createMissionCard(document.body);
    const callback = vi.fn();
    card.verdict(verdict, { onExportControl: callback, controlDurationS: duration });
    q<HTMLButtonElement>(card.el, '[data-act="export-control"]').click();
    expect(callback).toHaveBeenCalledWith({ startS: 0, endS: Math.min(5, duration) });
  });

  it.each([
    ['', '4'],
    ['NaN', '4'],
    ['Infinity', '4'],
    ['-1', '4'],
    ['4', '4'],
    ['4', '3'],
    ['0', '5.01'],
    ['7', '12.1'],
    ['0', ''],
    ['0', 'Infinity'],
  ])('does not interact for invalid start=%s end=%s and leaves actions enabled', (start, end) => {
    const card = createMissionCard(document.body);
    const onExportControl = vi.fn();
    const onPlayback = vi.fn();
    card.verdict(verdict, { onExportControl, onPlayback, controlDurationS: 12 });
    q<HTMLInputElement>(card.el, '[name="control-start"]').value = start;
    q<HTMLInputElement>(card.el, '[name="control-end"]').value = end;
    const button = q<HTMLButtonElement>(card.el, '[data-act="export-control"]');
    button.click();
    expect(onExportControl).not.toHaveBeenCalled();
    expect(onPlayback).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(q<HTMLButtonElement>(card.el, '[data-act="playback"]').disabled).toBe(false);
    expect(q(card.el, '.mc-control-status').textContent).toContain('Choose a valid start and end');
    expect(q(card.el, '[name="control-start"]').getAttribute('aria-invalid')).toBe('true');
    expect(card.el.querySelector('[data-act="download-control"]')).toBeNull();
  });

  it.each([0, -1, NaN, Infinity])('rejects unusable total duration %s', (duration) => {
    const card = createMissionCard(document.body);
    const callback = vi.fn();
    card.verdict(verdict, { onExportControl: callback, controlDurationS: duration });
    q<HTMLButtonElement>(card.el, '[data-act="export-control"]').click();
    expect(callback).not.toHaveBeenCalled();
  });

  it('accepts a valid edited fractional span and clears validation state', () => {
    const card = createMissionCard(document.body);
    const callback = vi.fn();
    card.verdict(verdict, { onExportControl: callback, controlDurationS: 10 });
    const start = q<HTMLInputElement>(card.el, '[name="control-start"]');
    const end = q<HTMLInputElement>(card.el, '[name="control-end"]');
    start.value = '6';
    q<HTMLButtonElement>(card.el, '[data-act="export-control"]').click();
    start.value = '2.25';
    end.value = '7.25';
    q<HTMLButtonElement>(card.el, '[data-act="export-control"]').click();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ startS: 2.25, endS: 7.25 });
    expect(start.getAttribute('aria-invalid')).toBe('false');
  });

  it.each(['ready', 'failed'] as const)(
    'locks conflicting actions immediately, rejects repeated clicks and restores prior disabled state on %s',
    (finish) => {
      const card = createMissionCard(document.body);
      const control = vi.fn();
      const playback = vi.fn();
      const cut = vi.fn();
      const portrait = vi.fn();
      card.verdict(verdict, {
        onExportControl: control,
        onPlayback: playback,
        onExport: cut,
        onExportPortrait: portrait,
        controlDurationS: 9,
      });
      const inputs = Array.from(card.el.querySelectorAll<HTMLInputElement>('input'));
      const buttons = Array.from(card.el.querySelectorAll<HTMLButtonElement>('button'));
      const before = buttons.map((button) => button.disabled);
      expect(before[0]).toBe(true);
      const button = q<HTMLButtonElement>(card.el, '[data-act="export-control"]');
      button.click();
      card.controlProgress(1, 90);
      card.controlProgress(2, 90);
      expect(q(card.el, '.mc-control-status').textContent).toBe('Control package: rendering 2 / 90');
      expect(q(card.el, '.mc-control').getAttribute('aria-busy')).toBe('true');
      for (const input of inputs) expect(input.disabled).toBe(true);
      for (const action of buttons) {
        expect(action.disabled).toBe(true);
        action.click();
        action.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      expect(control).toHaveBeenCalledTimes(1);
      expect(playback).not.toHaveBeenCalled();
      expect(cut).not.toHaveBeenCalled();
      expect(portrait).not.toHaveBeenCalled();
      if (finish === 'ready') card.controlReady('blob:control', 'coast-control.tar');
      else card.controlFailed('<img src=x onerror=alert(1)>');
      expect(buttons.map((action) => action.disabled)).toEqual(before);
      for (const input of inputs) expect(input.disabled).toBe(false);
      expect(q(card.el, '.mc-control').getAttribute('aria-busy')).toBe('false');
      expect(card.el.querySelector('img')).toBeNull();
      if (finish === 'failed')
        expect(q(card.el, '.mc-control-status').textContent).toBe('Control package failed: <img src=x onerror=alert(1)>');
      button.click();
      expect(control).toHaveBeenCalledTimes(2);
      expect(card.el.querySelector('[data-act="download-control"]')).toBeNull();
    },
  );

  it('creates a real second-step TAR download link and keeps cut progress/download separate', () => {
    const card = createMissionCard(document.body);
    card.verdict(verdict, { onExportControl: vi.fn(), onExport: vi.fn() });
    card.exportProgress(1, 30);
    const cut = q<HTMLButtonElement>(card.el, '[data-act="export"]');
    card.controlProgress(2, 60);
    expect(cut.textContent).toBe('rendering 1 / 30');
    const linkClick = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    card.controlReady('blob:control', 'my-control.tar');
    expect(linkClick).not.toHaveBeenCalled();
    const dl = q<HTMLAnchorElement>(card.el, '[data-act="download-control"]');
    expect(dl.textContent).toBe('Download .tar');
    expect(dl.getAttribute('href')).toBe('blob:control');
    expect(dl.download).toBe('my-control.tar');
    expect(cut.disabled).toBe(true);
    card.exportReady('blob:cut', 'cut.mp4');
    expect(q<HTMLAnchorElement>(card.el, '[data-act="cut"]').download).toBe('cut.mp4');
    expect(dl.getAttribute('href')).toBe('blob:control');
    card.controlReady('blob:control-2', 'other.tar');
    expect(card.el.querySelectorAll('[data-act="download-control"]')).toHaveLength(1);
    linkClick.mockRestore();
  });

  it('restores controls when the callback throws and renders the exception as literal text', () => {
    const card = createMissionCard(document.body);
    card.verdict(verdict, {
      onExportControl: () => {
        throw new Error('<script>bad()</script>');
      },
    });
    const button = q<HTMLButtonElement>(card.el, '[data-act="export-control"]');
    button.click();
    expect(button.disabled).toBe(false);
    expect(q(card.el, '.mc-control-status').textContent).toBe('Control package failed: <script>bad()</script>');
    expect(card.el.querySelector('script')).toBeNull();
  });

  it('omits controls without a callback and clears old feedback on brief/update/new verdict', () => {
    const card = createMissionCard(document.body);
    card.verdict(verdict);
    expect(card.el.querySelector('.mc-control')).toBeNull();
    for (const reset of [() => card.brief(MISSION_LOW_AND_SLOW), () => card.update([], 0, false, 0, 3), () => card.verdict(verdict)]) {
      card.verdict(verdict, { onExportControl: vi.fn() });
      card.controlProgress(1, 2);
      reset();
      card.controlReady('blob:old', 'old.tar');
      card.controlFailed('old error');
      expect(card.el.querySelector('.mc-control')).toBeNull();
    }
  });

  it('makes verdict overflow scrollable and contains keyboard events inside the number inputs', () => {
    const card = createMissionCard(document.body);
    card.verdict(verdict, { onExportControl: vi.fn() });
    const css = document.getElementById('coast-mission-card-css')!.textContent!;
    expect(css).toMatch(/\.mc\[data-view="verdict"\]\{[^}]*overflow-y:auto;pointer-events:auto/);
    const keyboard = vi.fn();
    document.body.addEventListener('keydown', keyboard);
    q<HTMLInputElement>(card.el, '[name="control-start"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(keyboard).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', keyboard);
  });
});
