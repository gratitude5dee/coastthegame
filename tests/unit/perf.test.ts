import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initPerf } from '../../apps/web/src/perf';

/**
 * perf.ts runs in the browser; here the DOM is a minimal stub (no jsdom in the repo). Node's global `performance`
 * implements mark()/getEntriesByName(), so the QB-3/4/5 mark pairing is exercised for real.
 */
interface StubEl {
  id: string;
  type: string;
  textContent: string;
  style: { cssText: string };
  isConnected: boolean;
  children: StubEl[];
  listeners: Record<string, () => void>;
  append(...els: StubEl[]): void;
  addEventListener(name: string, fn: () => void): void;
  getContext(): null;
}
function el(): StubEl {
  return {
    id: '',
    type: '',
    textContent: '',
    style: { cssText: '' },
    isConnected: false,
    children: [],
    listeners: {},
    append(...els) {
      this.children.push(...els);
    },
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    },
    getContext: () => null,
  };
}
const body = {
  appended: [] as StubEl[],
  appendChild(e: StubEl) {
    e.isConnected = true;
    this.appended.push(e);
  },
};

beforeEach(() => {
  body.appended = [];
  vi.stubGlobal('document', { createElement: () => el(), body });
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { search: '' });
  performance.clearMarks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const opts = { tier: 'desktop', cell: 'pier', sessionId: 'sess-1', apiBase: 'https://api.test' };

describe('frame ring', () => {
  it('computes fps/frameMs percentiles and max (nearest-rank, floor(p·n))', () => {
    const perf = initPerf(opts);
    for (let i = 0; i < 100; i++) perf.tick(16.7);
    for (let i = 0; i < 5; i++) perf.tick(50);
    const s = perf.snapshot();
    expect(s.frameMs).toEqual({ p50: 16.7, p95: 16.7, max: 50 });
    expect(s.fps.p50).toBeCloseTo(59.9, 1);
    expect(s.fps.p95).toBeCloseTo(59.9, 1);
    expect(s.tier).toBe('desktop');
    expect(s.cell).toBe('pier');
  });
  it('keeps only the last 600 frames and ignores non-frames', () => {
    const perf = initPerf(opts);
    for (let i = 0; i < 100; i++) perf.tick(100); // evicted below
    for (let i = 0; i < 600; i++) perf.tick(10);
    perf.tick(NaN);
    perf.tick(-1);
    perf.tick(0);
    perf.tick(5000); // background-tab pause, not a frame
    expect(perf.snapshot().frameMs).toEqual({ p50: 10, p95: 10, max: 10 });
  });
  it('reports zeros before the first frame', () => {
    const s = initPerf(opts).snapshot();
    expect(s.fps).toEqual({ p50: 0, p95: 0 });
    expect(s.frameMs).toEqual({ p50: 0, p95: 0, max: 0 });
  });
});

describe('performance.mark pairs (goal.md §10.7)', () => {
  it('reads boot/interactive and pairs mode-start/end and ptt-release/act-preview', () => {
    performance.mark('coast:boot');
    performance.mark('coast:interactive');
    performance.mark('coast:mode-start');
    performance.mark('coast:mode-end');
    performance.mark('coast:mode-start'); // unmatched start: dropped
    performance.mark('coast:mode-start');
    performance.mark('coast:mode-end');
    performance.mark('coast:ptt-release');
    performance.mark('coast:act-preview');
    const perf = initPerf(opts);
    perf.tick(16);
    const m = perf.snapshot().marks;
    expect(m.boot).toBeGreaterThan(0);
    expect(m.interactive).toBeGreaterThanOrEqual(m.boot ?? 0);
    expect(m.bootToInteractive).toBeGreaterThanOrEqual(0);
    expect(m.modeSwitch?.n).toBe(2);
    expect(m.modeSwitch?.max).toBeGreaterThanOrEqual(m.modeSwitch?.p50 ?? 0);
    expect(m.modeSwitch?.maxFrameMs).toBe(16); // the frame that rendered right after the switch
    expect(m.voice?.n).toBe(1);
  });
  it('omits marks that are not present', () => {
    expect(initPerf(opts).snapshot().marks).toEqual({});
  });
});

describe('report()', () => {
  it('POSTs the §10.7 body with the session header, ≤16 KB', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const perf = initPerf({ ...opts, splatCount: () => 123456.7 });
    perf.tick(16);
    perf.setCell('garage');
    await perf.report();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/api/perf/report');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-coast-session']).toBe('sess-1');
    const body = String(init.body);
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(16 * 1024);
    const json = JSON.parse(body);
    expect(Object.keys(json).sort()).toEqual(['cell', 'fps', 'frameMs', 'gpu', 'marks', 'sessionS', 'splatCount', 'tier', 'ua'].sort());
    expect(json.cell).toBe('garage');
    expect(json.splatCount).toBe(123457);
    expect(json.gpu).toBe('no-webgl'); // stub canvas has no context — the try/catch path
  });
  it('never throws: network failure and HTTP errors are logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    await expect(initPerf(opts).report()).resolves.toBeUndefined();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 413 })),
    );
    await expect(initPerf(opts).report()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('overlay', () => {
  it('is attached only with ?perf=1 and then renders live numbers', () => {
    expect(body.appended).toHaveLength(0);
    initPerf(opts);
    expect(body.appended).toHaveLength(0);
    vi.stubGlobal('location', { search: '?scene=valley&perf=1' });
    const perf = initPerf(opts);
    expect(body.appended).toHaveLength(1);
    expect(perf.overlay).toBe(body.appended[0]);
    perf.tick(16.7);
    const text = (perf.overlay as unknown as StubEl).children[0]?.textContent ?? '';
    expect(text).toContain('fps');
    expect(text).toContain('desktop · pier');
    expect((perf.overlay as unknown as StubEl).children[1]?.textContent).toBe('Send report');
  });
});
