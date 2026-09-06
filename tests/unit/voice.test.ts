import { describe, it, expect, vi } from 'vitest';
import { VoiceInput, type RecognizerLike, type RecognitionResultLike } from '../../apps/web/src/director/voice';

/** goal.md DIR-1 / INP-3: push-to-talk through the browser recogniser, with the real speech window for deixis. */
function fakeRecognizer() {
  const instances: FakeRec[] = [];
  class FakeRec implements RecognizerLike {
    lang = '';
    continuous = true;
    interimResults = false;
    maxAlternatives = 3;
    started = false;
    stopped = false;
    onresult: ((e: RecognitionResultLike) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    onspeechstart: (() => void) | null = null;
    onspeechend: (() => void) | null = null;
    constructor() {
      instances.push(this);
    }
    start() {
      this.started = true;
    }
    stop() {
      this.stopped = true;
    }
    abort() {
      this.stopped = true;
      this.onend?.();
    }
    result(parts: [string, boolean][], resultIndex = 0) {
      this.onresult?.({ resultIndex, results: parts.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript, confidence: 0.9 } })) });
    }
  }
  return { FakeRec, instances };
}

describe('VoiceInput', () => {
  it('start → interim results → stop → final transcript with the speech window from speechstart/speechend', () => {
    const { FakeRec, instances } = fakeRecognizer();
    let t = 1000;
    const onTranscript = vi.fn();
    const onInterim = vi.fn();
    const states: string[] = [];
    const v = new VoiceInput({ onTranscript, onInterim, onState: (s) => states.push(s) }, () => t, FakeRec);
    expect(v.supported).toBe(true);
    v.start();
    const rec = instances[0]!;
    expect(rec.started).toBe(true);
    expect(rec.lang).toBe('en-US');
    expect(rec.continuous).toBe(false);
    expect(rec.interimResults).toBe(true);
    expect(v.listening).toBe(true);
    t = 1300;
    rec.onspeechstart?.();
    rec.result([['camera', false]]);
    expect(onInterim).toHaveBeenLastCalledWith('camera');
    rec.result([
      ['camera low ', true],
      ['follow', false],
    ]);
    expect(onInterim).toHaveBeenLastCalledWith('camera low follow');
    rec.result([['camera low ', true], ['follow the car', true]], 1); // the list is cumulative; index 1 is what changed
    t = 2900;
    rec.onspeechend?.();
    v.stop();
    expect(rec.stopped).toBe(true);
    expect(onTranscript).not.toHaveBeenCalled(); // the final transcript arrives with `end`
    t = 3000;
    rec.onend?.();
    expect(onTranscript).toHaveBeenCalledWith('camera low follow the car', { startMs: 1300, endMs: 2900 });
    expect(v.listening).toBe(false);
    expect(states).toEqual(['listening', 'idle']);
    v.start(); // a second press makes a fresh recogniser
    expect(instances).toHaveLength(2);
  });

  it('without speech events the window is start→stop; silence yields no transcript; denial is reported', () => {
    const { FakeRec, instances } = fakeRecognizer();
    let t = 5000;
    const onTranscript = vi.fn();
    const states: string[] = [];
    const v = new VoiceInput({ onTranscript, onState: (s) => states.push(s) }, () => t, FakeRec);
    v.start();
    instances[0]!.result([['action', true]]);
    t = 5800;
    instances[0]!.onend?.();
    expect(onTranscript).toHaveBeenCalledWith('action', { startMs: 5000, endMs: 5800 });
    v.start();
    instances[1]!.onerror?.({ error: 'no-speech' }); // not an error worth reporting
    instances[1]!.onend?.();
    expect(onTranscript).toHaveBeenCalledTimes(1);
    v.start();
    instances[2]!.onerror?.({ error: 'not-allowed' });
    instances[2]!.onend?.();
    expect(states).toEqual(['listening', 'idle', 'listening', 'idle', 'listening', 'denied']);
  });

  it('reports unsupported browsers and never throws', () => {
    const states: string[] = [];
    const v = new VoiceInput({ onTranscript: () => {}, onState: (s) => states.push(s) }, () => 0, null);
    expect(v.supported).toBe(false);
    v.start();
    v.stop();
    expect(states).toEqual(['unsupported']);
  });
});
