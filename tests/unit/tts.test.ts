// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { Tts, pickVoice } from '../../apps/web/src/audio/tts';
import { spokenReply } from '../../apps/web/src/director/console';
import type { UtteranceOutcome } from '../../packages/director/src/executor';

/** goal.md AUD-1 placeholder: browser speech for NPC lines and the director's replies; silent when unsupported/muted. */
describe('Tts', () => {
  const voice = (name: string, lang = 'en-US') => ({ name, lang }) as SpeechSynthesisVoice;

  it('prefers a named English voice, falls back to any English voice, never a foreign one', () => {
    const voices = [voice('Amélie', 'fr-FR'), voice('Google UK English Male', 'en-GB'), voice('Samantha')];
    expect(pickVoice(voices, ['Samantha'])?.name).toBe('Samantha');
    expect(pickVoice(voices, ['Nobody', 'uk english'])?.name).toBe('Google UK English Male');
    expect(pickVoice(voices, ['Nobody'])?.name).toBe('Google UK English Male');
    expect(pickVoice([voice('Amélie', 'fr-FR')], ['Samantha'])).toBeNull();
  });

  it('speaks through speechSynthesis with the character profile, interrupting the previous line; mute silences it', () => {
    const spoken: { text: string; pitch: number; rate: number }[] = [];
    const synth = {
      getVoices: () => [],
      cancel: vi.fn(),
      speak: (u: SpeechSynthesisUtterance) => spoken.push({ text: u.text, pitch: u.pitch, rate: u.rate }),
    };
    (globalThis as { speechSynthesis?: unknown }).speechSynthesis = synth;
    (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = class {
      text: string;
      pitch = 1;
      rate = 1;
      volume = 1;
      voice: unknown = null;
      constructor(t: string) {
        this.text = t;
      }
    };
    const tts = new Tts();
    expect(tts.supported).toBe(true);
    expect(tts.say('photographer', 'Say: camera low, follow me.')).toBe(true);
    expect(spoken).toEqual([{ text: 'Say: camera low, follow me.', pitch: 1.15, rate: 1.05 }]);
    expect(synth.cancel).toHaveBeenCalledTimes(1); // the new line interrupts
    tts.setMuted(true);
    expect(tts.say('director', 'done')).toBe(false);
    expect(spoken).toHaveLength(1);
    expect(tts.say('director', '   ')).toBe(false);
    delete (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
    expect(new Tts().supported).toBe(false);
    expect(new Tts().say('director', 'done')).toBe(false);
  });

  it('the director says the question, else the first problem, else a short yes', () => {
    const outcome = (results: UtteranceOutcome['results']): UtteranceOutcome => ({
      utterance: { transcript: '', clauses: [], acts: [], deicticTotal: 0, unknown: [] },
      results,
    });
    expect(spokenReply(outcome([]))).toBe('');
    expect(spokenReply(outcome([{ ok: true, affected: ['camera'], confidence: 1 }]))).toBe('done');
    expect(
      spokenReply(
        outcome([
          { ok: true, affected: [], confidence: 1 },
          { ok: true, affected: [], confidence: 1 },
        ]),
      ),
    ).toBe('done, all of it');
    expect(
      spokenReply(
        outcome([
          { ok: true, affected: [], confidence: 1 },
          { ok: false, affected: ['a', 'b'], confidence: 0.5, question: 'this one?' },
        ]),
      ),
    ).toBe('this one?');
    expect(spokenReply(outcome([{ ok: false, affected: [], confidence: 0, error: 'didn\'t get "make it pop"' }]))).toBe(
      "didn't get make it pop",
    );
  });
});
