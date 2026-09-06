# ADR-0003 — Two generative video engines: Dream (live) and Cuts (clip queue)

**Status:** accepted (2026-09-06) · **Refs:** goal.md A7, GEN-*

## Context
The brief asked for "MiniMax H3 Max Turbo with a real-time API". Verified: H3 Max Turbo renders a 5 s 768p clip in ≈1.5 s — faster than real time, but as async clips, not frame streaming. True live video-to-video in 2026 = Decart Lucy 2.5 (720p/30 fps, <40 ms/frame, WebRTC). Depth/pose-faithful generation = Wan 2.2 VACE (fal). Camera-path-native generation = World Labs Atlas (early access only).

## Decision
- **Dream** = Lucy 2.5 over WebRTC fed by `canvas.captureStream(24)`; desktop first; style presets; ≈$2.40/min via fal (or $1.20 direct).
- **Cuts** = job queue on fal: H3 Max Turbo (draft, I2V from the shot's first frame), Wan 2.2 VACE (faithful, from depth+pose passes), H3 reference-to-video (hero, beauty clip as camera reference + $COAST sheets).
- Prompts are composed from art-direction presets + scene summary + subject sheets + shot language (GEN-2); provenance is recorded per clip (STU-5).
- Atlas becomes a third Cuts engine when API access exists (D-2).

## Consequences
- + Honest latency model: instant previews (Turbo), faithful shots (VACE), hero quality (H3), true live (Lucy).
- − Live restyle is expensive per viewer-minute; gate behind a budget and desktop tier.
- − VACE base quality is older; hero clips rely on reference-video camera inheritance which is prompt-driven, not parametric.
