/**
 * Push-to-talk voice input (goal.md DIR-1, INP-3): the browser's own speech recognition (Web Speech API — Chrome
 * desktop/Android, Safari) turns a held key / button into a transcript for the director's grammar, with the real
 * speech window stamped from the recogniser's speechstart/speechend so deixis pairs words with pointing (Bolt's rule).
 * No key, no server of ours: this is the voice path until the OpenAI Realtime client (M5) replaces the recogniser
 * — the transcript → `DirectorConsole.say()` seam stays the same. Unsupported browsers fall back to the `/` bar.
 */
export type VoiceState = 'idle' | 'listening' | 'unsupported' | 'denied' | 'error';

export interface VoiceEvents {
  onTranscript: (text: string, speech: { startMs: number; endMs: number }) => void;
  onInterim?: (text: string) => void;
  onState?: (state: VoiceState, detail?: string) => void;
}

/** The subset of SpeechRecognition we use (typed here: lib.dom has no SpeechRecognition on every TS target). */
export interface RecognizerLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionResultLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
}

export interface RecognitionResultLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string; confidence: number } }>;
}

type RecognizerCtor = new () => RecognizerLike;

function nativeRecognizer(): RecognizerCtor | null {
  const w = globalThis as unknown as { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export class VoiceInput {
  state: VoiceState = 'idle';
  private rec: RecognizerLike | null = null;
  private startedMs = 0;
  private speechStartMs = 0;
  private speechEndMs = 0;
  private finalText = '';
  private readonly Ctor: RecognizerCtor | null;

  constructor(
    private readonly events: VoiceEvents,
    private readonly now: () => number = () => performance.now(),
    recognizer?: RecognizerCtor | null,
  ) {
    this.Ctor = recognizer === undefined ? nativeRecognizer() : recognizer;
    if (!this.Ctor) this.set('unsupported');
  }

  get supported() {
    return !!this.Ctor;
  }

  get listening() {
    return this.state === 'listening';
  }

  /** Push-to-talk down: start listening (idempotent). */
  start() {
    if (!this.Ctor || this.rec) return;
    const rec = new this.Ctor();
    rec.lang = 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.finalText = '';
    this.startedMs = this.now();
    this.speechStartMs = 0;
    this.speechEndMs = 0;
    rec.onspeechstart = () => {
      this.speechStartMs = this.now();
    };
    rec.onspeechend = () => {
      this.speechEndMs = this.now();
    };
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) this.finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim) this.events.onInterim?.(this.finalText + interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.set('denied', e.error);
      else if (e.error !== 'no-speech' && e.error !== 'aborted') this.set('error', e.error);
    };
    rec.onend = () => {
      this.rec = null;
      const text = this.finalText.trim();
      const startMs = this.speechStartMs || this.startedMs;
      const endMs = this.speechEndMs || this.now();
      if (text) this.events.onTranscript(text, { startMs, endMs });
      if (this.state === 'listening') this.set('idle');
    };
    this.rec = rec;
    try {
      rec.start();
      this.set('listening');
    } catch (e) {
      this.rec = null;
      this.set('error', String(e));
    }
  }

  /** Push-to-talk up: stop listening; the final transcript arrives through `onend`. */
  stop() {
    this.rec?.stop();
  }

  dispose() {
    this.rec?.abort();
    this.rec = null;
  }

  private set(state: VoiceState, detail?: string) {
    this.state = state;
    this.events.onState?.(state, detail);
  }
}
