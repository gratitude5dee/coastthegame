/**
 * Cut assembly (goal.md STU cut assembly, MIS-6 looks): what goes over the picture. A title card (mission · section ·
 * look), the director's markers ("mark beat drop") at their times, an end card, and a look = a simple grade the
 * compositor applies (LUTs proper arrive with the art direction pack). Pure: the exporter draws these.
 */
import type { TakeV1 } from './takes';

export interface Caption {
  /** Seconds in the cut. */
  from: number;
  to: number;
  text: string;
  kind: 'title' | 'marker' | 'end' | 'credit';
}

export interface CaptionOptions {
  title: string;
  /** e.g. "Verse 2 · bars 9–16" */
  subtitle?: string;
  durationS: number;
  /** Takes on the set — their `marker` world edits become captions. */
  takes?: TakeV1[];
  /** Shown on the end card under "$COAST the Game". */
  credit?: string;
  titleSeconds?: number;
  endSeconds?: number;
}

/** The caption track for a cut of `durationS`, in time order. */
export function captionTrack(o: CaptionOptions): Caption[] {
  const out: Caption[] = [];
  const titleS = Math.min(o.titleSeconds ?? 2.5, o.durationS);
  const endS = Math.min(o.endSeconds ?? 2, Math.max(0, o.durationS - titleS));
  if (titleS > 0) out.push({ from: 0, to: titleS, text: o.subtitle ? `${o.title}\n${o.subtitle}` : o.title, kind: 'title' });
  for (const take of o.takes ?? []) {
    for (const e of take.worldEdits) {
      if (e.kind !== 'marker' || e.t >= o.durationS) continue;
      out.push({ from: e.t, to: Math.min(o.durationS, e.t + 1.5), text: e.label, kind: 'marker' });
    }
  }
  if (endS > 0) {
    out.push({ from: o.durationS - endS, to: o.durationS, text: '$COAST the Game', kind: 'end' });
    if (o.credit) out.push({ from: o.durationS - endS, to: o.durationS, text: o.credit, kind: 'credit' });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Captions visible at `tS`. */
export function captionsAt(track: Caption[], tS: number): Caption[] {
  return track.filter((c) => tS >= c.from && tS < c.to);
}

/** A look's grade as CSS filter functions the 2D compositor can apply (canvas `ctx.filter`). */
export const LOOKS: Record<string, { filter: string; vignette: number; label: string }> = {
  '35mm-dusk': { filter: 'contrast(1.08) saturate(1.15) sepia(0.12)', vignette: 0.35, label: '35 mm dusk' },
  'vhs-1994': { filter: 'contrast(0.95) saturate(1.3) blur(0.4px)', vignette: 0.2, label: 'VHS 1994' },
  noir: { filter: 'grayscale(1) contrast(1.25)', vignette: 0.5, label: 'noir' },
  clean: { filter: 'none', vignette: 0, label: 'clean' },
};

export function lookFor(name: string | undefined) {
  return LOOKS[name ?? ''] ?? LOOKS.clean!;
}
