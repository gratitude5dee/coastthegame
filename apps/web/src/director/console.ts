/**
 * The director's console (goal.md DIR-1 fallback, §3.1 step 4): a `/` command bar where you type what you would say
 * — "camera low, follow the car", "put that there", "be the photographer", "action" — parsed by the grammar and run
 * by the ActExecutor against the game's SceneOps. The voice path (M5, OpenAI Realtime) drives the same executor with
 * tool calls; until a key lands this is the whole director, and it is what the e2e suite drives.
 *
 * Deixis: the game feeds pointer / selection / ground samples every few frames; a typed direction's "speech window"
 * is the last 4 s before Enter, so click the crate, click the spot, type "put that there".
 */
import type { DeixisBuffer, DeixisSample, RigMode } from '@coast/engine';
import { ActExecutor, type ActResult, type SceneOps, type UtteranceOutcome } from '@coast/director';

export interface ConsoleHooks {
  mode: () => RigMode;
  /** Speaker forward (XZ) — the camera's, so "left of the car" is screen-left. */
  forward: () => [number, number];
  /** Every direction's outcome, for subtitles / the HUD. */
  onOutcome: (text: string, outcome: UtteranceOutcome) => void;
  /** The bar took or released the keyboard (the game mutes its key provider while typing). */
  onFocus: (typing: boolean) => void;
}

const SPEECH_WINDOW_MS = 4000;

/** One line per clause: ✓ what happened · ? the question · ✗ the error. */
export function summarize(outcome: UtteranceOutcome): string {
  const parts: string[] = [];
  outcome.utterance.clauses.forEach((clause, i) => {
    const r = outcome.results[i];
    if (!r) return;
    if (r.ok) parts.push(`✓ ${clause.text}`);
    else if (r.question) parts.push(`? ${clause.text} — ${r.question}${r.affected.length > 1 ? ` (${r.affected.join(' / ')})` : ''}`);
    else parts.push(`✗ ${r.error ?? clause.text}`);
  });
  return parts.join(' · ');
}

export class DirectorConsole {
  readonly executor: ActExecutor;
  readonly el: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private open = false;
  private frameCounter = 0;
  lastOutcome: UtteranceOutcome | null = null;
  lastText = '';
  /** Directions given this session (the scripted-suite pass rate on a real device). */
  readonly history: { text: string; results: ActResult[] }[] = [];

  constructor(
    parent: HTMLElement,
    ops: SceneOps,
    readonly buffer: DeixisBuffer,
    private readonly hooks: ConsoleHooks,
  ) {
    this.executor = new ActExecutor(ops);
    this.el = document.createElement('div');
    this.el.id = 'coast-say';
    this.el.style.cssText =
      'position:fixed;left:50%;bottom:72px;transform:translateX(-50%);width:min(640px,92vw);z-index:40;display:none;gap:8px;align-items:center;' +
      'padding:8px 10px;border-radius:12px;background:rgba(11,10,16,.82);border:1px solid rgba(255,181,74,.45);backdrop-filter:blur(6px);' +
      'font:14px system-ui,sans-serif;color:#f2ecdc';
    const tag = document.createElement('span');
    tag.textContent = 'say';
    tag.style.cssText = 'color:#ffb54a;font-weight:600;letter-spacing:.08em;text-transform:uppercase;font-size:11px';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.placeholder = 'camera low, follow the car, then action — Enter to direct · Esc to close';
    this.input.setAttribute('aria-label', 'direct the scene');
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.style.cssText = 'flex:1;background:transparent;border:0;outline:0;color:inherit;font:inherit';
    this.el.append(tag, this.input);
    parent.appendChild(this.el);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.input.value.trim();
        this.input.value = '';
        this.close(); // hands the keyboard back to the game: direct, then play
        if (text) this.say(text);
      } else if (e.key === 'Escape') this.close();
    });
    this.input.addEventListener('blur', () => {
      if (this.open) this.close();
    });
  }

  get isOpen() {
    return this.open;
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.el.style.display = 'flex';
    this.hooks.onFocus(true);
    this.input.focus();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.el.style.display = 'none';
    this.input.blur();
    this.hooks.onFocus(false);
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  /** Direct the scene with a line of text (the bar, `?say=`, the e2e hook, later the voice transcript). */
  say(text: string, nowMs = performance.now()): UtteranceOutcome {
    const outcome = this.executor.say(text, {
      buffer: this.buffer,
      speech: { startMs: nowMs - SPEECH_WINDOW_MS, endMs: nowMs },
      mode: this.hooks.mode(),
      speakerForward: this.hooks.forward(),
    });
    this.lastText = text;
    this.lastOutcome = outcome;
    this.history.push({ text, results: outcome.results });
    this.hooks.onOutcome(text, outcome);
    return outcome;
  }

  /** Feed a pointing sample (called every frame; kept to ~30 Hz). */
  sample(s: DeixisSample, everyNthFrame = 2) {
    if (this.frameCounter++ % everyNthFrame !== 0 && !s.clickEdge) return;
    this.buffer.push(s);
  }

  dispose() {
    this.el.remove();
  }
}
