# FakeRealtime transcripts (goal.md DIR-6)

Recorded OpenAI Realtime event streams (`session.created`, `input_audio_buffer.speech_started/stopped`,
`response.function_call_arguments.done`, …) replayed by the `FakeRealtime` transport in tests so the voice suite costs $0.
Record one with `pnpm director record <name>` (M5) against the real API; commit only redacted JSON (no audio).
