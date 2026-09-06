import type { Constraint, ConstraintResult, Mission, Verdict } from '@coast/studio';

/**
 * Mission card (goal.md §3.3 MIS-1…3, UX-1, UX-4): the tutor's brief as a clapperboard — title, one chip per constraint
 * fed by the shot meter, a state line (roll / ● REC / CUT), and the verdict (★, ≤3 numeric hints, Retake / Playback /
 * Download). Vanilla TS + CSS, no assets. The card never eats pointer input (look-drag passes through to the canvas);
 * only its buttons are interactive.
 *
 * Layout: fixed top-right, ≤340 px wide. On narrow screens it becomes a bottom sheet; when the device has touch it sits
 * above the virtual buttons while metering (`--coast-touch-bottom`, default 328 px, on `:root` moves it if the touch
 * layout changes) and drops to the bottom edge for the verdict, which is taller.
 */
export interface MissionCard {
  /** Show the brief for a mission (resets to the meter view, idle state). */
  brief(m: Mission): void;
  /** Per-frame: chip scores from `ShotMeter.live()` (same order as `mission.constraints`), the clock, and the take count. */
  update(results: ConstraintResult[], elapsedS: number, recording: boolean, takesUsed: number, takesMax: number): void;
  /** Show the judge's verdict (MIS-3). Buttons/links appear only for the options that are provided. */
  verdict(v: Verdict, opts?: { downloadUrl?: string; downloadName?: string; onRetake?: () => void; onPlayback?: () => void }): void;
  /** Override the idle state line (e.g. the tutor's example command). Cleared by the next `brief()`. */
  setStatus(text: string): void;
  hide(): void;
  readonly el: HTMLElement;
}

const STYLE_ID = 'coast-mission-card-css';
const IDLE_STATUS = 'Press Enter or ACTION to roll';

const CSS = `
.mc{position:fixed;top:max(12px,env(safe-area-inset-top,0px));right:12px;z-index:30;box-sizing:border-box;width:min(340px,calc(100vw - 24px));max-width:340px;padding:13px 14px 12px;color:#f2ecdc;background:rgba(11,10,16,.8);border:1px solid rgba(242,236,220,.18);border-radius:12px;font:12px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;pointer-events:none;user-select:none;-webkit-user-select:none;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);text-shadow:0 1px 1px rgba(0,0,0,.4);max-height:calc(100vh - 24px);overflow:hidden}
.mc::before{content:"";position:absolute;left:0;right:0;top:0;height:4px;background:repeating-linear-gradient(-45deg,rgba(242,236,220,.75) 0 7px,rgba(11,10,16,.9) 7px 14px);opacity:.6}
.mc[hidden]{display:none}
.mc-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.mc-title{min-width:0;font-variant:small-caps;letter-spacing:.14em;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-kicker{color:#ffb54a}
.mc-sep{margin:0 .35em;color:rgba(242,236,220,.4)}
.mc-take{flex:none;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:rgba(242,236,220,.55)}
.mc-sub{margin-top:2px;font-size:11px;color:rgba(242,236,220,.62);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-chips{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.mc-chip{display:grid;grid-template-columns:minmax(0,138px) minmax(20px,1fr) 56px;align-items:center;gap:8px;font-size:11px}
.mc-label{display:flex;gap:5px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-k{font-weight:600;letter-spacing:.04em}
.mc-g{font-size:10px;color:rgba(242,236,220,.5);overflow:hidden;text-overflow:ellipsis}
.mc-bar{position:relative;height:3px;border-radius:2px;background:rgba(242,236,220,.14);overflow:hidden}
.mc-fill{position:absolute;top:0;bottom:0;left:0;width:0;border-radius:2px;background:#ffb54a;transition:width .2s ease,background-color .2s ease}
.mc-chip[data-pass="1"] .mc-fill{background:#9be34a}
.mc-val{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:rgba(242,236,220,.85)}
.mc-chip[data-pass="1"] .mc-val{color:#9be34a}
.mc-state{margin-top:10px;font-size:11px;letter-spacing:.06em;color:rgba(242,236,220,.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-state[data-rec="1"]{color:#ff5252;font-weight:700}
.mc-state[data-rec="1"] .mc-dot{display:inline-block;animation:mc-blink 1s steps(2,start) infinite}
.mc-verdict{margin-top:10px;padding-top:10px;border-top:1px solid rgba(242,236,220,.12)}
.mc-verdict[hidden]{display:none}
.mc-stars{font-size:26px;line-height:1;letter-spacing:.12em;color:rgba(242,236,220,.22)}
.mc-stars .on{color:#ffb54a;text-shadow:0 0 12px rgba(255,181,74,.45)}
.mc-aes{margin-top:4px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:rgba(242,236,220,.5)}
.mc-hints{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:12px}
.mc-hints li::before{content:"→ ";color:#ffb54a}
.mc-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.mc-btn{pointer-events:auto;touch-action:manipulation;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:44px;min-width:44px;padding:0 16px;border-radius:8px;border:1px solid rgba(242,236,220,.25);background:rgba(242,236,220,.06);color:#f2ecdc;font:600 12px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.06em;text-decoration:none;cursor:pointer;text-shadow:none;-webkit-tap-highlight-color:transparent}
.mc-btn:hover{background:rgba(242,236,220,.12)}
.mc-btn[data-act="retake"]{background:#ffb54a;border-color:#ffb54a;color:#0b0a10}
.mc-btn[data-act="retake"]:hover{background:#ffc46b}
.mc-btn:disabled{opacity:.4;cursor:default;pointer-events:none}
@keyframes mc-blink{to{visibility:hidden}}
@media (max-width:640px){
  .mc{top:auto;left:8px;right:8px;bottom:calc(12px + env(safe-area-inset-bottom,0px));width:auto;max-width:none}
  .mc[data-touch="1"]{bottom:var(--coast-touch-bottom,328px)}
  .mc[data-view="verdict"]{bottom:calc(12px + env(safe-area-inset-bottom,0px))}
}
@media (prefers-reduced-motion:reduce){.mc-fill{transition:none}.mc-state[data-rec="1"] .mc-dot{animation:none}}
`;

const LABELS: Record<Constraint['kind'], string> = {
  cameraHeight: 'height',
  cameraAngle: 'angle',
  subjectInFrame: 'subject',
  timePreset: 'light',
  duration_s: 'length',
  beatSync: 'beat',
  cell: 'cell',
  lens_mm: 'lens',
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
function band(min: number | undefined, max: number | undefined, unit: string): string {
  const u = unit === '°' ? '°' : ` ${unit}`;
  if (min !== undefined && max !== undefined) return `${min}–${max}${u}`;
  if (max !== undefined) return `≤ ${max}${u}`;
  if (min !== undefined) return `≥ ${min}${u}`;
  return '';
}
/** The target the chip is measured against, in the player's words: "≤ 0.9 m", "crate ≥ 70%", "golden", "6 s ±25%". */
function goalText(c: Constraint): string {
  switch (c.kind) {
    case 'cameraHeight':
      return band(c.min_m, c.max_m, 'm');
    case 'cameraAngle':
      return band(c.pitchMin, c.pitchMax, '°');
    case 'subjectInFrame':
      return `${c.subject.replace(/_\d+$/, '').replace(/_/g, ' ')} ≥ ${pct(c.minShare)}`;
    case 'timePreset':
      return c.is.replace(/_/g, ' ');
    case 'duration_s':
      return `${c.target} s ±${pct(c.tolerance)}`;
    case 'beatSync':
      return `${c.event} ±${c.window_ms} ms`;
    case 'cell':
      return c.is;
    case 'lens_mm':
      return band(c.min, c.max, 'mm');
  }
}

function clock(elapsedS: number): string {
  const s = Math.max(0, Math.floor(elapsedS));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  return `${mm}:${String(s % 60).padStart(2, '0')}`;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

interface Chip {
  el: HTMLLIElement;
  fill: HTMLSpanElement;
  val: HTMLSpanElement;
  width: string;
  pass: string;
  text: string;
}

export function createMissionCard(parent: HTMLElement): MissionCard {
  injectStyle();

  const el = h('aside', 'mc');
  el.setAttribute('aria-live', 'polite');
  el.dataset.view = 'meter';
  el.dataset.touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0 ? '1' : '0';

  const head = h('div', 'mc-head');
  const title = h('div', 'mc-title');
  const take = h('span', 'mc-take');
  head.append(title, take);
  const sub = h('div', 'mc-sub');
  const chips = h('ul', 'mc-chips');
  const state = h('div', 'mc-state');
  const verdictEl = h('div', 'mc-verdict');
  verdictEl.hidden = true;
  el.append(head, sub, chips, state, verdictEl);
  parent.appendChild(el);

  let mission: Mission | undefined;
  let chipList: Chip[] = [];
  let idleStatus = IDLE_STATUS;
  let takesUsed = 0;
  let takesMax = 3;

  function setState(text: string, rec = false) {
    state.dataset.rec = rec ? '1' : '0';
    if (rec) {
      state.replaceChildren(h('span', 'mc-dot', '●'), document.createTextNode(` ${text}`));
    } else state.textContent = text;
  }

  function buildChips(entries: { kind: Constraint['kind']; goal: string }[]) {
    chips.replaceChildren();
    chipList = entries.map(({ kind, goal }) => {
      const li = h('li', 'mc-chip');
      li.dataset.kind = kind;
      li.dataset.pass = '0';
      const label = h('span', 'mc-label');
      label.append(h('span', 'mc-k', LABELS[kind]));
      if (goal) label.append(h('span', 'mc-g', goal));
      const bar = h('span', 'mc-bar');
      const fill = h('span', 'mc-fill');
      bar.append(fill);
      const val = h('span', 'mc-val', '—');
      li.append(label, bar, val);
      chips.append(li);
      return { el: li, fill, val, width: '', pass: '0', text: '—' };
    });
  }

  function paintChips(results: ConstraintResult[]) {
    if (results.length !== chipList.length || results.some((r, i) => chipList[i]!.el.dataset.kind !== r.kind)) {
      // Results that do not line up with the brief (or no brief yet): rebuild from the results themselves.
      buildChips(
        results.map((r, i) => ({ kind: r.kind, goal: mission?.constraints[i]?.kind === r.kind ? goalText(mission.constraints[i]!) : '' })),
      );
    }
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const chip = chipList[i]!;
      const width = `${Math.round(Math.max(0, Math.min(1, r.score)) * 100)}%`;
      if (width !== chip.width) chip.fill.style.width = chip.width = width;
      const pass = r.pass ? '1' : '0';
      if (pass !== chip.pass) chip.el.dataset.pass = chip.pass = pass;
      const text = r.text ?? pct(r.score);
      if (text !== chip.text) chip.val.textContent = chip.text = text;
    }
  }

  function setTakes(used: number, max: number) {
    takesUsed = used;
    takesMax = max;
    take.textContent = `takes ${used}/${max}`;
  }

  const card: MissionCard = {
    el,
    brief(m) {
      mission = m;
      idleStatus = IDLE_STATUS;
      title.replaceChildren(h('span', 'mc-kicker', 'Mission'), h('span', 'mc-sep', '·'), h('span', 'mc-name', m.title));
      sub.textContent = `${m.section ? `${m.section} · ` : ''}bars ${m.barRange[0]}–${m.barRange[1]} · look: ${m.look.replace(/-/g, ' ')}`;
      buildChips(m.constraints.map((c) => ({ kind: c.kind, goal: goalText(c) })));
      setTakes(0, m.takesMax);
      verdictEl.hidden = true;
      verdictEl.replaceChildren();
      el.dataset.view = 'meter';
      setState(idleStatus);
      el.hidden = false;
    },
    update(results, elapsedS, recording, used, max) {
      if (el.dataset.view !== 'meter') {
        el.dataset.view = 'meter';
        verdictEl.hidden = true;
        verdictEl.replaceChildren();
      }
      paintChips(results);
      if (used !== takesUsed || max !== takesMax) setTakes(used, max);
      if (recording) setState(`REC ${clock(elapsedS)}`, true);
      else if (state.textContent !== idleStatus) setState(idleStatus);
      el.hidden = false;
    },
    verdict(v, opts = {}) {
      paintChips(v.results);
      el.dataset.view = 'verdict';
      setState('CUT — verdict');

      const stars = h('div', 'mc-stars');
      stars.setAttribute('role', 'img');
      stars.setAttribute('aria-label', `${v.stars} of 3 stars`);
      for (let i = 0; i < 3; i++) stars.append(h('span', i < v.stars ? 'on' : 'off', i < v.stars ? '★' : '☆'));

      const hints = h('ul', 'mc-hints');
      const lines = v.results.filter((r) => r.hint).slice(0, 3);
      if (lines.length === 0) hints.append(h('li', '', 'clean take — print it'));
      for (const r of lines) hints.append(h('li', '', r.hint!));

      const actions = h('div', 'mc-actions');
      const left = Math.max(0, takesMax - takesUsed);
      const retake = h('button', 'mc-btn', left > 0 ? `Retake (${left} left)` : 'No takes left');
      retake.type = 'button';
      retake.dataset.act = 'retake';
      retake.disabled = left === 0 || !opts.onRetake;
      retake.addEventListener('click', () => opts.onRetake?.());
      actions.append(retake);
      if (opts.onPlayback) {
        const play = h('button', 'mc-btn', 'Playback');
        play.type = 'button';
        play.dataset.act = 'playback';
        play.addEventListener('click', () => opts.onPlayback?.());
        actions.append(play);
      }
      if (opts.downloadUrl) {
        const dl = h('a', 'mc-btn', 'Download .webm');
        dl.dataset.act = 'download';
        dl.href = opts.downloadUrl;
        dl.download = opts.downloadName ?? `${v.missionId}-${v.takeId}.webm`;
        actions.append(dl);
      }

      verdictEl.replaceChildren(stars);
      if (v.aesthetic) verdictEl.append(h('div', 'mc-aes', `look ${Math.round(v.aesthetic.score)} / 10 · advisory`));
      verdictEl.append(hints, actions);
      verdictEl.hidden = false;
      el.hidden = false;
    },
    setStatus(text) {
      idleStatus = text;
      if (el.dataset.view === 'meter' && state.dataset.rec !== '1') setState(text);
    },
    hide() {
      el.hidden = true;
    },
  };
  return card;
}
