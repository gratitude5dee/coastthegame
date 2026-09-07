/**
 * Rewards & progression (goal.md MIS-4): stars unlock outfits, lenses (24/35/50/85), hydraulic patterns, time presets
 * and NPC cameos. Two sources of unlocks, both derived from the reel so nothing else needs saving: each mission's own
 * `reward.unlock` the moment the mission is earned (≥ 1★), and a ladder over the stars collected across the reel.
 * The catalogue names what an unlock *is* so the game can apply it (a lens in mm, a hop sequence, a colour, a preset,
 * a person); the 24 mm lens, the neutral looks and golden hour are free — the golden path never waits on a star.
 */
import type { Mission } from './missions';
import type { Reel } from './reel';

export type UnlockKind = 'lens' | 'pattern' | 'time' | 'outfit' | 'cameo';

export interface UnlockBase {
  id: string;
  kind: UnlockKind;
  label: string;
}
export interface LensUnlock extends UnlockBase {
  kind: 'lens';
  mm: number;
}
/** A hop sequence the beat-driven hydraulics (H) run through, one step per beat. */
export interface PatternUnlock extends UnlockBase {
  kind: 'pattern';
  sequence: ('front' | 'back' | 'left' | 'right' | 'all' | 'FL' | 'FR' | 'RL' | 'RR')[];
}
export interface TimeUnlock extends UnlockBase {
  kind: 'time';
  preset: 'noon' | 'golden' | 'blue' | 'night' | 'fog_noon';
}
/** An outfit is a colour on the placeholder body until the rigs land (CHR-2's three outfits then map onto these ids). */
export interface OutfitUnlock extends UnlockBase {
  kind: 'outfit';
  color: number;
}
/** A person who shows up in the hub once earned. */
export interface CameoUnlock extends UnlockBase {
  kind: 'cameo';
  npc: { id: string; name: string; color: number; lines: string[] };
}
export type Unlock = LensUnlock | PatternUnlock | TimeUnlock | OutfitUnlock | CameoUnlock;

export const UNLOCKS: Record<string, Unlock> = {
  'lens-35mm': { id: 'lens-35mm', kind: 'lens', label: '35 mm lens', mm: 35 },
  'lens-50mm': { id: 'lens-50mm', kind: 'lens', label: '50 mm lens', mm: 50 },
  'lens-85mm': { id: 'lens-85mm', kind: 'lens', label: '85 mm lens', mm: 85 },
  'hydraulics-three-wheel': {
    id: 'hydraulics-three-wheel',
    kind: 'pattern',
    label: 'three-wheel motion',
    sequence: ['FL', 'FR', 'RR', 'RL'],
  },
  'hydraulics-pancake': { id: 'hydraulics-pancake', kind: 'pattern', label: 'the pancake', sequence: ['all', 'front', 'all', 'back'] },
  'time-night': { id: 'time-night', kind: 'time', label: 'night', preset: 'night' },
  'time-fog': { id: 'time-fog', kind: 'time', label: 'fog noon', preset: 'fog_noon' },
  'outfit-gold': { id: 'outfit-gold', kind: 'outfit', label: 'the gold fit', color: 0xffd23f },
  'outfit-chrome': { id: 'outfit-chrome', kind: 'outfit', label: 'the chrome fit', color: 0xcfd8e3 },
  'cameo-dj': {
    id: 'cameo-dj',
    kind: 'cameo',
    label: 'DJ Coast drops by',
    npc: { id: 'dj_coast', name: 'DJ Coast', color: 0xff3fa4, lines: ['Bars 9 to 24 are yours.', 'Cut it on the one.'] },
  },
};

/** Always available: the wide lens, the classic hop, day and golden hour, the default fit. */
export const FREE_LENS_MM = 24;
export const FREE_TIME_PRESETS: TimeUnlock['preset'][] = ['noon', 'golden', 'blue'];
export const CLASSIC_PATTERN: PatternUnlock['sequence'] = ['front', 'back', 'left', 'right'];

/** The ladder: total stars across the reel → unlock ids (each rung once). */
export const STAR_LADDER: { stars: number; unlock: string }[] = [
  { stars: 2, unlock: 'time-night' },
  { stars: 3, unlock: 'lens-50mm' },
  { stars: 4, unlock: 'outfit-gold' },
  { stars: 5, unlock: 'hydraulics-pancake' },
  { stars: 6, unlock: 'lens-85mm' },
  { stars: 6, unlock: 'cameo-dj' },
  { stars: 8, unlock: 'time-fog' },
  { stars: 9, unlock: 'outfit-chrome' },
];

/** Stars collected across the reel (the best verdict of every mission). */
export function totalStars(reel: Pick<Reel, 'entries'>): number {
  return reel.entries.reduce((n, e) => n + e.stars, 0);
}

/** Every unlock the reel has earned, in the order it earned them: mission rewards first (track order), then the ladder. */
export function unlocksFor(reel: Pick<Reel, 'entries'>, missions: Pick<Mission, 'id' | 'reward'>[]): string[] {
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && UNLOCKS[id] && !out.includes(id)) out.push(id);
  };
  for (const e of reel.entries) {
    if (e.stars < 1) continue;
    add(missions.find((m) => m.id === e.missionId)?.reward.unlock);
  }
  const stars = totalStars(reel);
  for (const rung of STAR_LADDER) if (stars >= rung.stars) add(rung.unlock);
  return out;
}

/** What the next star would bring (for the verdict card's nudge), or null when the ladder is done. */
export function nextUnlock(reel: Pick<Reel, 'entries'>): { stars: number; unlock: Unlock; starsToGo: number } | null {
  const stars = totalStars(reel);
  const rung = STAR_LADDER.find((r) => r.stars > stars);
  if (!rung) return null;
  return { stars: rung.stars, unlock: UNLOCKS[rung.unlock]!, starsToGo: rung.stars - stars };
}

/** The catalogue lens a focal length asks for (the nearest of 24/35/50/85), and whether it is free. */
export function lensFor(mm: number): { mm: number; unlock: LensUnlock | null } {
  const stops = [
    FREE_LENS_MM,
    ...Object.values(UNLOCKS)
      .filter((u): u is LensUnlock => u.kind === 'lens')
      .map((u) => u.mm),
  ];
  const nearest = stops.reduce((best, s) => (Math.abs(s - mm) < Math.abs(best - mm) ? s : best), stops[0]!);
  const unlock = Object.values(UNLOCKS).find((u): u is LensUnlock => u.kind === 'lens' && u.mm === nearest) ?? null;
  return { mm: nearest, unlock };
}

/** Which rung (if any) still stands between the reel and `id` — for the "locked — 3★ unlocks it" line. */
export function starsNeeded(id: string, reel: Pick<Reel, 'entries'>, missions: Pick<Mission, 'id' | 'reward'>[]): number {
  if (unlocksFor(reel, missions).includes(id)) return 0;
  const rung = STAR_LADDER.find((r) => r.unlock === id);
  if (rung) return Math.max(0, rung.stars - totalStars(reel));
  const m = missions.find((x) => x.reward.unlock === id);
  return m ? 1 : Infinity; // a mission reward: one star on that mission; unknown ids never unlock
}

/** Unlocks by kind, in earned order. */
export function unlocksOfKind<K extends UnlockKind>(ids: string[], kind: K): Extract<Unlock, { kind: K }>[] {
  return ids.map((id) => UNLOCKS[id]).filter((u): u is Extract<Unlock, { kind: K }> => !!u && u.kind === kind);
}
