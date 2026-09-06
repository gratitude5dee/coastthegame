import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * apps/web/public/sw.js is plain JS with no exports; it is evaluated inside a function with a stubbed ServiceWorker
 * global scope (`self`, `caches`, `fetch`). This pins the caching rules from goal.md UX-2 / BE-4: app shell offline,
 * cache-first hashed assets, and — critically — never touching `/api/*`, cross-origin, or Range requests (the splat CDN
 * must stream `.rad` pages with Range).
 */
const ORIGIN = 'https://coast.wzrd.tech';
const SW_SOURCE = readFileSync(join(__dirname, '../../apps/web/public/sw.js'), 'utf8');

type Listener = (event: never) => void;

class MockCache {
  store = new Map<string, Response>();
  private key(req: RequestInfo | URL): string {
    return typeof req === 'string' ? new URL(req, ORIGIN).href : req instanceof URL ? req.href : req.url;
  }
  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    return this.store.get(this.key(req))?.clone();
  }
  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    this.store.set(this.key(req), res);
  }
  async add(url: string): Promise<void> {
    const res = await fetch(new Request(new URL(url, ORIGIN).href));
    if (!res.ok) throw new TypeError(`bad response for ${url}`);
    await this.put(url, res);
  }
  keys(): string[] {
    return [...this.store.keys()].map((href) => new URL(href).pathname);
  }
}

let stores: Record<string, MockCache>;
let listeners: Record<string, Listener>;
let fetchMock: ReturnType<typeof vi.fn>;
let skipWaiting: ReturnType<typeof vi.fn>;
let claim: ReturnType<typeof vi.fn>;

/** Default network: 200 for same-origin paths, 404 for /missing, network error when `offline` is set. */
let offline = false;
function networkResponse(input: RequestInfo | URL): Response {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (offline) throw new TypeError('Failed to fetch'); // the SW never sees offline responses, only rejections
  const path = new URL(url).pathname;
  if (path.startsWith('/missing')) return new Response('nope', { status: 404 });
  return new Response(`body of ${path}`, { status: 200, headers: { 'content-type': 'text/plain' } });
}

function loadWorker(): void {
  new Function(SW_SOURCE)();
}

/** A FetchEvent.request stand-in: the Request constructor forbids mode 'navigate', so build the shape sw.js reads. */
function req(path: string, init: { method?: string; headers?: Record<string, string>; mode?: string } = {}): Request {
  return {
    method: init.method ?? 'GET',
    url: new URL(path, ORIGIN).href,
    headers: new Headers(init.headers),
    mode: init.mode ?? 'no-cors',
  } as unknown as Request;
}

function dispatchFetch(request: Request): Promise<Response> | undefined {
  let handled: Promise<Response> | undefined;
  (listeners.fetch as (e: { request: Request; respondWith(p: Promise<Response>): void }) => void)({
    request,
    respondWith: (p) => {
      handled = p;
    },
  });
  return handled;
}

async function dispatchLifecycle(type: 'install' | 'activate'): Promise<void> {
  let pending: Promise<unknown> = Promise.resolve();
  (listeners[type] as (e: { waitUntil(p: Promise<unknown>): void }) => void)({
    waitUntil: (p) => {
      pending = p;
    },
  });
  await pending;
}

beforeEach(() => {
  stores = {};
  listeners = {};
  offline = false;
  fetchMock = vi.fn(async (input: RequestInfo | URL) => networkResponse(input));
  skipWaiting = vi.fn(async () => undefined);
  claim = vi.fn(async () => undefined);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('caches', {
    open: async (name: string) => (stores[name] ??= new MockCache()),
    keys: async () => Object.keys(stores),
    delete: async (name: string) => delete stores[name],
  });
  vi.stubGlobal('self', {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    skipWaiting,
    clients: { claim },
  });
  loadWorker();
});
afterEach(() => vi.unstubAllGlobals());

describe('lifecycle', () => {
  it('install precaches the shell, manifest and icons, then skips waiting', async () => {
    await dispatchLifecycle('install');
    expect(stores['coast-shell-v1']?.keys().sort()).toEqual(['/', '/icons/icon-192.png', '/icons/icon-512.png', '/manifest.webmanifest']);
    expect(skipWaiting).toHaveBeenCalled();
  });
  it('install survives one failed precache entry', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/icons/icon-512.png')) return new Response('', { status: 404 });
      return networkResponse(input);
    });
    await dispatchLifecycle('install');
    expect(stores['coast-shell-v1']?.keys()).toContain('/');
    expect(stores['coast-shell-v1']?.keys()).not.toContain('/icons/icon-512.png');
  });
  it('activate deletes stale coast-* caches only, then claims clients', async () => {
    stores['coast-shell-v0'] = new MockCache();
    stores['coast-shell-v1'] = new MockCache();
    stores['unrelated-app'] = new MockCache();
    await dispatchLifecycle('activate');
    expect(Object.keys(stores).sort()).toEqual(['coast-shell-v1', 'unrelated-app']);
    expect(claim).toHaveBeenCalled();
  });
});

describe('fetch routing — what is never intercepted', () => {
  it.each([
    ['/api/perf/report', req('/api/perf/report')],
    ['/api/health', req('/api/health')],
    ['cross-origin splat CDN', req('https://assets.coast.wzrd.tech/cells/pier/full.rad')],
    ['Range request', req('/samples/butterfly.spz', { headers: { range: 'bytes=0-1023' } })],
    ['POST', req('/samples/butterfly.spz', { method: 'POST' })],
    ['unknown same-origin path', req('/cells/pier/cell.json')],
  ])('%s', (_label, request) => {
    expect(dispatchFetch(request)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetch routing — cache-first assets', () => {
  it.each(['/assets/three-B-0pOAMO.js', '/icons/icon-192.png', '/samples/butterfly.spz'])(
    '%s hits the network once, then the cache',
    async (path) => {
      const first = await dispatchFetch(req(path));
      expect(await first?.text()).toBe(`body of ${path}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      offline = true;
      const second = await dispatchFetch(req(path));
      expect(await second?.text()).toBe(`body of ${path}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it('does not cache error responses', async () => {
    fetchMock.mockImplementation(async () => new Response('gone', { status: 404 }));
    const missing = await dispatchFetch(req('/assets/gone.js'));
    expect(missing?.status).toBe(404);
    expect(stores['coast-shell-v1']?.keys() ?? []).not.toContain('/assets/gone.js');
  });
});

describe('fetch routing — navigations are network-first with the shell as fallback', () => {
  it('serves the network response and refreshes the cached shell under "/"', async () => {
    const res = await dispatchFetch(req('/?scene=valley&cam=director', { mode: 'navigate' }));
    expect(await res?.text()).toBe('body of /');
    expect(stores['coast-shell-v1']?.keys()).toEqual(['/']);
  });
  it('falls back to the cached shell when offline', async () => {
    await dispatchLifecycle('install');
    offline = true;
    const res = await dispatchFetch(req('/?scene=street', { mode: 'navigate' }));
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe('body of /');
  });
  it('yields a network error when offline with nothing cached (same as no service worker)', async () => {
    offline = true;
    const res = await dispatchFetch(req('/', { mode: 'navigate' }));
    expect(res?.type).toBe('error');
  });
});
