/**
 * Subtitles (goal.md AUD-1 placeholder, UX-1): one line at the bottom centre — "Photographer: Say: camera low, follow
 * me." — that fades after a few seconds. Cached voice lines route through here until TTS lands; then it keeps
 * captioning them. Never eats pointer input.
 */
export interface Subtitles {
  say(speaker: string, line: string, holdMs?: number): void;
  clear(): void;
  readonly el: HTMLElement;
}

const STYLE_ID = 'coast-subtitles-css';
const CSS = `
#coast-sub{position:fixed;left:50%;bottom:max(64px,calc(env(safe-area-inset-bottom,0px) + 64px));transform:translateX(-50%);z-index:32;max-width:min(680px,90vw);padding:8px 14px;border-radius:10px;background:rgba(11,10,16,.72);color:#f2ecdc;font:15px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;pointer-events:none;user-select:none;opacity:0;transition:opacity .25s ease;text-shadow:0 1px 1px rgba(0,0,0,.5)}
#coast-sub[data-on="1"]{opacity:1}
#coast-sub b{color:#ffb54a;font-weight:600;margin-right:.4em}
@media (max-width:640px){#coast-sub{bottom:max(200px,calc(env(safe-area-inset-bottom,0px) + 200px));font-size:14px}}
`;

export function createSubtitles(parent: HTMLElement): Subtitles {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const el = document.createElement('div');
  el.id = 'coast-sub';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  const who = document.createElement('b');
  const text = document.createElement('span');
  el.append(who, text);
  parent.appendChild(el);
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    el,
    say(speaker, line, holdMs = 3800) {
      who.textContent = `${speaker}:`;
      text.textContent = line;
      el.dataset.on = '1';
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        el.dataset.on = '0';
        timer = null;
      }, holdMs);
    },
    clear() {
      if (timer) clearTimeout(timer);
      timer = null;
      el.dataset.on = '0';
    },
  };
}
