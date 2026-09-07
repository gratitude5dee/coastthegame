/**
 * The client side of the Worker API (goal.md BE-1, ACT-4, STU-3): same-origin `/api/*` in production (the Worker
 * serves the PWA), proxied by the Vite dev server to `wrangler dev` locally. Everything here is optional — when the
 * API is down the game plays on: takes stay in IndexedDB, cuts stay as downloads.
 */
import { encodeTake, type CutManifest, type TakeV1 } from '@coast/studio';

let health: Promise<boolean> | null = null;

/** Whether the API answers (cached for the page's life; a first call at boot costs one request). */
export function apiAvailable(sessionId: string): Promise<boolean> {
  health ??= fetch('/api/health', { headers: { 'x-coast-session': sessionId } })
    .then(async (r) => r.ok && (await r.json()).ok === true) // a static host answers /api with the SPA shell: not the API
    .catch(() => false);
  return health;
}

/** Push a take to the session's R2 shelf (ACT-4). Resolves false when the API is away or refuses. */
export async function uploadTake(sessionId: string, take: TakeV1): Promise<boolean> {
  if (!(await apiAvailable(sessionId))) return false;
  try {
    const r = await fetch(`/api/takes/${encodeURIComponent(take.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-coast-session': sessionId },
      body: takeBytes(take),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export interface SharedCut {
  share: string;
  /** Absolute share-page URL. */
  url: string;
  video: string;
}

/** Push an exported cut and get its share link (STU-3). Null when the API is away or refuses. */
export async function uploadCut(sessionId: string, id: string, blob: Blob, title: string, sha256?: string): Promise<SharedCut | null> {
  if (!(await apiAvailable(sessionId))) return null;
  try {
    const r = await fetch(`/api/cuts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        'content-type': blob.type || 'video/mp4',
        'x-coast-session': sessionId,
        'x-coast-title': title.slice(0, 120),
        ...(sha256 ? { 'x-coast-sha256': sha256 } : {}),
      },
      body: blob,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { share: string; url: string; video: string };
    return { share: j.share, url: new URL(j.url, location.origin).toString(), video: j.video };
  } catch {
    return null;
  }
}

/** Attach the provenance manifest to an uploaded cut (STU-5); the share page shows it. False when the API is away. */
export async function uploadCutManifest(sessionId: string, id: string, manifest: CutManifest): Promise<boolean> {
  if (!(await apiAvailable(sessionId))) return false;
  try {
    const r = await fetch(`/api/cuts/${encodeURIComponent(id)}/manifest`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-coast-session': sessionId },
      body: JSON.stringify(manifest),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** SHA-256 of a blob as lowercase hex (the manifest's video hash; the Worker checks the upload against it). */
export async function sha256Hex(blob: Blob): Promise<string | undefined> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

/** The codec's Uint8Array as a body TS accepts under the newer ArrayBufferLike typings (it is a plain ArrayBuffer). */
function takeBytes(take: TakeV1): ArrayBuffer {
  const u8 = encodeTake(take);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}
