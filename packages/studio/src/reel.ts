/**
 * The reel (goal.md MIS-4): the music-video timeline that fills bar by bar as missions complete. One entry per
 * mission in the tutor's order — its bars on the track, the best verdict so far and the take that earned it — so
 * the studio can show progress, replay any earned shot, and later assemble the Coast Cut across missions (STU).
 * Pure; the game persists it (localStorage) and renders the strip.
 */
import type { Mission } from './missions';

export type Stars = 0 | 1 | 2 | 3;

export interface ReelEntry {
  missionId: string;
  title: string;
  bars: [number, number];
  stars: Stars;
  /** The take that holds the best verdict (null until a take was cut). */
  takeId: string | null;
  /** Newest exported cut of that mission (a share URL or blob URL), if any. */
  cutUrl: string | null;
}

export interface ReelState {
  v: 1;
  entries: Pick<ReelEntry, 'missionId' | 'stars' | 'takeId' | 'cutUrl'>[];
}

export class Reel {
  readonly entries: ReelEntry[];
  /** Bars in the track (the strip's length). */
  readonly totalBars: number;

  constructor(missions: Mission[], totalBars = 64) {
    this.entries = missions.map((m) => ({
      missionId: m.id,
      title: m.title,
      bars: [m.barRange[0], m.barRange[1]],
      stars: 0,
      takeId: null,
      cutUrl: null,
    }));
    this.totalBars = Math.max(totalBars, ...missions.map((m) => m.barRange[1]));
  }

  entry(missionId: string): ReelEntry | undefined {
    return this.entries.find((e) => e.missionId === missionId);
  }

  /** A take was judged: keep it when it beats (or first fills) the mission's best. Returns whether it is now the best. */
  record(missionId: string, stars: Stars, takeId: string): boolean {
    const e = this.entry(missionId);
    if (!e) return false;
    if (e.takeId && stars < e.stars) return false;
    e.stars = stars;
    e.takeId = takeId;
    return true;
  }

  setCut(missionId: string, cutUrl: string | null) {
    const e = this.entry(missionId);
    if (e) e.cutUrl = cutUrl;
  }

  /** Bars earned (≥ 1★) over the bars the missions cover, and over the whole track. */
  progress() {
    let earned = 0;
    let covered = 0;
    for (const e of this.entries) {
      const len = e.bars[1] - e.bars[0] + 1;
      covered += len;
      if (e.stars >= 1) earned += len;
    }
    return { earnedBars: earned, coveredBars: covered, totalBars: this.totalBars, fraction: covered ? earned / covered : 0 };
  }

  /** Missions earned so far, in track order (what a Coast Cut across missions would assemble). */
  earned(): ReelEntry[] {
    return this.entries.filter((e) => e.stars >= 1).sort((a, b) => a.bars[0] - b.bars[0]);
  }

  serialize(): ReelState {
    return { v: 1, entries: this.entries.map(({ missionId, stars, takeId, cutUrl }) => ({ missionId, stars, takeId, cutUrl })) };
  }

  /** Merge a saved state (unknown missions are ignored; blob: URLs never survive a reload). */
  restore(state: unknown) {
    const s = state as Partial<ReelState> | null;
    if (!s || s.v !== 1 || !Array.isArray(s.entries)) return;
    for (const saved of s.entries) {
      const e = this.entry(saved.missionId);
      if (!e) continue;
      e.stars = ([0, 1, 2, 3] as Stars[]).includes(saved.stars) ? saved.stars : 0;
      e.takeId = typeof saved.takeId === 'string' ? saved.takeId : null;
      e.cutUrl = typeof saved.cutUrl === 'string' && !saved.cutUrl.startsWith('blob:') ? saved.cutUrl : null;
    }
  }
}
