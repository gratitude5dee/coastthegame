/**
 * Cut assembly (goal.md STU cut assembly): what goes over the picture. A title card (mission · section), the
 * director's markers ("mark beat drop") at their times, an end card. Pure: the exporter draws these. The mission's
 * look is not a caption — it is the post LUT the engine renders through (`packages/engine/src/render/looks.ts`).
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
