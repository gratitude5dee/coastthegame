import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, SessionDO, type Env } from '../../workers/api/src/index';
import { avatarCapabilities as clientCapabilities, createAvatarJob, getAvatarJob } from '../../apps/web/src/api';
import {
  AvatarJobs,
  FalProvider,
  MockProvider,
  ProviderRejected,
  AVATAR_LIMITS,
  AVATAR_RESERVATIONS,
  avatarCapabilities,
  boundedJson,
  publicHttpsUrl,
  validateAvatarInput,
  type AvatarInput,
} from '../../workers/api/src/avatarJobs';

class MemoryStorage {
  data = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === 'string') this.data.set(key, structuredClone(value));
    else for (const [name, item] of Object.entries(key)) this.data.set(name, structuredClone(item));
  }
  async setAlarm(time: number): Promise<void> {
    this.alarmAt = time;
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
  async transaction<T>(callback: (tx: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

const input: AvatarInput = { provider: 'fal-meshy', prompt: 'A stylized humanoid in a T-pose', requestId: 'request-0001' };
const env = (extra: Partial<Env> = {}) => ({ FAL_KEY: 'test-key-not-a-secret', SESSION_SPEND_CAP_USD: '3', ...extra }) as Env;
const asStorage = (storage: MemoryStorage) => storage as unknown as DurableObjectStorage;
function fixture(extra: Partial<Env> = {}, provider = new MockProvider()) {
  const storage = new MemoryStorage();
  let now = 1000;
  const jobs = new AvatarJobs(asStorage(storage), env(extra), provider, () => now);
  return {
    storage,
    jobs,
    provider,
    advance: () => {
      now += AVATAR_LIMITS.pollMs;
    },
    clock: () => now,
  };
}
const ticket = {
  request_id: 'provider-request-0001',
  status_url: 'https://queue.fal.run/fal-ai/meshy/requests/provider-request-0001/status',
  response_url: 'https://queue.fal.run/fal-ai/meshy/requests/provider-request-0001',
};
afterEach(() => vi.unstubAllGlobals());

describe('browser avatar API helpers', () => {
  it('uses the exact public capabilities and session-owned create/get contract', async () => {
    const job = { id: 'opaque-job', status: 'queued' };
    const capabilities = { providers: { tripo: false, 'fal-hunyuan': false, 'fal-meshy': true } };
    const transport = vi
      .fn()
      .mockResolvedValueOnce(Response.json(capabilities))
      .mockResolvedValueOnce(Response.json(job))
      .mockResolvedValueOnce(Response.json(job));
    vi.stubGlobal('fetch', transport);
    expect(await clientCapabilities()).toEqual(capabilities);
    expect(await createAvatarJob('session-owner', input)).toEqual(job);
    expect(await getAvatarJob('session-owner', '../opaque-job')).toEqual(job);
    expect(transport.mock.calls[0]).toEqual(['/api/avatar/capabilities', { cache: 'no-store' }]);
    expect(transport.mock.calls[1]).toEqual([
      '/api/jobs/avatar',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-coast-session': 'session-owner' },
        body: JSON.stringify(input),
        cache: 'no-store',
      },
    ]);
    expect(transport.mock.calls[2][0]).toBe('/api/jobs/avatar/..%2Fopaque-job');
  });

  it('never automatically retries or exposes upstream error text', async () => {
    const transport = vi.fn().mockResolvedValue(Response.json({ error: 'private upstream diagnostic' }, { status: 503 }));
    vi.stubGlobal('fetch', transport);
    await expect(createAvatarJob('session-owner', input)).rejects.toThrow('Reuse the same requestId');
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('avatar input and provider contracts', () => {
  it('exposes only verified providers when keys are present, never a mock capability', () => {
    expect(avatarCapabilities(env())).toEqual({ providers: { tripo: false, 'fal-hunyuan': false, 'fal-meshy': true } });
    expect(avatarCapabilities(env({ FAL_KEY: undefined }))).toEqual({
      providers: { tripo: false, 'fal-hunyuan': false, 'fal-meshy': false },
    });
  });

  it.each([
    'http://photos.coast.ai/a.png',
    'https://localhost/a',
    'https://127.0.0.1/a',
    'https://2130706433/a',
    'https://[::1]/a',
    'https://10.0.0.1/a',
    'https://foo.internal/a',
    'https://a.nip.io/a',
    'https://user:pass@photos.coast.ai/a',
    'https://photos.coast.ai:8080/a',
    'https://photos.coast.ai/a#x',
    'file:///tmp/a',
    'data:image/png;base64,abc',
  ])('rejects unsafe image input %s', (url) => {
    expect(publicHttpsUrl(url)).toBeUndefined();
    expect(validateAvatarInput({ provider: 'fal-hunyuan', imageUrl: url, requestId: 'request-0001' })).toBeUndefined();
  });

  it('validates provider-specific inputs and rejects caller-supplied models or options', () => {
    expect(validateAvatarInput(input)).toEqual(input);
    expect(
      validateAvatarInput({ provider: 'fal-hunyuan', imageUrl: 'https://photos.coast.ai/a.png', requestId: 'request-0001' }),
    ).toBeDefined();
    for (const bad of [
      null,
      [],
      { ...input, provider: 'mock' },
      { ...input, provider: ['fal-meshy'] },
      { ...input, model: 'arbitrary' },
      { ...input, enable_rigging: true },
      { ...input, prompt: 'x'.repeat(601) },
      { ...input, prompt: ' ' },
      { ...input, requestId: '../other' },
      { ...input, imageUrl: 'https://photos.coast.ai/a.png' },
      { ...input, provider: 'fal-hunyuan' },
    ]) {
      expect(validateAvatarInput(bad)).toBeUndefined();
    }
  });

  it('bounds streamed JSON without requiring a content-length header', async () => {
    await expect(boundedJson(new Request('https://do', { method: 'POST', body: 'x'.repeat(100) }), 10)).rejects.toThrow('body too large');
  });

  it('uses the verified Meshy request/result shape, authenticated queue URLs only, and never fetches the model', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(Response.json(ticket))
      .mockResolvedValueOnce(Response.json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(Response.json({ model_glb: { url: 'https://v3b.fal.media/files/model.glb' } }));
    const adapter = new FalProvider('server-key', transport as typeof fetch);
    const handle = await adapter.submit(input);
    expect(await adapter.poll('fal-meshy', handle)).toEqual({ status: 'succeeded', modelUrl: 'https://v3b.fal.media/files/model.glb' });
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe('https://queue.fal.run/fal-ai/meshy/v6/text-to-3d');
    expect(JSON.parse(init.body)).toMatchObject({ prompt: input.prompt, mode: 'full', enable_rigging: false, enable_animation: false });
    expect(init.headers.authorization).toBe('Key server-key');
    expect(init.redirect).toBe('error');
    expect(transport.mock.calls.every(([url]) => url.startsWith('https://queue.fal.run/'))).toBe(true);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each(['', ' \t '])('blocks submit and persisted-ticket polling with a blank key (%j)', async (key) => {
    const transport = vi.fn();
    const adapter = new FalProvider(key, transport as typeof fetch);
    await expect(adapter.submit(input)).rejects.toThrow('key is unavailable');
    await expect(
      adapter.poll('fal-meshy', { id: ticket.request_id, statusUrl: ticket.status_url, responseUrl: ticket.response_url }),
    ).rejects.toThrow('key is unavailable');
    expect(transport).not.toHaveBeenCalled();
  });

  it('retains the dormant Hunyuan adapter with verified input_image_url and fixed low-poly options', async () => {
    const transport = vi.fn().mockResolvedValue(
      Response.json({
        ...ticket,
        status_url: ticket.status_url.replace('meshy', 'hunyuan3d-v3'),
        response_url: ticket.response_url.replace('meshy', 'hunyuan3d-v3'),
      }),
    );
    await new FalProvider('key', transport as typeof fetch).submit({
      provider: 'fal-hunyuan',
      imageUrl: 'https://photos.coast.ai/image.png',
      requestId: 'request-0001',
    });
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({
      input_image_url: 'https://photos.coast.ai/image.png',
      generate_type: 'LowPoly',
      face_count: 40000,
      polygon_type: 'triangle',
      enable_pbr: false,
    });
    expect(AVATAR_RESERVATIONS['fal-hunyuan'].usd).toBeGreaterThan(0.6);
    expect(AVATAR_RESERVATIONS['fal-meshy'].usd).toBeGreaterThan(0.8);
  });

  it.each([
    'https://evil.coast.ai/status',
    'https://queue.fal.run/fal-ai/other/requests/provider-request-0001/status',
    'https://queue.fal.run/fal-ai/meshy/requests/other-request/status',
  ])('rejects untrusted polling URLs without following them: %s', async (status_url) => {
    const transport = vi.fn().mockResolvedValue(Response.json({ ...ticket, status_url }));
    await expect(new FalProvider('key', transport as typeof fetch).submit(input)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://evil.coast.ai/model.glb',
    'http://fal.media/model.glb',
    'https://fal.media/model.fbx',
    'https://fal.media.evil.coast.ai/model.glb',
  ])('rejects non-allowlisted outputs: %s', async (url) => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(Response.json(ticket))
      .mockResolvedValueOnce(Response.json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(Response.json({ model_glb: { url } }));
    const adapter = new FalProvider('key', transport as typeof fetch);
    await expect(adapter.poll('fal-meshy', await adapter.submit(input))).rejects.toThrow('invalid model URL');
  });
});

describe('durable session avatar lifecycle', () => {
  it('reserves the complete pipeline before any request, deduplicates, and completes after reconstruction', async () => {
    const f = fixture();
    const created = await (await f.jobs.create(input)).json();
    expect(created.status).toBe('queued');
    expect(created.id).toBe(input.requestId);
    expect(f.provider.submissions).toBe(0);
    expect(await f.storage.get('ledger')).toMatchObject({ spentUsd: 1.6, calls: [{ what: 'avatar:reserve:fal-meshy', usd: 1.6 }] });
    expect(await (await f.jobs.create(input)).json()).toEqual(created);
    expect((await f.jobs.create({ ...input, prompt: 'other' })).status).toBe(409);
    await f.jobs.alarm();
    expect(f.provider.submissions).toBe(1);
    const restored = new AvatarJobs(asStorage(f.storage), env(), f.provider, f.clock);
    f.advance();
    await restored.alarm();
    const complete = await (await restored.get(created.id)).json();
    expect(complete).toEqual({ id: created.id, status: 'succeeded', modelUrl: 'https://fal.media/files/mock-avatar.glb' });
    expect(JSON.stringify(complete)).not.toContain('mock-request');
    expect(f.storage.alarmAt).toBeNull();
    expect(await (await restored.create(input)).json()).toEqual(complete);
    expect(f.provider.submissions).toBe(1);
    expect(await f.storage.get('ledger')).toMatchObject({ spentUsd: 1.6 });
  });

  it('recovers a lost create response after reload using only the persisted requestId and GET', async () => {
    const f = fixture();
    await f.jobs.create(input);
    await f.jobs.alarm();
    const ledger = await f.storage.get('ledger');
    const savedJobs = await f.storage.get('avatarJobs');
    const restored = new AvatarJobs(asStorage(f.storage), env(), f.provider, f.clock);
    const recovery = await restored.get(input.requestId);
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toEqual({ id: input.requestId, status: 'running' });
    expect(await (await restored.get(input.requestId)).json()).toEqual({ id: input.requestId, status: 'running' });
    expect(await f.storage.get('ledger')).toEqual(ledger);
    expect(await f.storage.get('avatarJobs')).toEqual(savedJobs);
    expect(f.provider.submissions).toBe(1);
    expect(f.provider.polls).toBe(0);
    expect((await fixture().jobs.get(input.requestId)).status).toBe(404);
  });

  it('does not debit or submit when keys, provider approval, or budget are missing', async () => {
    for (const [extra, body, status] of [
      [{ FAL_KEY: undefined }, input, 503],
      [{}, { ...input, provider: 'tripo' }, 503],
      [{ SESSION_SPEND_CAP_USD: '1' }, input, 402],
      [{ SESSION_SPEND_CAP_USD: 'NaN' }, input, 402],
    ] as const) {
      const f = fixture(extra);
      expect((await f.jobs.create(body)).status).toBe(status);
      expect(await f.storage.get('ledger')).toBeUndefined();
      expect(f.provider.submissions).toBe(0);
    }
  });

  it.each([undefined, 'test-key'])('blocks Hunyuan before reservation with or without a key (%j)', async (key) => {
    const f = fixture({ FAL_KEY: key });
    const response = await f.jobs.create({
      provider: 'fal-hunyuan',
      imageUrl: 'https://photos.coast.ai/a.png',
      requestId: 'hunyuan-request',
    });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('requires mesh reduction to 30000 triangles');
    expect(await f.storage.get('ledger')).toBeUndefined();
    expect(await f.storage.get('avatarJobs')).toBeUndefined();
    expect(f.storage.alarmAt).toBeNull();
    expect(f.provider.submissions).toBe(0);
  });

  it('does not start a previously queued Hunyuan job after disabling the provider', async () => {
    const f = fixture();
    await f.storage.put('avatarJobs', [
      {
        id: 'old-hunyuan',
        status: 'queued',
        input: { provider: 'fal-hunyuan', imageUrl: 'https://photos.coast.ai/a.png', requestId: 'old-request' },
        createdAt: f.clock(),
        nextPoll: f.clock(),
        polls: 0,
      },
    ]);
    await f.storage.put('ledger', { spentUsd: 0.75, capUsd: 3, calls: [] });
    await f.jobs.alarm();
    expect(f.provider.submissions).toBe(0);
    expect((await (await f.jobs.get('old-hunyuan')).json()).status).toBe('failed');
    expect(await f.storage.get('ledger')).toMatchObject({ spentUsd: 0.75 });
  });

  it('makes no provider call when a persisted ticket is resumed after key removal', async () => {
    const f = fixture();
    const created = await (await f.jobs.create(input)).json();
    vi.spyOn(f.provider, 'submit').mockResolvedValue({
      id: ticket.request_id,
      statusUrl: ticket.status_url,
      responseUrl: ticket.response_url,
    });
    await f.jobs.alarm();
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    const restored = new AvatarJobs(asStorage(f.storage), env({ FAL_KEY: undefined }), undefined, f.clock);
    f.advance();
    await restored.alarm();
    expect(transport).not.toHaveBeenCalled();
    expect((await (await restored.get(created.id)).json()).status).toBe('unknown');
    expect(await f.storage.get('ledger')).toMatchObject({ spentUsd: 1.6 });
    await restored.alarm();
    expect(transport).not.toHaveBeenCalled();
  });

  it('retains ambiguous submission outcomes across restarts without blind retries or refunds', async () => {
    const f = fixture();
    vi.spyOn(f.provider, 'submit').mockRejectedValue(new Error('private upstream diagnostic'));
    const job = await (await f.jobs.create(input)).json();
    await f.jobs.alarm();
    const restored = new AvatarJobs(asStorage(f.storage), env(), f.provider, f.clock);
    await restored.alarm();
    const result = await (await restored.create(input)).json();
    expect(result).toMatchObject({ id: job.id, status: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('private upstream');
    expect(f.provider.submit).toHaveBeenCalledTimes(1);
    expect(await f.storage.get('ledger')).toMatchObject({ spentUsd: 1.6 });
  });

  it('writes unknown before POST so an interruption cannot trigger a second submission', async () => {
    const f = fixture();
    vi.spyOn(f.provider, 'submit').mockImplementation(async () => {
      expect(await f.storage.get('avatarJobs')).toMatchObject([{ status: 'unknown' }]);
      throw new Error('interrupted');
    });
    await f.jobs.create(input);
    await f.jobs.alarm();
    await f.jobs.alarm();
    expect(f.provider.submit).toHaveBeenCalledTimes(1);
  });

  it('records explicit rejection as failed without exposing upstream errors', async () => {
    const f = fixture();
    vi.spyOn(f.provider, 'submit').mockRejectedValue(new ProviderRejected('upstream secret'));
    const created = await (await f.jobs.create(input)).json();
    await f.jobs.alarm();
    const result = await (await f.jobs.get(created.id)).json();
    expect(result.status).toBe('failed');
    expect(result.error).not.toContain('secret');
    expect(await f.storage.get('ledger')).toMatchObject({ spentUsd: 1.6 });
    expect(await (await f.jobs.create(input)).json()).toEqual(result);
  });

  it('bounds polling with a durable interval and terminal unknown instead of resubmission', async () => {
    const f = fixture();
    vi.spyOn(f.provider, 'poll').mockResolvedValue({ status: 'running' });
    const job = await (await f.jobs.create(input)).json();
    await f.jobs.alarm();
    await f.jobs.alarm();
    expect(f.provider.poll).not.toHaveBeenCalled();
    for (let i = 0; i <= AVATAR_LIMITS.polls; i++) {
      f.advance();
      await f.jobs.alarm();
    }
    expect((await (await f.jobs.get(job.id)).json()).status).toBe('unknown');
    expect(f.provider.poll.mock.calls.length).toBeLessThanOrEqual(AVATAR_LIMITS.polls);
    expect(f.provider.submissions).toBe(1);
  });

  it('limits active and retained jobs per session', async () => {
    const f = fixture({ SESSION_SPEND_CAP_USD: '100' });
    await f.jobs.create(input);
    expect((await f.jobs.create({ ...input, requestId: 'request-0002' })).status).toBe(429);
    await f.jobs.alarm();
    f.advance();
    await f.jobs.alarm();
    for (let i = 1; i < AVATAR_LIMITS.jobs; i++) {
      expect((await f.jobs.create({ ...input, requestId: `request-${1000 + i}` })).status).toBe(202);
      await f.jobs.alarm();
      f.advance();
      await f.jobs.alarm();
    }
    expect((await f.jobs.create({ ...input, requestId: 'request-final' })).status).toBe(429);
  });

  it('serializes concurrent session admission and debits, preventing overspend', async () => {
    const storage = new MemoryStorage();
    const session = new SessionDO({ storage: asStorage(storage) } as DurableObjectState, env());
    const create = () => session.fetch(new Request('https://do/avatar', { method: 'POST', body: JSON.stringify(input) }));
    const results = await Promise.all([create(), create(), create()]);
    const jobs = await Promise.all(results.map((r) => r.json()));
    expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
    expect(await storage.get('ledger')).toMatchObject({ spentUsd: 1.6, calls: [{ usd: 1.6 }] });
    expect((await session.fetch(new Request('https://do/debit', { method: 'POST', body: JSON.stringify({ usd: 2 }) }))).status).toBe(402);
  });

  it('Hono capabilities are public while jobs and result IDs are session-owned', async () => {
    const sessions = new Map<string, SessionDO>();
    const bindings = env();
    bindings.SESSION = {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (!sessions.has(id)) sessions.set(id, new SessionDO({ storage: asStorage(new MemoryStorage()) } as DurableObjectState, bindings));
        return { fetch: (url: string, init?: RequestInit) => sessions.get(id)!.fetch(new Request(url, init)) };
      },
    } as unknown as DurableObjectNamespace;
    const app = createApp();
    const request = (path: string, init: RequestInit = {}, session?: string) =>
      app.request(path, { ...init, headers: { ...init.headers, ...(session ? { 'x-coast-session': session } : {}) } }, bindings);
    expect((await request('/api/avatar/capabilities')).status).toBe(200);
    expect((await request('/api/jobs/avatar', { method: 'POST', body: JSON.stringify(input) })).status).toBe(401);
    const created = await request('/api/jobs/avatar', { method: 'POST', body: JSON.stringify(input) }, 'session-owner');
    expect(created.headers.get('cache-control')).toBe('no-store');
    const job = await created.json();
    expect(job.id).toBe(input.requestId);
    expect((await request(`/api/jobs/avatar/${input.requestId}`, {}, 'session-owner')).status).toBe(200);
    expect((await request(`/api/jobs/avatar/${job.id}`, {}, 'session-other')).status).toBe(404);
    expect((await request(`/api/jobs/avatar/${job.id}`)).status).toBe(401);
    expect(
      (await request('/api/jobs/avatar', { method: 'POST', body: JSON.stringify({ ...input, model: 'bad' }) }, 'session-owner')).status,
    ).toBe(400);
  });
});
