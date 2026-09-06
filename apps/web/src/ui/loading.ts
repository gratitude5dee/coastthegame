/**
 * Loading choreography (goal.md UX-3, UX-1): a diegetic title card while the block streams in — wordmark, the cell's
 * name, one progress bar fed by weighted stages (fetch → detail (LoD) → physics), a "how to play" strip — then a
 * reveal wipe that the game can time to the next beat. It never eats input, never blocks the render loop, and can
 * never look stuck: after `stallAfterMs` it steps aside ("still loading in the background") and finishes later.
 *
 * Vanilla TS + CSS, no assets. The pano-skybox step (Marble `pano_url` before the 100k splats) plugs in as another stage.
 */

export type LoadStage = 'fetch' | 'lod' | 'physics';

export interface LoadingOptions {
  /** Stages this load needs before the reveal (default: all three). */
  stages?: LoadStage[];
  /** After this long without completing, fade back so the player can look around (default 30 s). */
  stallAfterMs?: number;
}

export interface LoadingScreen {
  /** Show the card for a (new) load. Resets progress. */
  begin(title: string, opts?: LoadingOptions): void;
  /** Report a stage's fraction (0..1). When every required stage reaches 1 the reveal runs (via `reveal`). */
  progress(stage: LoadStage, fraction: number, note?: string): void;
  /** Force completion now (e.g. a scene without physics). */
  finish(): void;
  /** Hide immediately, no animation (deterministic screenshots). */
  hide(): void;
  /**
   * Called when everything is loaded; return the delay in ms before the wipe (0 = now). The game returns the time to
   * the next beat so the reveal lands on the music (UX-3). Default: no delay.
   */
  reveal: (() => number) | null;
  readonly el: HTMLElement;
  readonly visible: boolean;
}

const WEIGHTS: Record<LoadStage, number> = { fetch: 0.55, lod: 0.3, physics: 0.15 };
const NOTES: Record<LoadStage, string> = { fetch: 'streaming the block', lod: 'building detail', physics: 'waking up physics' };
const WIPE_MS = 650;

const STYLE_ID = 'coast-loading-css';
/** Same rules as the static card in index.html (kept there so the card paints before the bundle arrives). */
const CSS = `
#coast-load{position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:radial-gradient(120% 90% at 50% 110%,#1a1424 0%,#0b0a10 60%);color:#f2ecdc;font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;pointer-events:none;user-select:none;-webkit-user-select:none;transition:opacity .35s ease}
#coast-load[hidden]{display:none}
#coast-load[data-stalled="1"]{opacity:.55}
#coast-load[data-wipe="1"]{animation:coast-wipe ${WIPE_MS}ms cubic-bezier(.7,0,.2,1) forwards}
.cl-mark{font-size:44px;font-weight:800;letter-spacing:.22em;color:#ffb54a;text-shadow:0 0 28px rgba(255,181,74,.35)}
.cl-mark small{display:block;margin-top:2px;font-size:11px;font-weight:600;letter-spacing:.34em;color:rgba(242,236,220,.55)}
.cl-title{font-variant:small-caps;letter-spacing:.14em;font-size:14px;color:rgba(242,236,220,.85);min-height:1.4em}
.cl-bar{position:relative;width:min(320px,70vw);height:3px;border-radius:2px;background:rgba(242,236,220,.14);overflow:hidden}
.cl-fill{position:absolute;inset:0 auto 0 0;width:0;border-radius:2px;background:#ffb54a;transition:width .25s ease}
.cl-bar[data-indeterminate="1"] .cl-fill{width:30%;animation:coast-sweep 1.2s ease-in-out infinite}
.cl-note{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:rgba(242,236,220,.55);min-height:1.4em}
.cl-help{position:absolute;left:0;right:0;bottom:max(18px,env(safe-area-inset-bottom,0px));text-align:center;font-size:11px;color:rgba(242,236,220,.5);letter-spacing:.06em;padding:0 16px}
@keyframes coast-wipe{to{clip-path:inset(0 0 100% 0)}}
@keyframes coast-sweep{0%{left:-30%}100%{left:100%}}
@media (prefers-reduced-motion:reduce){#coast-load[data-wipe="1"]{animation:none;opacity:0}.cl-bar[data-indeterminate="1"] .cl-fill{animation:none;width:100%;opacity:.4}}
`;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createLoadingScreen(parent: HTMLElement, help: string): LoadingScreen {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  // Adopt the static card from index.html when present (it has been on screen since before the bundle arrived).
  const el =
    document.getElementById('coast-load') ??
    (() => {
      const card = h('div', '');
      card.id = 'coast-load';
      card.setAttribute('role', 'status');
      card.setAttribute('aria-live', 'polite');
      const mark = h('div', 'cl-mark', '$COAST');
      mark.append(h('small', '', 'THE GAME'));
      const bar = h('div', 'cl-bar');
      bar.append(h('div', 'cl-fill'));
      card.append(mark, h('div', 'cl-title'), bar, h('div', 'cl-note'), h('div', 'cl-help'));
      card.hidden = true;
      parent.appendChild(card);
      return card;
    })();
  const title = el.querySelector('.cl-title') as HTMLElement;
  const bar = el.querySelector('.cl-bar') as HTMLElement;
  const fill = el.querySelector('.cl-fill') as HTMLElement;
  const note = el.querySelector('.cl-note') as HTMLElement;
  (el.querySelector('.cl-help') as HTMLElement).textContent = help;

  let stages: LoadStage[] = ['fetch', 'lod', 'physics'];
  const done: Record<LoadStage, number> = { fetch: 0, lod: 0, physics: 0 };
  let gen = 0;
  let finished = true;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let revealTimer: ReturnType<typeof setTimeout> | null = null;

  function overall() {
    const total = stages.reduce((a, s) => a + WEIGHTS[s], 0) || 1;
    return stages.reduce((a, s) => a + WEIGHTS[s] * Math.min(1, Math.max(0, done[s])), 0) / total;
  }

  function paint(customNote?: string) {
    const o = overall();
    if (o > 0)
      delete bar.dataset.indeterminate; // sweep until the first real byte, then a true bar
    else bar.dataset.indeterminate = '1';
    fill.style.width = `${Math.round(o * 100)}%`;
    const active = stages.find((s) => done[s] < 1);
    note.textContent = customNote ?? (active ? `${NOTES[active]}…` : 'ready');
  }

  function clearTimers() {
    if (stallTimer) clearTimeout(stallTimer);
    if (revealTimer) clearTimeout(revealTimer);
    stallTimer = revealTimer = null;
  }

  function complete() {
    if (finished) return;
    finished = true;
    const my = gen;
    paint('ready');
    const delay = Math.max(0, Math.min(1500, screen.reveal?.() ?? 0));
    revealTimer = setTimeout(() => {
      if (my !== gen) return;
      el.dataset.wipe = '1';
      revealTimer = setTimeout(() => {
        if (my !== gen) return;
        el.hidden = true;
        delete el.dataset.wipe;
        delete el.dataset.stalled;
      }, WIPE_MS + 30);
    }, delay);
  }

  const screen: LoadingScreen = {
    el,
    reveal: null,
    get visible() {
      return !el.hidden;
    },
    begin(t, opts = {}) {
      gen++;
      clearTimers();
      stages = opts.stages ?? ['fetch', 'lod', 'physics'];
      done.fetch = done.lod = done.physics = 0;
      finished = false;
      title.textContent = t;
      delete el.dataset.wipe;
      delete el.dataset.stalled;
      el.hidden = false;
      paint();
      const my = gen;
      stallTimer = setTimeout(() => {
        if (my === gen && !finished) {
          el.dataset.stalled = '1';
          paint('still loading in the background — you can look around');
        }
      }, opts.stallAfterMs ?? 30_000);
    },
    progress(stage, fraction, customNote) {
      if (finished) return;
      done[stage] = Math.max(done[stage], Math.min(1, Math.max(0, fraction)));
      paint(customNote);
      if (stages.every((s) => done[s] >= 1)) complete();
    },
    finish() {
      for (const s of stages) done[s] = 1;
      complete();
    },
    hide() {
      gen++;
      clearTimers();
      finished = true;
      el.hidden = true;
      delete el.dataset.wipe;
      delete el.dataset.stalled;
    },
  };
  return screen;
}
