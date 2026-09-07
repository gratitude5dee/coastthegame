import type { Env, Ledger } from './index';

export type AvatarProvider = 'tripo' | 'fal-hunyuan' | 'fal-meshy';
export type AvatarJob = {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
  modelUrl?: string;
  error?: string;
};
export type AvatarInput = { provider: AvatarProvider; prompt?: string; imageUrl?: string; requestId: string };
export const TRIPO_BLOCKER = 'Tripo is unavailable: the documented presets do not provide the required six onboarding clips (wave/point).';
export const HUNYUAN_BLOCKER = 'Hunyuan is unavailable: requires mesh reduction to 30000 triangles before import.';
export const AVATAR_LIMITS = { bodyBytes: 8192, jobs: 8, polls: 120, pollMs: 15_000, lifetimeMs: 30 * 60_000 } as const;
export const AVATAR_MODELS = {
  'fal-hunyuan': 'fal-ai/hunyuan3d-v3/image-to-3d',
  'fal-meshy': 'fal-ai/meshy/v6/text-to-3d',
} as const;
export const AVATAR_RESERVATIONS = {
  'fal-hunyuan': { usd: 0.75, basis: 'LowPoly $0.45 + custom face count $0.15 + $0.15 headroom; no PBR or multiview' },
  'fal-meshy': { usd: 1.6, basis: 'Full generation $0.80 + $0.80 headroom; no rigging, animation, or texture guidance' },
} as const;

export function avatarCapabilities(env: Pick<Env, 'FAL_KEY'>): { providers: Record<AvatarProvider, boolean> } {
  return { providers: { tripo: false, 'fal-hunyuan': false, 'fal-meshy': Boolean(env.FAL_KEY?.trim()) } };
}

export function publicHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/.test(value)) return;
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.href.length > 4096) return;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return;
    if (/(^|\.)(localhost|local|internal|lan|home|test|invalid|example|onion|arpa|nip\.io|sslip\.io)$/.test(host)) return;
    return url.href;
  } catch {
    return;
  }
}

export function validateAvatarInput(value: unknown): AvatarInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['provider', 'prompt', 'imageUrl', 'requestId'].includes(key))) return;
  if (typeof body.provider !== 'string' || !['tripo', 'fal-hunyuan', 'fal-meshy'].includes(body.provider)) return;
  if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.requestId)) return;
  if (body.prompt !== undefined && (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 600)) return;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : undefined;
  const imageUrl = body.imageUrl === undefined ? undefined : publicHttpsUrl(body.imageUrl);
  if (body.imageUrl !== undefined && !imageUrl) return;
  if (body.provider === 'fal-hunyuan' && (!imageUrl || prompt)) return;
  if (body.provider === 'fal-meshy' && (!prompt || imageUrl)) return;
  if (!prompt && !imageUrl) return;
  return {
    provider: body.provider as AvatarProvider,
    requestId: body.requestId,
    ...(prompt ? { prompt } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  };
}

export async function boundedJson(request: Request | Response, limit: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

type FalProviderName = keyof typeof AVATAR_MODELS;
export type ProviderTicket = { id: string; statusUrl: string; responseUrl: string };
export type ProviderProgress = { status: 'queued' | 'running' | 'succeeded' | 'failed'; modelUrl?: string };
export interface AvatarProviderAdapter {
  submit(input: AvatarInput): Promise<ProviderTicket>;
  poll(provider: AvatarProvider, ticket: ProviderTicket): Promise<ProviderProgress>;
}
export class ProviderRejected extends Error {}

function queueUrl(value: unknown, provider: FalProviderName, id: string, status: boolean): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error('invalid provider ticket');
  const url = new URL(value);
  const model = AVATAR_MODELS[provider];
  const root = model.split('/').slice(0, 2).join('/');
  const endings = status ? ['/status'] : ['', '/response'];
  if (
    url.origin !== 'https://queue.fal.run' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    ![model, root].some((base) => endings.some((ending) => url.pathname === `/${base}/requests/${id}${ending}`))
  ) {
    throw new Error('invalid provider ticket');
  }
  return url.href;
}

function modelUrl(value: unknown): string {
  const safe = publicHttpsUrl(value);
  if (!safe) throw new Error('invalid model URL');
  const url = new URL(safe);
  if (!(url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media')) || !url.pathname.endsWith('.glb')) {
    throw new Error('invalid model URL');
  }
  return safe;
}

export class FalProvider implements AvatarProviderAdapter {
  constructor(
    private key: string,
    private transport: typeof fetch = fetch,
  ) {}

  private async call(url: string, body?: unknown): Promise<Record<string, unknown>> {
    if (!this.key.trim()) throw new ProviderRejected('Avatar provider key is unavailable');
    const response = await this.transport(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Key ${this.key}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([400, 401, 403, 422].includes(response.status)) throw new ProviderRejected('provider rejected request');
      throw new Error('provider request unavailable');
    }
    const data = await boundedJson(response, 64 * 1024);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid provider response');
    return data as Record<string, unknown>;
  }

  async submit(input: AvatarInput): Promise<ProviderTicket> {
    if (input.provider === 'tripo') throw new ProviderRejected(TRIPO_BLOCKER);
    const body =
      input.provider === 'fal-hunyuan'
        ? { input_image_url: input.imageUrl, generate_type: 'LowPoly', face_count: 40000, polygon_type: 'triangle', enable_pbr: false }
        : {
            prompt: input.prompt,
            mode: 'full',
            topology: 'triangle',
            target_polycount: 30000,
            pose_mode: 't-pose',
            enable_rigging: false,
            enable_animation: false,
            enable_prompt_expansion: false,
            enable_pbr: false,
            enable_safety_checker: true,
          };
    const data = await this.call(`https://queue.fal.run/${AVATAR_MODELS[input.provider]}`, body);
    if (typeof data.request_id !== 'string') throw new Error('missing provider ticket');
    return {
      id: data.request_id,
      statusUrl: queueUrl(data.status_url, input.provider, data.request_id, true),
      responseUrl: queueUrl(data.response_url, input.provider, data.request_id, false),
    };
  }

  async poll(provider: AvatarProvider, ticket: ProviderTicket): Promise<ProviderProgress> {
    if (provider === 'tripo') throw new ProviderRejected(TRIPO_BLOCKER);
    const status = await this.call(queueUrl(ticket.statusUrl, provider, ticket.id, true));
    if (status.status === 'IN_QUEUE') return { status: 'queued' };
    if (status.status === 'IN_PROGRESS') return { status: 'running' };
    if (status.status !== 'COMPLETED') throw new Error('unknown provider status');
    if (status.error || status.error_type) return { status: 'failed' };
    const result = await this.call(queueUrl(ticket.responseUrl, provider, ticket.id, false));
    const file = result.model_glb as { url?: unknown } | undefined;
    return { status: 'succeeded', modelUrl: modelUrl(file?.url) };
  }
}

export class MockProvider implements AvatarProviderAdapter {
  submissions = 0;
  polls = 0;
  async submit(): Promise<ProviderTicket> {
    this.submissions++;
    return { id: 'mock-request-0001', statusUrl: '', responseUrl: '' };
  }
  async poll(): Promise<ProviderProgress> {
    this.polls++;
    return { status: 'succeeded', modelUrl: 'https://fal.media/files/mock-avatar.glb' };
  }
}

type StoredJob = AvatarJob & { input: AvatarInput; ticket?: ProviderTicket; createdAt: number; polls: number; nextPoll: number };
const view = ({ id, status, modelUrl, error }: StoredJob): AvatarJob => ({
  id,
  status,
  ...(modelUrl ? { modelUrl } : {}),
  ...(error ? { error } : {}),
});
const active = (job: StoredJob) => job.status === 'queued' || job.status === 'running';

export class AvatarJobs {
  constructor(
    private storage: DurableObjectStorage,
    private env: Env,
    private adapter: AvatarProviderAdapter = new FalProvider(env.FAL_KEY ?? ''),
    private now: () => number = Date.now,
  ) {}

  async create(input: AvatarInput): Promise<Response> {
    const jobs = (await this.storage.get<StoredJob[]>('avatarJobs')) ?? [];
    const existing = jobs.find((job) => job.input.requestId === input.requestId);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input))
        return Response.json({ error: 'requestId already used with different input' }, { status: 409 });
      return Response.json(view(existing));
    }
    if (input.provider === 'tripo') return Response.json({ error: TRIPO_BLOCKER }, { status: 503 });
    if (input.provider === 'fal-hunyuan') return Response.json({ error: HUNYUAN_BLOCKER }, { status: 503 });
    if (!avatarCapabilities(this.env).providers[input.provider])
      return Response.json({ error: 'Avatar generation is unavailable; import a GLB instead.' }, { status: 503 });
    if (jobs.length >= AVATAR_LIMITS.jobs || jobs.some(active))
      return Response.json({ error: 'avatar job limit for this session' }, { status: 429 });
    const cap = Number(this.env.SESSION_SPEND_CAP_USD || '3');
    const usd = AVATAR_RESERVATIONS[input.provider].usd;
    const ledger = (await this.storage.get<Ledger>('ledger')) ?? { spentUsd: 0, capUsd: cap, calls: [] };
    if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(ledger.spentUsd) || ledger.spentUsd + usd > cap) {
      return Response.json({ error: 'session budget exhausted', spentUsd: ledger.spentUsd, capUsd: cap }, { status: 402 });
    }
    const job: StoredJob = { id: input.requestId, status: 'queued', input, createdAt: this.now(), polls: 0, nextPoll: this.now() };
    ledger.spentUsd = Math.round((ledger.spentUsd + usd) * 1e4) / 1e4;
    ledger.capUsd = cap;
    ledger.calls.push({ t: new Date(this.now()).toISOString(), what: `avatar:reserve:${input.provider}`, usd });
    ledger.calls = ledger.calls.slice(-200);
    jobs.push(job);
    await this.storage.transaction(async (tx) => {
      await tx.put({ ledger, avatarJobs: jobs });
      await tx.setAlarm(this.now() + 1);
    });
    return Response.json(view(job), { status: 202 });
  }

  async get(id: string): Promise<Response> {
    const jobs = (await this.storage.get<StoredJob[]>('avatarJobs')) ?? [];
    const job = jobs.find((entry) => entry.id === id);
    return job ? Response.json(view(job)) : Response.json({ error: 'avatar job not found' }, { status: 404 });
  }

  async alarm(): Promise<void> {
    const jobs = (await this.storage.get<StoredJob[]>('avatarJobs')) ?? [];
    const job = jobs.find(active);
    if (!job) return;
    if (this.now() - job.createdAt >= AVATAR_LIMITS.lifetimeMs || job.polls >= AVATAR_LIMITS.polls) {
      job.status = 'unknown';
      job.error = 'Polling limit reached; provider outcome is unknown. Do not resubmit automatically.';
      await this.storage.transaction(async (tx) => {
        await tx.put('avatarJobs', jobs);
        await tx.deleteAlarm();
      });
      return;
    }
    if (job.nextPoll > this.now()) {
      await this.storage.setAlarm(job.nextPoll);
      return;
    }
    if (!job.ticket) {
      job.status = 'unknown';
      job.error = 'Submission outcome is unknown. Do not resubmit automatically.';
      await this.storage.put('avatarJobs', jobs);
      try {
        if (job.input.provider === 'fal-hunyuan') throw new ProviderRejected(HUNYUAN_BLOCKER);
        job.ticket = await this.adapter.submit(job.input);
        job.status = 'running';
        delete job.error;
      } catch (error) {
        if (error instanceof ProviderRejected) {
          job.status = 'failed';
          job.error = 'Provider rejected avatar generation.';
        }
      }
    } else {
      job.polls++;
      job.nextPoll = this.now() + AVATAR_LIMITS.pollMs;
      await this.storage.transaction(async (tx) => {
        await tx.put('avatarJobs', jobs);
        await tx.setAlarm(job.nextPoll);
      });
      try {
        const result = await this.adapter.poll(job.input.provider, job.ticket);
        job.status = result.status;
        if (result.status === 'succeeded') job.modelUrl = modelUrl(result.modelUrl);
        if (result.status === 'failed') job.error = 'Provider failed to generate the avatar.';
      } catch (error) {
        if (error instanceof ProviderRejected) {
          job.status = 'unknown';
          job.error = 'Provider result is unavailable; generation outcome is unknown. Do not resubmit automatically.';
        } else {
          job.status = 'running';
        }
      }
    }
    job.nextPoll = this.now() + AVATAR_LIMITS.pollMs;
    await this.storage.transaction(async (tx) => {
      await tx.put('avatarJobs', jobs);
      if (active(job)) await tx.setAlarm(job.nextPoll);
      else await tx.deleteAlarm();
    });
  }
}
