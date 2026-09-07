import { describe, it, expect } from 'vitest';
import { buildCutManifest, manifestSummary, validateManifest, MANIFEST_VERSION } from '../../packages/studio/src/provenance';
import { planCut } from '../../packages/studio/src/export';

/** goal.md STU-5: every exported cut carries a provenance manifest — cells, takes, shot, prompts, seeds, cost, bars. */
const take = (id: string, actorId: string, seconds: number, edits = 0, props = 0) => ({
  id,
  actorId,
  cellVersion: 'valley',
  durationS: seconds,
  startedAt: '2026-09-07T10:00:00.000Z',
  samples: { length: Math.round(seconds * 30) + 1 },
  worldEdits: { length: edits },
  props: { length: props },
});

const input = () => ({
  id: 'm01-abc',
  title: 'Low & slow',
  missionId: 'm01-low-and-slow',
  trackId: 'coast-01',
  barRange: [9, 16] as [number, number],
  bpm: 92,
  look: '35mm-dusk',
  takes: [take('t1', 'player', 12.4, 3, 1), take('t2', 'photographer', 8.03)],
  plan: planCut({ durationS: 12.4, fps: 30, bars: [9, 10], cameraLayer: 1 }),
  captions: { length: 4 },
  video: { bytes: 2_400_000, mime: 'video/mp4', codec: 'avc', sha256: 'ab'.repeat(32) },
  cells: [{ id: 'valley', version: 'valley' }],
  author: { userId: 'session-0001' },
  app: { version: '0.1.0', commit: 'e945f91' },
  createdAt: '2026-09-07T10:05:00.000Z',
});

describe('cut manifest (STU-5)', () => {
  it('retains independent public avatar and outfit snapshots per take, without source URLs or images', () => {
    const avatar = { id: 'coast', name: '$COAST', color: 0x123456, url: 'private-model', image: 'private-selfie' };
    const m = buildCutManifest({
      ...input(),
      takes: [{ ...take('t1', 'player', 2), avatar }, take('t2', 'player', 3)],
    });
    avatar.color = 0xffffff;
    expect(m.takeDetails[0]!.avatar).toEqual({ id: 'coast', name: '$COAST', color: 0x123456 });
    expect(m.takeDetails[1]).not.toHaveProperty('avatar');
    expect(JSON.stringify(m)).not.toContain('private-');
    expect(JSON.parse(JSON.stringify(m)).takeDetails[0].avatar).toEqual(m.takeDetails[0]!.avatar);
    expect(validateManifest(m)).toEqual([]);
  });

  it('records the takes, the cells they reference, the shot and the file — and stays a valid manifest', () => {
    const m = buildCutManifest(input());
    expect(m.v).toBe(MANIFEST_VERSION);
    expect(m.kind).toBe('coast-cut');
    expect(m.takes).toEqual(['t1', 't2']);
    expect(m.takeDetails[0]).toMatchObject({ id: 't1', actorId: 'player', durationS: 12.4, samples: 373, edits: 3, props: 1 });
    expect(m.cells).toEqual([{ id: 'valley', version: 'valley' }]);
    expect(m.shot).toMatchObject({
      cameraTake: 't2',
      fps: 30,
      width: 1920,
      height: 1080,
      aspect: '16:9',
      bars: [9, 10],
      look: '35mm-dusk',
      captions: 4,
    });
    expect(m.shot.frames).toBe(planCut({ durationS: 12.4, fps: 30, bars: [9, 10] }).frameCount);
    expect(m.audio).toEqual({ trackId: 'coast-01', bpm: 92, muxed: false });
    expect(m.video?.sha256).toBe('ab'.repeat(32));
    expect(m.generative).toEqual([]);
    expect(m.prompts).toEqual([]);
    expect(m.models).toEqual([]);
    expect(m.costUsd).toBe(0);
    expect(m.app).toEqual({ name: 'coast-the-game', version: '0.1.0', commit: 'e945f91' });
    expect(validateManifest(m)).toEqual([]);
    expect(validateManifest(JSON.parse(JSON.stringify(m)))).toEqual([]); // survives the wire
  });

  it('a take from another cell adds that cell; generative spans feed prompts, models, seeds and cost', () => {
    const i = input();
    i.takes.push({ ...take('t3', 'npc_a', 4), cellVersion: 'street@2026-09-07.1' });
    const m = buildCutManifest({
      ...i,
      generative: [
        { engine: 'fal', model: 'minimax/h3-max-turbo', prompt: 'golden hour, 35mm', seed: 7, span: [2, 7], costUsd: 0.12 },
        { engine: 'fal', model: 'wan/2.2-vace', prompt: 'faithful pass', seed: 9, span: [7, 12], costUsd: 0.3 },
      ],
      references: [{ kind: 'image', sha256: 'cd'.repeat(32), name: 'ref.jpg' }],
    });
    expect(m.cells.map((c) => c.id)).toEqual(['valley', 'street@2026-09-07.1']);
    expect(m.prompts).toEqual(['golden hour, 35mm', 'faithful pass']);
    expect(m.models).toEqual(['fal/minimax/h3-max-turbo', 'fal/wan/2.2-vace']);
    expect(m.seeds).toEqual([7, 9]);
    expect(m.costUsd).toBeCloseTo(0.42, 6);
    expect(m.userRefs).toEqual(['cd'.repeat(32)]);
    expect(manifestSummary(m)).toBe('3 takes · valley + street@2026-09-07.1 · 1080p30 · bars 9–10 · 35mm-dusk · 2 generative spans');
  });

  it('a portrait plan reads as portrait; the summary stays one line', () => {
    const i = input();
    i.plan = planCut({ durationS: 12.4, fps: 30, width: 1080, height: 1920 });
    const m = buildCutManifest(i);
    expect(m.shot.aspect).toBe('9:16');
    expect(m.shot.bars).toBeUndefined();
    expect(manifestSummary(m)).toBe('2 takes · valley · 1920p30 portrait · 35mm-dusk');
  });

  it('validation names what is wrong with a manifest off the wire', () => {
    expect(validateManifest(null)).toEqual(['not an object']);
    expect(validateManifest({})).toContain('v must be 1');
    const m = buildCutManifest(input());
    expect(validateManifest({ ...m, id: 'no spaces here!' })).toEqual(['id']);
    expect(validateManifest({ ...m, author: {} })).toEqual(['author']);
    expect(validateManifest({ ...m, takeDetails: new Array(17).fill(m.takeDetails[0]) })).toEqual(['takeDetails']);
    expect(validateManifest({ ...m, createdAt: 'yesterday' })).toEqual(['createdAt']);
  });
});
