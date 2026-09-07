/**
 * Cloudflare Worker API (goal.md BE-1…BE-4, AF-7 Hono). Everything vendor-facing goes through here behind the
 * per-session budget ledger (BE-2, `SessionDO`); user data (takes, cuts, perf reports) lands in R2 keyed by session.
 *
 *   GET  /api/health                     liveness + environment
 *   POST /api/realtime/secret            ephemeral OpenAI Realtime client secret (DIR-1) — ledger-gated
 *   GET  /api/ledger                     this session's spend
 *   POST /api/perf/report                real-device perf report → R2 (BE-3)
 *   GET  /api/perf/reports?days=7        recent reports (the /perf dashboard reads these)
 *   GET  /perf                           the dashboard (HTML)
 *   PUT  /api/takes/:id · GET /api/takes · GET /api/takes/:id      take.bin per session (ACT-4)
 *   PUT  /api/cuts/:id  · GET /api/cuts/:id (range-aware) · GET /c/:id (share page)   Coast Cuts (STU-3)
 *   PUT  /api/cuts/:id/manifest · GET /api/cuts/:share/manifest     provenance manifest next to the cut (STU-5)
 *
 * Sessions are a client-minted id in `x-coast-session` (guest); OAuth + wallet sign-in (ID-*) binds them later.
 * Local dev: `pnpm --filter @coast/api dev` runs workerd with emulated R2/DO; the Vite dev server proxies /api to it.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { manifestSummary, validateManifest, type CutManifest } from '../../../packages/studio/src/provenance';

export interface Env {
  ASSETS: Fetcher;
  ASSETS_BUCKET: R2Bucket;
  USER_BUCKET: R2Bucket;
  CONFIG: KVNamespace;
  JOBS: Queue<JobMessage>;
  SESSION: DurableObjectNamespace;
  JOB: DurableObjectNamespace;
  ENVIRONMENT: string;
  DAILY_SPEND_CAP_USD: string;
  SESSION_SPEND_CAP_USD: string;
  ALLOWED_ORIGIN?: string; // e.g. https://coast.wzrd.tech (dev: http://localhost:5173)
  OPENAI_API_KEY?: string;
}

export type JobMessage =
  | { type: 'world'; jobId: string; sessionId: string; input: unknown }
  | { type: 'avatar'; jobId: string; sessionId: string; input: unknown }
  | { type: 'prop'; jobId: string; sessionId: string; input: unknown }
  | { type: 'video'; jobId: string; sessionId: string; input: unknown };

/** Limits (BE-4): what a guest session may push. */
export const LIMITS = {
  reportBytes: 16 * 1024,
  takeBytes: 4 * 1024 * 1024, // ≈ 40 min of 30 Hz poses; a 60 s take is ~95 KB
  cutBytes: 64 * 1024 * 1024, // 60 s of 1080p30 H.264 at 8 Mb/s
  manifestBytes: 32 * 1024,
  takesPerSession: 200,
  cutsPerSession: 50,
} as const;

const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** Per-session budget ledger entry (BE-2). */
export interface LedgerEntry {
  t: string;
  what: string;
  usd: number;
}

export interface Ledger {
  spentUsd: number;
  capUsd: number;
  calls: LedgerEntry[];
}

type Variables = { session: string };

export function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.use('/api/*', async (c, next) => {
    const origin = c.env.ALLOWED_ORIGIN ?? 'http://localhost:5173';
    return cors({
      origin,
      allowHeaders: ['content-type', 'x-coast-session', 'range'],
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
      exposeHeaders: ['content-range', 'accept-ranges', 'etag', 'content-length'],
    })(c, next);
  });

  app.get('/api/health', (c) => c.json({ ok: true, env: c.env.ENVIRONMENT, ts: Date.now() }));

  // Everything below needs a session id (guest sessions mint their own; sign-in binds them, ID-*).
  app.use('/api/*', async (c, next) => {
    const publicRead =
      c.req.method === 'GET' && (c.req.path === '/api/health' || c.req.path === '/api/perf/reports' || c.req.path.startsWith('/api/cuts/'));
    if (publicRead) return next(); // cuts play by link (the share id carries the session)
    const session = c.req.header('x-coast-session') ?? '';
    if (!SESSION_RE.test(session)) return c.json({ error: 'session required (x-coast-session, 8–64 [A-Za-z0-9_-])' }, 401);
    c.set('session', session);
    await next();
  });

  // ── Budget ledger (BE-2) ──
  const ledgerOf = (env: Env, session: string) => env.SESSION.get(env.SESSION.idFromName(session));
  app.get('/api/ledger', async (c) => {
    const r = await ledgerOf(c.env, c.get('session')).fetch('https://do/ledger');
    return c.json(await r.json());
  });

  // ── DIR-1: ephemeral Realtime client secret; the API key never reaches the client ──
  app.post('/api/realtime/secret', async (c) => {
    if (!c.env.OPENAI_API_KEY) return c.json({ error: 'OPENAI_API_KEY not configured' }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { model?: string; premium?: boolean };
    const model = body.premium ? 'gpt-realtime-2.1' : 'gpt-realtime-2.1-mini';
    // A Realtime session is billed by the minute: reserve 5 minutes at list price before minting (BE-2).
    const reserve = body.premium ? 1.6 : 0.4;
    const debit = await ledgerOf(c.env, c.get('session')).fetch('https://do/debit', {
      method: 'POST',
      body: JSON.stringify({ usd: reserve, what: `realtime:${model}` }),
    });
    if (debit.status === 402) return c.json(await debit.json(), 402);
    const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { authorization: `Bearer ${c.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session: { type: 'realtime', model } }),
    });
    return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
  });

  // ── BE-3: real-device perf reports → R2; the dashboard reads them back ──
  app.post('/api/perf/report', async (c) => {
    const len = Number(c.req.header('content-length') ?? '0');
    if (!len || len > LIMITS.reportBytes) return c.json({ error: `report must be 1–${LIMITS.reportBytes} bytes` }, 413);
    const report = await c.req.json().catch(() => null);
    if (!report || typeof report !== 'object') return c.json({ error: 'json body required' }, 400);
    const session = c.get('session');
    const key = `perf/${new Date().toISOString().slice(0, 10)}/${session.slice(0, 32)}/${crypto.randomUUID()}.json`;
    await c.env.USER_BUCKET.put(key, JSON.stringify({ ...report, session, receivedAt: new Date().toISOString() }), {
      httpMetadata: { contentType: 'application/json' },
    });
    return c.json({ ok: true, key });
  });

  app.get('/api/perf/reports', async (c) => {
    const days = Math.min(30, Math.max(1, Number(c.req.query('days') ?? '7')));
    const reports = await listReports(c.env.USER_BUCKET, days);
    return c.json({ days, reports });
  });

  app.get('/perf', async (c) => {
    const days = Math.min(30, Math.max(1, Number(c.req.query('days') ?? '7')));
    const reports = await listReports(c.env.USER_BUCKET, days);
    return c.html(perfDashboard(reports, days));
  });

  // ── ACT-4: takes per session (take.bin, SCH-4) ──
  app.put('/api/takes/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID_RE.test(id)) return c.json({ error: 'bad take id' }, 400);
    const len = Number(c.req.header('content-length') ?? '0');
    if (!len || len > LIMITS.takeBytes) return c.json({ error: `take must be 1–${LIMITS.takeBytes} bytes` }, 413);
    const session = c.get('session');
    const prefix = `takes/${session}/`;
    const listed = await c.env.USER_BUCKET.list({ prefix, limit: LIMITS.takesPerSession + 1 });
    const exists = listed.objects.some((o) => o.key === `${prefix}${id}.bin`);
    if (!exists && listed.objects.length >= LIMITS.takesPerSession) return c.json({ error: 'take limit for this session' }, 429);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length < 8 || bytes[0] !== 0x54 || bytes[1] !== 0x41 || bytes[2] !== 0x4b || bytes[3] !== 0x45) {
      return c.json({ error: 'not a take (bad magic)' }, 400);
    }
    const key = `${prefix}${id}.bin`;
    await c.env.USER_BUCKET.put(key, bytes, { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { session } });
    return c.json({ ok: true, key, bytes: bytes.length });
  });

  app.get('/api/takes', async (c) => {
    const prefix = `takes/${c.get('session')}/`;
    const listed = await c.env.USER_BUCKET.list({ prefix, limit: LIMITS.takesPerSession });
    return c.json({
      takes: listed.objects.map((o) => ({
        id: o.key.slice(prefix.length).replace(/\.bin$/, ''),
        bytes: o.size,
        uploaded: o.uploaded.toISOString(),
      })),
    });
  });

  app.get('/api/takes/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID_RE.test(id)) return c.json({ error: 'bad take id' }, 400);
    const obj = await c.env.USER_BUCKET.get(`takes/${c.get('session')}/${id}.bin`);
    if (!obj) return c.json({ error: 'not found' }, 404);
    return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', etag: obj.httpEtag } });
  });

  // ── STU-3: Coast Cuts — upload, range-aware playback, share page ──
  app.put('/api/cuts/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID_RE.test(id)) return c.json({ error: 'bad cut id' }, 400);
    const len = Number(c.req.header('content-length') ?? '0');
    if (!len || len > LIMITS.cutBytes) return c.json({ error: `cut must be 1–${LIMITS.cutBytes} bytes` }, 413);
    const type = c.req.header('content-type') ?? '';
    if (!/^video\/(mp4|webm)/.test(type)) return c.json({ error: 'video/mp4 or video/webm required' }, 415);
    const session = c.get('session');
    const prefix = `cuts/${session}/`;
    const listed = await c.env.USER_BUCKET.list({ prefix, limit: LIMITS.cutsPerSession + 1 });
    if (listed.objects.length >= LIMITS.cutsPerSession && !listed.objects.some((o) => o.key.startsWith(`${prefix}${id}.`))) {
      return c.json({ error: 'cut limit for this session' }, 429);
    }
    const ext = type.startsWith('video/webm') ? 'webm' : 'mp4';
    const key = `${prefix}${id}.${ext}`;
    const previous = await c.env.USER_BUCKET.head(key);
    const title = c.req.header('x-coast-title') ?? previous?.customMetadata?.title ?? ''; // a re-upload keeps its title
    // The manifest's hash of the file (STU-5): R2 refuses the object when the bytes do not match it.
    const sha256 = c.req.header('x-coast-sha256')?.toLowerCase();
    if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) return c.json({ error: 'x-coast-sha256 must be 64 hex chars' }, 400);
    try {
      await c.env.USER_BUCKET.put(key, c.req.raw.body, {
        httpMetadata: { contentType: type.split(';')[0] },
        customMetadata: { session, title: title.slice(0, 120), ...(sha256 ? { sha256 } : {}) },
        ...(sha256 ? { sha256 } : {}),
      });
    } catch (e) {
      if (sha256) return c.json({ error: 'the upload does not match its sha256', detail: String(e) }, 400);
      throw e;
    }
    // A cut is public by link: a random share token (never the session id) indexes the object.
    const existing = await c.env.USER_BUCKET.get(`${prefix}${id}.share`);
    const share = (await existing?.text()) ?? shareToken();
    if (!existing) await c.env.USER_BUCKET.put(`${prefix}${id}.share`, share);
    await c.env.USER_BUCKET.put(`shares/${share}.json`, JSON.stringify({ key, session, title: title.slice(0, 120) }), {
      httpMetadata: { contentType: 'application/json' },
    });
    return c.json({ ok: true, key, share, url: `/c/${share}`, video: `/api/cuts/${share}` });
  });

  // STU-5: the provenance manifest sits next to the cut (`<id>.json`) and is public with it.
  app.put('/api/cuts/:id/manifest', async (c) => {
    const id = c.req.param('id');
    if (!ID_RE.test(id)) return c.json({ error: 'bad cut id' }, 400);
    const len = Number(c.req.header('content-length') ?? '0');
    if (!len || len > LIMITS.manifestBytes) return c.json({ error: `manifest must be 1–${LIMITS.manifestBytes} bytes` }, 413);
    const session = c.get('session');
    const prefix = `cuts/${session}/`;
    const listed = await c.env.USER_BUCKET.list({ prefix: `${prefix}${id}.` });
    const video = listed.objects.find((o) => /\.(mp4|webm)$/.test(o.key));
    if (!video) return c.json({ error: 'upload the cut first' }, 404);
    const manifest = (await c.req.json().catch(() => null)) as CutManifest | null;
    const problems = validateManifest(manifest);
    if (!manifest || problems.length) return c.json({ error: 'not a cut manifest', problems }, 400);
    if (manifest.id !== id) return c.json({ error: 'manifest id must match the cut id' }, 400);
    const stored = (await c.env.USER_BUCKET.head(video.key))?.customMetadata?.sha256; // list() omits custom metadata
    if (stored && manifest.video?.sha256 && stored !== manifest.video.sha256)
      return c.json({ error: 'manifest hash differs from the cut' }, 409);
    await c.env.USER_BUCKET.put(`${prefix}${id}.json`, JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } });
    return c.json({ ok: true, summary: manifestSummary(manifest) });
  });

  app.get('/api/cuts/:share/manifest', async (c) => {
    const cut = await findCut(c.env.USER_BUCKET, c.req.param('share'));
    if (!cut) return c.json({ error: 'not found' }, 404);
    const obj = await c.env.USER_BUCKET.get(cut.key.replace(/\.(mp4|webm)$/, '.json'));
    if (!obj) return c.json({ error: 'no manifest for this cut' }, 404);
    return new Response(obj.body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } });
  });

  app.get('/api/cuts/:share', async (c) => {
    const cut = await findCut(c.env.USER_BUCKET, c.req.param('share'));
    if (!cut) return c.json({ error: 'not found' }, 404);
    const range = parseRange(c.req.header('range'), cut.size);
    const obj = range
      ? await c.env.USER_BUCKET.get(cut.key, { range: { offset: range.start, length: range.end - range.start + 1 } })
      : await c.env.USER_BUCKET.get(cut.key);
    if (!obj) return c.json({ error: 'not found' }, 404);
    const headers: Record<string, string> = {
      'content-type': obj.httpMetadata?.contentType ?? 'video/mp4',
      'accept-ranges': 'bytes',
      etag: obj.httpEtag,
      'cache-control': 'public, max-age=3600',
    };
    if (range) {
      headers['content-range'] = `bytes ${range.start}-${range.end}/${cut.size}`;
      headers['content-length'] = String(range.end - range.start + 1);
      return new Response(obj.body, { status: 206, headers });
    }
    headers['content-length'] = String(cut.size);
    return new Response(obj.body, { status: 200, headers });
  });

  app.get('/c/:share', async (c) => {
    const share = c.req.param('share');
    const cut = await findCut(c.env.USER_BUCKET, share);
    if (!cut) return c.html(sharePage(null, share, null), 404);
    const manifest = (await (
      await c.env.USER_BUCKET.get(cut.key.replace(/\.(mp4|webm)$/, '.json'))
    )
      ?.json()
      .catch(() => null)) as CutManifest | null;
    return c.html(sharePage(cut, share, manifest && validateManifest(manifest).length === 0 ? manifest : null));
  });

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // Static PWA (everything else).
  app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}

// ── helpers ──

interface CutInfo {
  key: string;
  size: number;
  title: string;
  uploaded: string;
  contentType: string;
}

async function findCut(bucket: R2Bucket, share: string): Promise<CutInfo | null> {
  if (!/^[A-Za-z0-9_-]{12,32}$/.test(share)) return null;
  const index = await bucket.get(`shares/${share}.json`);
  const entry = (await index?.json().catch(() => null)) as { key?: string; title?: string } | null;
  if (!entry?.key) return null;
  const head = await bucket.head(entry.key);
  if (!head) return null;
  return {
    key: entry.key,
    size: head.size,
    title: head.customMetadata?.title ?? entry.title ?? '',
    uploaded: head.uploaded.toISOString(),
    contentType: head.httpMetadata?.contentType ?? 'video/mp4',
  };
}

/** 16 URL-safe chars of randomness (≈ 95 bits). */
function shareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** `bytes=a-b` / `bytes=a-` / `bytes=-n` → inclusive [start, end], or null for the whole object. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || size <= 0) return null;
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === '' && b === '') return null;
  if (a === '') {
    const n = Math.min(size, Number(b));
    start = size - n;
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(size - 1, Number(b));
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

interface PerfSummary {
  key: string;
  date: string;
  session: string;
  device: string;
  tier: string;
  fps: number | null;
  p95: number | null;
  receivedAt: string;
}

async function listReports(bucket: R2Bucket, days: number): Promise<PerfSummary[]> {
  const out: PerfSummary[] = [];
  const since = Date.now() - days * 86_400_000;
  for (let d = 0; d < days; d++) {
    const day = new Date(since + (d + 1) * 86_400_000).toISOString().slice(0, 10);
    const listed = await bucket.list({ prefix: `perf/${day}/`, limit: 200 });
    for (const o of listed.objects) {
      const obj = await bucket.get(o.key);
      if (!obj) continue;
      const r = (await obj.json().catch(() => null)) as Record<string, unknown> | null;
      if (!r) continue;
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const frame = (r.frame ?? r.fps ?? {}) as Record<string, unknown>;
      out.push({
        key: o.key,
        date: day,
        session: String(r.session ?? '').slice(0, 12),
        device: String(r.device ?? r.userAgent ?? r.ua ?? '').slice(0, 80),
        tier: String(r.tier ?? ''),
        fps: num(r.fpsMean) ?? num(frame.fps) ?? num(r.fpsP50),
        p95: num(r.frameMsP95) ?? num(frame.p95),
        receivedAt: String(r.receivedAt ?? o.uploaded.toISOString()),
      });
    }
  }
  return out.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function perfDashboard(reports: PerfSummary[], days: number): string {
  const rows = reports
    .map(
      (r) =>
        `<tr><td>${esc(r.receivedAt.replace('T', ' ').slice(0, 16))}</td><td>${esc(r.tier)}</td><td title="${esc(r.device)}">${esc(r.device.slice(0, 40))}</td>` +
        `<td class="n ${r.fps !== null && r.fps < 55 ? 'bad' : ''}">${r.fps === null ? '—' : r.fps.toFixed(0)}</td>` +
        `<td class="n ${r.p95 !== null && r.p95 > 20 ? 'bad' : ''}">${r.p95 === null ? '—' : r.p95.toFixed(1)}</td><td>${esc(r.session)}</td></tr>`,
    )
    .join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>$COAST · perf</title>
<style>body{font:14px system-ui,sans-serif;background:#0b0a10;color:#f2ecdc;margin:0;padding:24px}h1{font-size:18px;margin:0 0 4px}p{opacity:.7;margin:0 0 16px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid rgba(242,236,220,.12)}th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7}
td.n{text-align:right;font-variant-numeric:tabular-nums}td.bad{color:#ff6b6b}a{color:#ffb54a}</style>
<h1>$COAST · real-device perf (BE-3)</h1><p>last ${days} days · ${reports.length} reports · gates: desktop ≥ 60 fps (QB-1), p95 frame ≤ 16.6 ms · <a href="?days=30">30 days</a></p>
<table><thead><tr><th>received</th><th>tier</th><th>device</th><th>fps</th><th>p95 ms</th><th>session</th></tr></thead><tbody>${rows || '<tr><td colspan="6">no reports yet — open the game with <code>?perf=1</code> and press “Send report”</td></tr>'}</tbody></table>`;
}

function sharePage(cut: CutInfo | null, share: string, manifest: CutManifest | null): string {
  const title = cut?.title || 'a Coast Cut';
  // The credits (STU-5): what the cut was made from, straight from its manifest.
  const credits = manifest
    ? `<p class="credits">${esc(manifestSummary(manifest))}<br><span>${manifest.takeDetails
        .map((t) => `${esc(t.actorId)} · ${t.durationS.toFixed(1)} s`)
        .join(
          ' · ',
        )} · made ${esc(manifest.createdAt.slice(0, 10))} with coast ${esc(manifest.app.version)}${manifest.app.commit ? ` (${esc(manifest.app.commit)})` : ''}${
        manifest.video?.sha256 ? ` · sha256 ${esc(manifest.video.sha256.slice(0, 12))}…` : ''
      } · <a href="/api/cuts/${esc(share)}/manifest">manifest</a></span></p>`
    : '';
  const body = cut
    ? `<video controls autoplay muted playsinline loop src="/api/cuts/${esc(share)}"></video><p>${esc(title)} · ${(cut.size / 1e6).toFixed(1)} MB · <a href="/api/cuts/${esc(share)}" download>download</a> · <a href="/">make your own →</a></p>${credits}`
    : `<p>this cut is gone (or never was) · <a href="/">make your own →</a></p>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · $COAST</title>
<meta property="og:title" content="${esc(title)} · $COAST the Game"><meta property="og:type" content="video.other">${cut ? `<meta property="og:video" content="/api/cuts/${esc(share)}">` : ''}
<style>body{font:14px system-ui,sans-serif;background:#0b0a10;color:#f2ecdc;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
video{width:min(960px,100%);aspect-ratio:16/9;background:#000;border-radius:12px}p{opacity:.8}a{color:#ffb54a}.credits{font-size:12px;opacity:.65;max-width:960px}.credits span{opacity:.8}</style>
<main><h1 style="font-size:16px;letter-spacing:.08em;text-transform:uppercase;color:#ffb54a;margin:0 0 12px">$COAST · the cut</h1>${body}</main>`;
}

const app = createApp();

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),

  async queue(batch: MessageBatch<JobMessage>, _env: Env): Promise<void> {
    for (const msg of batch.messages) {
      // TODO(M2/M4/M6): dispatch to Marble / Tripo / fal adapters; write status to JobDO; debit ledger.
      console.log('job', msg.body.type, msg.body.jobId);
      msg.ack();
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;

/** Per-session budget ledger (BE-2): spend is debited before a vendor call, refused past the cap. */
export class SessionDO implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const cap = Number(this.env.SESSION_SPEND_CAP_USD || '3');
    const ledger = (await this.state.storage.get<Ledger>('ledger')) ?? { spentUsd: 0, capUsd: cap, calls: [] };
    ledger.capUsd = cap;
    if (url.pathname === '/debit' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { usd?: number; what?: string };
      const usd = Math.max(0, Number(body.usd ?? 0));
      if (ledger.spentUsd + usd > cap) {
        return Response.json({ error: 'session budget exhausted', spentUsd: ledger.spentUsd, capUsd: cap }, { status: 402 });
      }
      ledger.spentUsd = Math.round((ledger.spentUsd + usd) * 1e4) / 1e4;
      ledger.calls.push({ t: new Date().toISOString(), what: String(body.what ?? '').slice(0, 64), usd });
      if (ledger.calls.length > 200) ledger.calls.splice(0, ledger.calls.length - 200);
      await this.state.storage.put('ledger', ledger);
      return Response.json(ledger);
    }
    return Response.json(ledger);
  }
}

export class JobDO implements DurableObject {
  constructor(private state: DurableObjectState) {}
  async fetch(_req: Request): Promise<Response> {
    // TODO(M2): job status {queued|running|done|failed, resultKey, costUsd}
    return Response.json({ ok: true, id: this.state.id.toString() });
  }
}
