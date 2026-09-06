# FakeRealtime transcripts (goal.md DIR-6)

Recorded OpenAI Realtime event streams (`session.created`, `input_audio_buffer.speech_started/stopped`,
`response.function_call_arguments.done`, …) replayed by the `FakeRealtime` transport in tests so the voice suite costs $0.
Record one with `pnpm director record <name>` (M5) against the real API; commit only redacted JSON (no audio).

Shape: `{ name, description, clicks: [{ at, pointerHit?, groundPoint? }], events: [{ at, type, ... }] }` — `at` is ms from
session start and doubles as the clock the client sees (speech windows come out exactly as recorded); `clicks` are the
pointing events that landed in the deixis buffer during the recording, replayed into it at their times.
