/**
 * Voice lines through the browser's own speech synthesis (goal.md AUD-1 placeholder): the Photographer's brief, the
 * extras' greetings and the director's replies are spoken until the cached ElevenLabs lines land. No key, no
 * network, ~free; per-character pitch/rate so the four of them do not sound alike. Silent where unsupported.
 */
export interface VoiceProfile {
  pitch: number;
  rate: number;
  /** Preferred voice name fragments, first match wins (platform voices differ; the default voice is the fallback). */
  prefer?: string[];
}

export const VOICES: Record<string, VoiceProfile> = {
  photographer: { pitch: 1.15, rate: 1.05, prefer: ['Samantha', 'Google UK English Female', 'Zira', 'Female'] },
  director: { pitch: 0.9, rate: 1.1, prefer: ['Daniel', 'Google UK English Male', 'David', 'Male'] },
  npc_a: { pitch: 0.8, rate: 0.95, prefer: ['Fred', 'Google US English', 'Male'] },
  npc_b: { pitch: 1.3, rate: 1.0, prefer: ['Karen', 'Female'] },
  npc_c: { pitch: 1.0, rate: 1.15, prefer: ['Alex', 'Male'] },
  player: { pitch: 0.85, rate: 1.0, prefer: ['Male'] },
};

export class Tts {
  private muted: boolean;
  private readonly synth: SpeechSynthesis | null;

  constructor(opts: { muted?: boolean } = {}) {
    this.muted = opts.muted ?? false;
    this.synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
    // Some browsers populate the voice list asynchronously; touching it early warms it up.
    this.synth?.getVoices();
  }

  get supported() {
    return !!this.synth;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (m) this.synth?.cancel();
  }

  /** Say a line as `who` (a VOICES key); a new line interrupts the previous one — the set talks over itself otherwise. */
  say(who: string, text: string) {
    const synth = this.synth;
    if (!synth || this.muted || !text.trim()) return false;
    try {
      const profile = VOICES[who] ?? VOICES.director!;
      const u = new SpeechSynthesisUtterance(text);
      u.pitch = profile.pitch;
      u.rate = profile.rate;
      u.volume = 0.9;
      const voice = pickVoice(synth.getVoices(), profile.prefer ?? []);
      if (voice) u.voice = voice;
      synth.cancel();
      synth.speak(u);
      return true;
    } catch {
      return false;
    }
  }

  stop() {
    this.synth?.cancel();
  }
}

/** First installed voice whose name contains one of the preferred fragments (English voices only). */
export function pickVoice(voices: SpeechSynthesisVoice[], prefer: string[]): SpeechSynthesisVoice | null {
  const english = voices.filter((v) => /^en/i.test(v.lang));
  for (const p of prefer) {
    const hit = english.find((v) => v.name.toLowerCase().includes(p.toLowerCase()));
    if (hit) return hit;
  }
  return english[0] ?? null;
}
