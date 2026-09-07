# ADR-0006 — Direction before the voice model: one grammar, one executor, browser push-to-talk

**Status:** accepted (2026-09-06) · **Owner:** GRATITUD3 · **Refs:** goal.md DIR-1, DIR-2, DIR-3, DIR-4, DIR-6, CAM-6, CAM-8

## Context

goal.md routes every direction through OpenAI Realtime tool calls (DIR-2). The key is not in the Worker yet, and the acts, the deixis resolver, the ghost previews and the confirmation loop all needed exercising — in CI and on set — without spend. Two small conflicts with the spec surfaced on the way: DIR-1 names **T** as the push-to-talk key, but T has cycled time of day since the seed and "golden hour" is itself a direction; and with the model's server VAD on, push-to-talk is redundant.

## Decision

- **The acts are the contract, not the transport.** `packages/director/src/schema.ts` is the single `SceneAct` schema; the Realtime tools are generated from it. `grammar.ts` parses the film-set grammar of DIR-4 deterministically into the same acts (clauses split on `,` `;` `then` `and`; deictic ordinals per DIR-3; _yes / no / the left one_ as meta replies). `executor.ts` runs acts against a `SceneOps` interface: deixis resolution against the speech window, the confidence gates (0.6 to act, 0.8 for destructive acts), a ghost preview, and a **pending question** that the next reply finishes. The `RealtimeClient` feeds function calls to that same executor and returns `function_call_output`.
- **Typed and browser-recognised speech are first-class**, not a fallback: the `/` bar and `SpeechRecognition` push-to-talk (Chrome / Safari, secure origin) stay after Realtime lands — quiet rooms, no key, offline. The speech window for deixis comes from the recogniser's start/end events, from the PTT press/release when it has none, or from the model's `speech_started/stopped` on the Realtime path.
- **Push-to-talk is the backtick key** (`` ` ``) on keyboards, LT on a pad, MIC on touch; thumbstick click and pinch per DIR-1 are unchanged. T keeps time of day.
- **With server VAD on, `` ` `` toggles mute** (the model listens continuously and the client only stamps windows); the PTT-commit path of DIR-1 (`turn_detection: null`, commit on release) remains available for noisy sets.
- The scripted voice suite runs against the grammar + executor in unit tests (40 utterances) and against `FakeRealtime` transcript replay (DIR-6); the same utterances against the real model are the nightly job.

## Consequences

- - The voice suite costs $0 per PR; the model's job shrinks to intent → tool call while the client owns resolution and safety.
- - The console works on every tier and offline; QA can direct with `?say=` and `__coastSay`.
- − Two front ends (grammar, model) can disagree on phrasing; the nightly suite is the referee and `docs/director-grammar.md` the source of truth.
- − The Web Speech API is Chrome/Safari only and needs a secure origin off localhost (`pnpm dev:https`).
