/**
 * `/perf` — in-app performance probe (goal.md §7.14 BE-3, §10.7 measurement recipes, QB-1/3/4/5).
 *
 * Owns a ring of the last 600 frame times (10 s at 60 fps), computes fps p50/p95 and frame-time p50/p95/max, reads the
 * `performance.mark`s that back the QB gates, and POSTs a size-capped JSON report to `${apiBase}/api/perf/report`
 * (the Worker stores it in R2; the dashboard reads it). With `?perf=1` in the URL a small overlay shows the live
 * numbers plus a "Send report" button — that is how the real-device checklist (docs/device-checklist.md) is run.
 *
 * No dependencies and never imports from main.ts. Wiring (main.ts):
 *   const perf = initPerf({ tier, cell, sessionId, apiBase: '', splatCount: () => spark.display?.numSplats ?? 0 });
 *   renderer.setAnimationLoop((time) => { …; perf.tick(dt); });
 */

export interface PerfOptions {
  /** Platform tier from `detectPlatform()` — 'desktop' | 'quest' | 'iphone' | 'visionpro' | 'android' | 'fallback'. */
  tier: string;
  /** Cell / scene id the numbers were captured in (W-2); change later with `setCell`. */
  cell: string;
  /** Sent as the `x-coast-session` header — the Worker rejects reports without it. */
  sessionId: string;
  /** Origin of the Worker API without a trailing slash; '' for same-origin (Workers static assets + /api/*). */
  apiBase: string;
  /** Optional live splat count (Spark `display?.numSplats`) — reported as `splatCount`. */
  splatCount?: () => number;
}

/** Stats over every start→end pair found for a mark pair; times in ms. */
export interface PerfPairStats {
  n: number;
  last: number;
  p50: number;
  max: number;
  /** Longest frame rendered inside the *last* pair's window (QB-4: "no frame >50 ms during the switch"). */
  maxFrameMs?: number;
}

export interface PerfMarks {
  /** `coast:boot` — ms since `performance.timeOrigin` (navigation start). */
  boot?: number;
  /** `coast:interactive` — ms since navigation start: the QB-3 "first interactive frame" number. */
  interactive?: number;
  bootToInteractive?: number;
  /** `coast:mode-start` → `coast:mode-end` (QB-4, perspective switch). */
  modeSwitch?: PerfPairStats;
  /** `coast:ptt-release` → `coast:act-preview` (QB-5, voice command → ghost/highlight visible). */
  voice?: PerfPairStats;
}

/** Body of POST /api/perf/report (goal.md §10.7). Numbers are rounded to 0.1 to keep the body small. */
export interface PerfReport {
  tier: string;
  ua: string;
  gpu: string;
  cell: string;
  splatCount?: number;
  /** p95 is the fps sustained 95 % of the time (1000 / frameMs.p95), i.e. the number the QB-1 gate is written against. */
  fps: { p50: number; p95: number };
  frameMs: { p50: number; p95: number; max: number };
  marks: PerfMarks;
  memoryMB?: number;
  /** Seconds since navigation start. */
  sessionS: number;
}

export interface PerfHandle {
  /** Call once per rendered frame with the frame delta in ms (the animation-loop `time - last`). */
  tick(dtMs: number): void;
  /** POST the current numbers. Never throws — failures are logged and shown in the overlay. */
  report(): Promise<void>;
  /** The overlay element. Attached to `document.body` only when the URL has `perf=1`; hidden otherwise. */
  overlay: HTMLElement;
  /** Current numbers (exactly what `report()` would send) — for the HUD, Playwright, or remote-inspector debugging. */
  snapshot(): PerfReport;
  /** Re-target later reports when the player streams into another cell. */
  setCell(cell: string): void;
}

const RING = 600; // frames kept for percentiles (10 s at 60 fps, ~8 s at 72 Hz)
const MAX_BODY_BYTES = 16 * 1024; // Worker rejects larger reports (MAX_REPORT_BYTES in workers/api)
const OVERLAY_INTERVAL_MS = 250;
const MAX_FRAME_MS = 2000; // longer gaps are background-tab pauses, not frames

const MARK = {
  boot: 'coast:boot',
  interactive: 'coast:interactive',
  modeStart: 'coast:mode-start',
  modeEnd: 'coast:mode-end',
  pttRelease: 'coast:ptt-release',
  actPreview: 'coast:act-preview',
} as const;

const r1 = (x: number): number => Math.round(x * 10) / 10;

/** Nearest-rank percentile of an ascending array (same convention as the seed HUD: floor(p·n)). */
function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return sorted[Math.min(n - 1, Math.floor(p * n))] ?? 0;
}

function markTimes(name: string): number[] {
  try {
    return performance
      .getEntriesByName(name, 'mark')
      .map((e) => e.startTime)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Matches each start mark with the first end mark after it (before the next start); unmatched starts are dropped. */
function markPairs(startName: string, endName: string): Array<{ start: number; end: number }> {
  const starts = markTimes(startName);
  const ends = markTimes(endName);
  const pairs: Array<{ start: number; end: number }> = [];
  let j = 0;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i] ?? 0;
    const nextStart = starts[i + 1] ?? Number.POSITIVE_INFINITY;
    while (j < ends.length && (ends[j] ?? 0) < start) j++;
    const end = ends[j];
    if (end !== undefined && end <= nextStart) {
      pairs.push({ start, end });
      j++;
    }
  }
  return pairs;
}

function gpuRenderer(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return 'no-webgl';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext(); // throwaway context: free the GPU slot right away
    return String(renderer ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

function usedHeapMB(): number | undefined {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  const bytes = mem?.usedJSHeapSize;
  return typeof bytes === 'number' && bytes > 0 ? r1(bytes / (1024 * 1024)) : undefined;
}

function perfEnabled(): boolean {
  try {
    return new URLSearchParams(location.search).get('perf') === '1';
  } catch {
    return false;
  }
}

export function initPerf(opts: PerfOptions): PerfHandle {
  let cell = opts.cell;
  const dts = new Float32Array(RING); // frame durations, ms
  const ends = new Float64Array(RING); // performance.now() at the end of each frame (for mark windows)
  let head = 0; // next write index
  let count = 0;
  let gpu: string | undefined; // lazy: a throwaway GL context during boot would compete with the real one
  let status = '';
  let lastOverlayAt = -Infinity; // the first tick renders at once; later ones are throttled to OVERLAY_INTERVAL_MS
  let sending = false;

  const overlay = document.createElement('div');
  overlay.id = 'perf';
  overlay.style.cssText =
    'position:fixed;right:8px;bottom:8px;z-index:9999;max-width:min(46vw,420px);padding:6px 8px;' +
    'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#f2ecdc;' +
    'background:rgba(11,10,16,.72);border:1px solid rgba(255,181,74,.35);border-radius:6px;' +
    'white-space:pre;overflow:hidden;text-overflow:ellipsis;pointer-events:auto;user-select:none';
  const text = document.createElement('div');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Send report';
  button.style.cssText =
    'display:block;margin-top:6px;padding:3px 10px;font:inherit;font-weight:600;cursor:pointer;' +
    'color:#0b0a10;background:#ffb54a;border:0;border-radius:4px';
  button.addEventListener('click', () => void report());
  overlay.append(text, button);
  // Only `?perf=1` attaches it; the overlay updates whenever it is in the DOM, so main.ts may also attach it later.
  if (perfEnabled()) document.body.appendChild(overlay);

  function sortedFrameTimes(): Float32Array {
    return dts.slice(0, count).sort();
  }

  function pairStats(startName: string, endName: string): PerfPairStats | undefined {
    const pairs = markPairs(startName, endName);
    if (pairs.length === 0) return undefined;
    const durations = pairs.map((p) => p.end - p.start).sort((a, b) => a - b);
    const last = pairs[pairs.length - 1];
    const stats: PerfPairStats = {
      n: pairs.length,
      last: r1(last ? last.end - last.start : 0),
      p50: r1(percentile(durations, 0.5)),
      max: r1(durations[durations.length - 1] ?? 0),
    };
    if (last) {
      // Longest frame whose end fell inside the last pair's window — only known while that window is still in the ring.
      let maxFrame = -1;
      for (let i = 0; i < count; i++) {
        const end = ends[i] ?? 0;
        if (end >= last.start && end <= last.end + (dts[i] ?? 0)) maxFrame = Math.max(maxFrame, dts[i] ?? 0);
      }
      if (maxFrame >= 0) stats.maxFrameMs = r1(maxFrame);
    }
    return stats;
  }

  function marks(): PerfMarks {
    const out: PerfMarks = {};
    const boot = markTimes(MARK.boot)[0];
    const interactive = markTimes(MARK.interactive)[0];
    if (boot !== undefined) out.boot = r1(boot);
    if (interactive !== undefined) out.interactive = r1(interactive);
    if (boot !== undefined && interactive !== undefined) out.bootToInteractive = r1(interactive - boot);
    const modeSwitch = pairStats(MARK.modeStart, MARK.modeEnd);
    if (modeSwitch) out.modeSwitch = modeSwitch;
    const voice = pairStats(MARK.pttRelease, MARK.actPreview);
    if (voice) out.voice = voice;
    return out;
  }

  function snapshot(): PerfReport {
    const sorted = sortedFrameTimes();
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const max = sorted.length ? (sorted[sorted.length - 1] ?? 0) : 0;
    gpu ??= gpuRenderer();
    const report: PerfReport = {
      tier: opts.tier,
      ua: navigator.userAgent,
      gpu,
      cell,
      fps: { p50: r1(p50 > 0 ? 1000 / p50 : 0), p95: r1(p95 > 0 ? 1000 / p95 : 0) },
      frameMs: { p50: r1(p50), p95: r1(p95), max: r1(max) },
      marks: marks(),
      sessionS: Math.round(performance.now() / 1000),
    };
    const splats = opts.splatCount?.();
    if (typeof splats === 'number' && Number.isFinite(splats)) report.splatCount = Math.round(splats);
    const memoryMB = usedHeapMB();
    if (memoryMB !== undefined) report.memoryMB = memoryMB;
    return report;
  }

  function render(): void {
    if (!overlay.isConnected) return;
    const s = snapshot();
    const m = s.marks;
    const line = (label: string, v: string) => `${label.padEnd(9)} ${v}\n`;
    let body =
      line('tier', `${s.tier} · ${s.cell}${s.splatCount !== undefined ? ` · ${s.splatCount.toLocaleString()} splats` : ''}`) +
      line('fps', `p50 ${s.fps.p50}  p95 ${s.fps.p95}`) +
      line('frame ms', `p50 ${s.frameMs.p50}  p95 ${s.frameMs.p95}  max ${s.frameMs.max}  (n=${count})`);
    if (m.interactive !== undefined) body += line('QB-3', `interactive ${(m.interactive / 1000).toFixed(2)} s`);
    if (m.modeSwitch)
      body += line('QB-4', `mode ${m.modeSwitch.last} ms (max ${m.modeSwitch.max}, frame ${m.modeSwitch.maxFrameMs ?? '?'})`);
    if (m.voice) body += line('QB-5', `voice ${m.voice.last} ms (p50 ${m.voice.p50}, n=${m.voice.n})`);
    body += line('mem', `${s.memoryMB !== undefined ? `${s.memoryMB} MB` : 'n/a'} · ${s.sessionS} s`);
    body += line('gpu', s.gpu);
    if (status) body += line('report', status);
    text.textContent = body.trimEnd();
  }

  function tick(dtMs: number): void {
    if (!Number.isFinite(dtMs) || dtMs <= 0 || dtMs > MAX_FRAME_MS) return;
    const now = performance.now();
    dts[head] = dtMs;
    ends[head] = now;
    head = (head + 1) % RING;
    if (count < RING) count++;
    if (overlay.isConnected && now - lastOverlayAt >= OVERLAY_INTERVAL_MS) {
      lastOverlayAt = now;
      render();
    }
  }

  async function report(): Promise<void> {
    if (sending) return;
    sending = true;
    status = 'sending…';
    render();
    try {
      const snap = snapshot();
      let body = JSON.stringify(snap);
      if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
        // Never expected (a full report is ~1 KB); degrade rather than get a 413 from the Worker.
        body = JSON.stringify({ ...snap, marks: {}, ua: snap.ua.slice(0, 256), gpu: snap.gpu.slice(0, 256) });
      }
      if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) throw new Error(`report body exceeds ${MAX_BODY_BYTES} bytes`);
      const res = await fetch(`${opts.apiBase}/api/perf/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-coast-session': opts.sessionId },
        body,
        keepalive: true, // survives the tab closing right after the tap on a phone
      });
      if (!res.ok) {
        status = `HTTP ${res.status}`;
        console.warn(`[perf] report rejected: HTTP ${res.status}`, await res.text().catch(() => ''));
      } else {
        status = `sent ${new Date().toLocaleTimeString()}`;
        console.info('[perf] report sent', snap);
      }
    } catch (err) {
      status = 'failed (see console)';
      console.warn('[perf] report failed', err);
    } finally {
      sending = false;
      render();
    }
  }

  const handle: PerfHandle = {
    tick,
    report,
    overlay,
    snapshot,
    setCell: (next: string) => {
      cell = next;
    },
  };
  // Remote-inspector / Playwright hook, same convention as window.__coastReady / __coastFrame.
  (window as unknown as { __coastPerf?: PerfHandle }).__coastPerf = handle;
  return handle;
}
