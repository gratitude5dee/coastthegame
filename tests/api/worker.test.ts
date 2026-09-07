import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { encodeTake } from '../../packages/studio/src/takes';
import { buildCutManifest } from '../../packages/studio/src/provenance';
import { planCut } from '../../packages/studio/src/export';
import { parseRange, LIMITS } from '../../workers/api/src/index';

/**
 * The Worker end to end (goal.md BE-1…BE-4, ACT-4, STU-3): workerd with emulated R2 / Durable Objects (`wrangler dev
 * --local`), a throw-away persistence dir, real HTTP. Sessions, size caps, the take codec's magic, range playback of
 * a cut, the share page, the budget ledger.
 */
const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION = 'test-session-0001';
let proc: ChildProcess | null = null;
let persist = '';

const req = (path: string, init: RequestInit = {}, session: string | null = SESSION) =>
  fetch(`${BASE}${path}`, { ...init, headers: { ...(session ? { 'x-coast-session': session } : {}), ...(init.headers ?? {}) } });

beforeAll(async () => {
  persist = mkdtempSync(join(tmpdir(), 'coast-wrangler-'));
  mkdirSync(join(process.cwd(), 'apps/web/dist'), { recursive: true }); // wrangler insists the assets dir exists (no build needed)
  proc = spawn(
    'pnpm',
    ['exec', 'wrangler', 'dev', '--local', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist, '--log-level', 'error'],
    {
      cwd: join(process.cwd(), 'workers/api'),
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
      stdio: 'ignore',
    },
  );
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('wrangler dev did not come up');
}, 100_000);

afterAll(() => {
  proc?.kill('SIGTERM');
  if (persist) rmSync(persist, { recursive: true, force: true });
});

function fakeTake(id: string, seconds = 2) {
  const samples = [];
  for (let i = 0; i <= seconds * 30; i++) {
    samples.push({
      t: i / 30,
      pos: [i / 30, 0, 0] as [number, number, number],
      yaw: 0,
      speed: 1,
      grounded: true,
      driving: false,
      camPos: [0, 1.6, 2] as [number, number, number],
      camQuat: [0, 0, 0, 1] as [number, number, number, number],
    });
  }
  return encodeTake({ v: 1, id, actorId: 'player', cellVersion: 'v', hz: 30, startedAt: '', durationS: seconds, samples, worldEdits: [] });
}

describe('Worker API (workerd, local R2 + DO)', () => {
  it('health is open; everything else wants a well-formed session id', async () => {
    expect((await (await req('/api/health', {}, null)).json()).ok).toBe(true);
    expect((await req('/api/ledger', {}, null)).status).toBe(401);
    expect((await req('/api/ledger', {}, 'bad session!')).status).toBe(401);
    expect((await req('/api/nope')).status).toBe(404);
  });

  it('takes: upload (magic-checked, size-capped), list, fetch back byte for byte, per session', async () => {
    const bytes = fakeTake('take-1');
    const put = await req('/api/takes/take-1', { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' } });
    expect(put.status).toBe(200);
    expect((await put.json()).bytes).toBe(bytes.length);
    expect((await req('/api/takes/bad', { method: 'PUT', body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) })).status).toBe(400);
    expect((await req('/api/takes/x!', { method: 'PUT', body: bytes })).status).toBe(400); // ids are [A-Za-z0-9_-]
    const list = await (await req('/api/takes')).json();
    expect(list.takes.map((t: { id: string }) => t.id)).toEqual(['take-1']);
    const back = new Uint8Array(await (await req('/api/takes/take-1')).arrayBuffer());
    expect(back).toEqual(bytes);
    expect((await req('/api/takes/take-1', {}, 'another-session-00')).status).toBe(404);
    expect((await (await req('/api/takes', {}, 'another-session-00')).json()).takes).toEqual([]);
  });

  it('cuts: upload needs a video type, plays back with byte ranges, and the share page renders', async () => {
    const video = new Uint8Array(4096);
    for (let i = 0; i < video.length; i++) video[i] = i % 251;
    expect((await req('/api/cuts/cut-1', { method: 'PUT', body: video, headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    const put = await req('/api/cuts/cut-1', {
      method: 'PUT',
      body: video,
      headers: { 'content-type': 'video/mp4', 'x-coast-title': 'Low & slow' },
    });
    expect(put.status).toBe(200);
    const { share, url, video: videoUrl } = await put.json();
    expect(share).toMatch(/^[A-Za-z0-9_-]{16}$/); // a share token, never the session id
    expect(share).not.toContain(SESSION);
    expect(url).toBe(`/c/${share}`);
    // Re-uploading the same cut keeps its share link.
    const again = await req('/api/cuts/cut-1', { method: 'PUT', body: video, headers: { 'content-type': 'video/mp4' } });
    expect((await again.json()).share).toBe(share);
    const whole = await fetch(`${BASE}${videoUrl}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(video);
    const part = await fetch(`${BASE}${videoUrl}`, { headers: { range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/4096');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(video.subarray(100, 200));
    const tail = await fetch(`${BASE}${videoUrl}`, { headers: { range: 'bytes=4000-' } });
    expect(tail.headers.get('content-range')).toBe('bytes 4000-4095/4096');
    const page = await fetch(`${BASE}${url}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<video');
    expect(html).toContain('Low &amp; slow');
    expect((await fetch(`${BASE}/c/nope-nope-nope-nope`)).status).toBe(404);
    expect((await fetch(`${BASE}/api/cuts/nope-nope-nope-nope`)).status).toBe(404);
  });

  it('cuts carry a provenance manifest (STU-5): hash-checked upload, manifest next to the file, credits on the share page', async () => {
    const video = new Uint8Array(2048);
    for (let i = 0; i < video.length; i++) video[i] = (i * 7) % 253;
    const sha256 = createHash('sha256').update(video).digest('hex');
    // A wrong hash is refused before anything is stored; the right one is kept with the object.
    const wrong = await req('/api/cuts/cut-2', {
      method: 'PUT',
      body: video,
      headers: { 'content-type': 'video/mp4', 'x-coast-sha256': 'ff'.repeat(32) },
    });
    expect(wrong.status).toBe(400);
    expect(
      (await req('/api/cuts/cut-2/manifest', { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json' } })).status,
    ).toBe(404);
    const put = await req('/api/cuts/cut-2', {
      method: 'PUT',
      body: video,
      headers: { 'content-type': 'video/mp4', 'x-coast-title': 'Hop on the one', 'x-coast-sha256': sha256 },
    });
    expect(put.status).toBe(200);
    const { share, url } = await put.json();
    const manifest = buildCutManifest({
      id: 'cut-2',
      title: 'Hop on the one',
      missionId: 'm02-hop-on-the-one',
      trackId: 'coast-demo',
      barRange: [17, 20],
      bpm: 92,
      look: 'vhs-1994',
      takes: [
        {
          id: 'take-1',
          actorId: 'player',
          cellVersion: 'valley',
          durationS: 2,
          startedAt: '2026-09-07T10:00:00.000Z',
          samples: { length: 61 },
          worldEdits: { length: 1 },
        },
      ],
      plan: planCut({ durationS: 2, fps: 30 }),
      captions: { length: 3 },
      video: { bytes: video.length, mime: 'video/mp4', codec: 'avc', sha256 },
      author: { userId: SESSION },
      app: { version: '0.1.0', commit: 'test' },
    });
    // Not a manifest → 400 with the problems; a manifest for another cut id → 400; a hash that disagrees → 409.
    const bad = await req('/api/cuts/cut-2/manifest', {
      method: 'PUT',
      body: JSON.stringify({ v: 1 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).problems).toContain('kind must be coast-cut');
    expect(
      (
        await req('/api/cuts/cut-2/manifest', {
          method: 'PUT',
          body: JSON.stringify({ ...manifest, id: 'cut-9' }),
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req('/api/cuts/cut-2/manifest', {
          method: 'PUT',
          body: JSON.stringify({ ...manifest, video: { ...manifest.video, sha256: 'ee'.repeat(32) } }),
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(409);
    const ok = await req('/api/cuts/cut-2/manifest', {
      method: 'PUT',
      body: JSON.stringify(manifest),
      headers: { 'content-type': 'application/json' },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).summary).toBe('1 take · valley · 1080p30 · vhs-1994');
    // Public by the share token, like the cut itself; the share page carries the credits.
    const back = await (await fetch(`${BASE}/api/cuts/${share}/manifest`)).json();
    expect(back).toMatchObject({ v: 1, kind: 'coast-cut', id: 'cut-2', takes: ['take-1'], video: { sha256 } });
    const html = await (await fetch(`${BASE}${url}`)).text();
    expect(html).toContain('1 take · valley · 1080p30 · vhs-1994');
    expect(html).toContain('player · 2.0 s');
    expect(html).toContain(`sha256 ${sha256.slice(0, 12)}`);
    expect(html).toContain(`/api/cuts/${share}/manifest`);
    expect((await fetch(`${BASE}/api/cuts/nope-nope-nope-nope/manifest`)).status).toBe(404);
  });

  it('perf reports land in R2 and the dashboard lists them', async () => {
    const r = await req('/api/perf/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'desktop', device: 'Mac M2 · Chrome', fpsMean: 118.4, frameMsP95: 9.9 }),
    });
    expect(r.status).toBe(200);
    const big = await req('/api/perf/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(LIMITS.reportBytes) }),
    });
    expect(big.status).toBe(413);
    const list = await (await req('/api/perf/reports?days=1', {}, null)).json();
    expect(list.reports[0]).toMatchObject({ tier: 'desktop', fps: 118.4, p95: 9.9 });
    const html = await (await fetch(`${BASE}/perf`)).text();
    expect(html).toContain('Mac M2');
    expect(html).toContain('118');
  });

  it('the budget ledger debits per session and refuses past the cap (the Realtime secret is gated by it)', async () => {
    const before = await (await req('/api/ledger')).json();
    expect(before).toMatchObject({ spentUsd: 0, capUsd: 3 });
    // No OPENAI_API_KEY locally → 503 before any debit.
    expect((await req('/api/realtime/secret', { method: 'POST', body: '{}' })).status).toBe(503);
    expect((await (await req('/api/ledger')).json()).spentUsd).toBe(0);
  });

  it('parseRange covers the forms browsers send', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=200-300', 100)).toBeNull();
    expect(parseRange('items=1-2', 100)).toBeNull();
  });
});
