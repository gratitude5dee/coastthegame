/**
 * Cloudflare Worker API skeleton (goal.md BE-1…BE-4). M0 ships /health, /realtime/secret, /perf/report.
 * Everything vendor-facing goes through here with the per-session budget ledger (BE-2).
 */
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

const json = (data: unknown, status = 200, origin = '') =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...(origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}) },
  });

const MAX_REPORT_BYTES = 16 * 1024;

export default {
  // NOTE(M0): migrate to Hono (goal.md AF-7); keep routes under /api/* (BE-1) and add the budget ledger (BE-2).
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = env.ALLOWED_ORIGIN ?? 'http://localhost:5173';
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-headers': 'content-type,x-coast-session',
          'access-control-allow-methods': 'GET,POST',
        },
      });
    }

    if (url.pathname === '/api/health') return json({ ok: true, env: env.ENVIRONMENT, ts: Date.now() }, 200, origin);

    // DIR-1: mint an ephemeral Realtime client secret; the API key never reaches the client.
    if (url.pathname === '/api/realtime/secret' && req.method === 'POST') {
      if (!env.OPENAI_API_KEY) return json({ error: 'OPENAI_API_KEY not configured' }, 503, origin);
      if (!req.headers.get('x-coast-session')) return json({ error: 'session required' }, 401, origin);
      const body = (await req.json().catch(() => ({}))) as { model?: string; premium?: boolean };
      const model = body.premium ? 'gpt-realtime-2.1' : 'gpt-realtime-2.1-mini';
      // TODO(M5): budget ledger check (BE-2), session binding, tool list from @coast/director toRealtimeTools()
      const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session: { type: 'realtime', model } }),
      });
      return new Response(await r.text(), {
        status: r.status,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin },
      });
    }

    // BE-3: real-device perf reports → R2 (docs/perf dashboard reads these). Size-capped + session-bound (no R2 spam).
    if (url.pathname === '/api/perf/report' && req.method === 'POST') {
      const session = req.headers.get('x-coast-session');
      if (!session) return json({ error: 'session required' }, 401, origin);
      const len = Number(req.headers.get('content-length') ?? '0');
      if (!len || len > MAX_REPORT_BYTES) return json({ error: `report must be 1–${MAX_REPORT_BYTES} bytes` }, 413, origin);
      const report = await req.json();
      const key = `perf/${new Date().toISOString().slice(0, 10)}/${session.slice(0, 32)}/${crypto.randomUUID()}.json`;
      await env.USER_BUCKET.put(key, JSON.stringify(report), { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true, key }, 200, origin);
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404, origin);

    // Static PWA
    return env.ASSETS.fetch(req);
  },

  async queue(batch: MessageBatch<JobMessage>, _env: Env): Promise<void> {
    for (const msg of batch.messages) {
      // TODO(M2/M4/M6): dispatch to Marble / Tripo / fal adapters; write status to JobDO; debit ledger.
      console.log('job', msg.body.type, msg.body.jobId);
      msg.ack();
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;

export class SessionDO implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}
  async fetch(_req: Request): Promise<Response> {
    // TODO(M0): budget ledger {spentUsd, calls[]}; presence; takes index
    return json({ ok: true, id: this.state.id.toString(), cap: this.env.SESSION_SPEND_CAP_USD });
  }
}

export class JobDO implements DurableObject {
  constructor(private state: DurableObjectState) {}
  async fetch(_req: Request): Promise<Response> {
    // TODO(M2): job status {queued|running|done|failed, resultKey, costUsd}
    return json({ ok: true, id: this.state.id.toString() });
  }
}
