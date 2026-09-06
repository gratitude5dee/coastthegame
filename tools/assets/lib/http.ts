/**
 * HTTP helpers for vendor adapters: JSON fetch with retries + timeout, and streaming downloads with a progress line.
 * Node 22 `fetch` + `stream/promises`; no dependencies. Never logs request headers (API keys live there).
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

export interface RetryOptions {
  retries?: number; // extra attempts after the first (default 3)
  backoffMs?: number; // base delay; doubles per attempt (default 1500)
  timeoutMs?: number; // per-attempt timeout for fetchJson (default 60 s)
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  readonly retryAfterMs: number | undefined;
  constructor(status: number, url: string, body: string, method = 'GET', retryAfterMs?: number) {
    super(`HTTP ${status} ${method} ${describeUrl(url)}${body.trim() ? ` — ${snippet(body)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

/** URL without query string / hash — signed download URLs carry tokens we don't want in logs. */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

function snippet(text: string, max = 400): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
  return String(err);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 408 || err.status === 425 || err.status === 429 || err.status >= 500;
  return true; // network errors, timeouts, aborted streams
}

function parseRetryAfter(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Runs `fn` up to `retries + 1` times with exponential backoff; honours `Retry-After` on HttpErrors. */
export async function withRetry<T>(label: string, fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 3, backoffMs = 1500 } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const base = backoffMs * 2 ** attempt;
      const delay = err instanceof HttpError && err.retryAfterMs !== undefined ? Math.max(err.retryAfterMs, base) : base;
      console.warn(`[http] ${label}: ${errorMessage(err)} — retry ${attempt + 1}/${retries} in ${Math.round(delay)} ms`);
      await sleep(delay);
    }
  }
}

/**
 * `fetch` that resolves to parsed JSON (or `undefined` for an empty body) and throws `HttpError` on non-2xx.
 * String bodies get `content-type: application/json`. Retries on network errors / timeouts / 408 / 429 / 5xx.
 */
export async function fetchJson<T = unknown>(url: string, init: RequestInit = {}, opts: RetryOptions = {}): Promise<T> {
  const { timeoutMs = 60_000 } = opts;
  const method = (init.method ?? 'GET').toUpperCase();
  return withRetry(
    `${method} ${describeUrl(url)}`,
    async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
      try {
        const headers = new Headers(init.headers);
        if (!headers.has('accept')) headers.set('accept', 'application/json');
        if (typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
        const res = await fetch(url, { ...init, method, headers, signal: ac.signal });
        const text = await res.text();
        if (!res.ok) throw new HttpError(res.status, url, text, method, parseRetryAfter(res));
        if (!text.trim()) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new Error(`non-JSON response from ${method} ${describeUrl(url)}: ${snippet(text)}`);
        }
      } finally {
        clearTimeout(timer);
      }
    },
    opts,
  );
}

export interface DownloadOptions extends RetryOptions {
  headers?: Record<string, string>;
  idleTimeoutMs?: number; // abort when no bytes arrive for this long (default 60 s)
  label?: string; // shown in the progress line (default: file name)
}

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * Streams `url` to `destPath` (via `destPath.part` + rename), printing a progress line (bytes / total) to stderr.
 * Returns the byte count and sha256 of the file. Whole-file retry on failure.
 */
export async function download(url: string, destPath: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
  const { idleTimeoutMs = 60_000, label = basename(destPath), headers = {} } = opts;
  await mkdir(dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part`;
  const tty = Boolean(process.stderr.isTTY);

  return withRetry(
    `download ${label}`,
    async () => {
      const ac = new AbortController();
      let idle: NodeJS.Timeout | undefined;
      const armIdle = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => ac.abort(new Error(`no data for ${idleTimeoutMs} ms`)), idleTimeoutMs);
      };
      armIdle();
      const started = Date.now();
      let bytes = 0;
      let lastReport = 0;
      const hash = createHash('sha256');
      try {
        const res = await fetch(url, { headers, signal: ac.signal });
        if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''), 'GET', parseRetryAfter(res));
        if (!res.body) throw new Error(`empty body from ${describeUrl(url)}`);
        const total = Number(res.headers.get('content-length')) || undefined;
        const report = (final = false) => {
          const now = Date.now();
          if (!final && (!tty || now - lastReport < 250)) return;
          lastReport = now;
          const pct = total ? ` (${Math.min(100, Math.round((bytes / total) * 100))}%)` : '';
          const line = `  ↓ ${label}  ${formatBytes(bytes)}${total ? ` / ${formatBytes(total)}` : ''}${pct}`;
          if (tty) process.stderr.write(`\r${line}${final ? `  ${((now - started) / 1000).toFixed(1)} s\n` : ''}`);
          else if (final) process.stderr.write(`${line}  ${((now - started) / 1000).toFixed(1)} s\n`);
        };
        if (!tty) process.stderr.write(`  ↓ ${label}  ${total ? formatBytes(total) : '?'} from ${describeUrl(url)}\n`);
        const progress = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            bytes += chunk.length;
            hash.update(chunk);
            armIdle();
            report();
            cb(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>), progress, createWriteStream(partPath), {
          signal: ac.signal,
        });
        report(true);
        await rename(partPath, destPath);
        return { path: destPath, bytes, sha256: hash.digest('hex') };
      } catch (err) {
        if (tty) process.stderr.write('\n');
        await rm(partPath, { force: true }).catch(() => undefined);
        throw err;
      } finally {
        if (idle) clearTimeout(idle);
      }
    },
    opts,
  );
}
