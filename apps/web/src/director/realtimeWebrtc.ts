/**
 * Browser ↔ OpenAI Realtime over WebRTC (goal.md DIR-1): the Worker mints an ephemeral client secret (the API key
 * never reaches the page), the browser offers SDP with the microphone track and an `oai-events` data channel, and
 * the model's audio plays through an <audio> element. The `RealtimeClient` (packages/director) speaks the event
 * protocol; this file is only the plumbing, so tests never need it.
 */
import type { RealtimeClient, RealtimeTransport } from '@coast/director';

export interface RealtimeSessionOptions {
  sessionId: string;
  client: RealtimeClient;
  premium?: boolean;
  /** Where the model's voice plays (created if omitted). */
  audioOut?: HTMLAudioElement;
  /** The Realtime calls endpoint (override for a proxy). */
  callsUrl?: string;
}

export interface RealtimeSession {
  close(): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
}

/** `POST /api/realtime/secret` → the ephemeral key, or a reason it is not available (no key, budget, offline). */
export async function fetchRealtimeSecret(
  sessionId: string,
  premium = false,
): Promise<{ value: string } | { error: string; status: number }> {
  try {
    const r = await fetch('/api/realtime/secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-coast-session': sessionId },
      body: JSON.stringify({ premium }),
    });
    const j = (await r.json().catch(() => ({}))) as { value?: string; error?: string };
    if (!r.ok || !j.value) return { error: j.error ?? `secret request failed (${r.status})`, status: r.status };
    return { value: j.value };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), status: 0 };
  }
}

export async function connectRealtime(o: RealtimeSessionOptions): Promise<RealtimeSession> {
  const secret = await fetchRealtimeSecret(o.sessionId, o.premium);
  if ('error' in secret) throw new Error(secret.error);
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const pc = new RTCPeerConnection();
  const audio = o.audioOut ?? document.createElement('audio');
  audio.autoplay = true;
  pc.ontrack = (e) => {
    audio.srcObject = e.streams[0] ?? null;
  };
  for (const track of mic.getTracks()) pc.addTrack(track, mic);
  const dc = pc.createDataChannel('oai-events');
  const transport: RealtimeTransport = {
    send: (event) => {
      if (dc.readyState === 'open') dc.send(JSON.stringify(event));
    },
    close: () => {
      try {
        dc.close();
      } catch {
        /* closing */
      }
      pc.close();
      for (const t of mic.getTracks()) t.stop();
      audio.srcObject = null;
    },
  };
  dc.addEventListener('open', () => o.client.attach(transport));
  dc.addEventListener('message', (e) => {
    try {
      o.client.handle(JSON.parse(String(e.data)));
    } catch {
      /* not JSON */
    }
  });
  dc.addEventListener('close', () => {
    if (o.client.state !== 'closed') o.client.close();
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const r = await fetch(o.callsUrl ?? 'https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret.value}`, 'content-type': 'application/sdp' },
    body: offer.sdp ?? '',
  });
  if (!r.ok) {
    transport.close();
    throw new Error(`realtime call failed (${r.status})`);
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });

  let muted = false;
  return {
    close: () => o.client.close(),
    setMuted: (m) => {
      muted = m;
      for (const t of mic.getAudioTracks()) t.enabled = !m;
    },
    get muted() {
      return muted;
    },
  };
}
