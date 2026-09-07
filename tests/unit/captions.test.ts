import { describe, it, expect } from 'vitest';
import { captionTrack, captionsAt, lookFor } from '../../packages/studio/src/captions';
import type { TakeV1 } from '../../packages/studio/src/takes';

/** goal.md STU cut assembly / MIS-6: title card, the director's markers, end card, a look per mission. */
const take = (edits: TakeV1['worldEdits']): TakeV1 => ({
  v: 1,
  id: 't',
  actorId: 'player',
  cellVersion: 'v',
  hz: 30,
  startedAt: '',
  durationS: 10,
  samples: [],
  worldEdits: edits,
});

describe('captionTrack', () => {
  it('opens on the title, drops markers at their times, closes on the end card + credit', () => {
    const track = captionTrack({
      title: 'Low & slow',
      subtitle: 'Verse 2 · bars 9–16',
      durationS: 10,
      credit: 'directed by GRATITUD3',
      takes: [
        take([
          { t: 4, kind: 'marker', label: 'drop' },
          { t: 12, kind: 'marker', label: 'late' },
          { t: 1, kind: 'propGrab', propId: 'can_1' },
        ]),
      ],
    });
    expect(track.map((c) => [c.kind, c.from, c.to])).toEqual([
      ['title', 0, 2.5],
      ['marker', 4, 5.5],
      ['end', 8, 10],
      ['credit', 8, 10],
    ]);
    expect(track[0]!.text).toBe('Low & slow\nVerse 2 · bars 9–16');
    expect(captionsAt(track, 1).map((c) => c.kind)).toEqual(['title']);
    expect(captionsAt(track, 4.2).map((c) => c.text)).toEqual(['drop']);
    expect(captionsAt(track, 6)).toEqual([]);
    expect(captionsAt(track, 9).map((c) => c.kind)).toEqual(['end', 'credit']);
  });

  it('fits short cuts (no end card when there is no room) and knows its looks', () => {
    const short = captionTrack({ title: 'x', durationS: 2 });
    expect(short.map((c) => c.kind)).toEqual(['title']);
    expect(short[0]!.to).toBe(2);
    expect(captionTrack({ title: 'x', durationS: 0 })).toEqual([]);
    expect(lookFor('35mm-dusk').label).toBe('35 mm dusk');
    expect(lookFor('nope').filter).toBe('none');
    expect(lookFor(undefined).vignette).toBe(0);
  });
});
