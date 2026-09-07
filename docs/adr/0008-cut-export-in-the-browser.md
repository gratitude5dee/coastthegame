# ADR-0008 — Cut export in the browser: fixed-step WebCodecs + Mediabunny, looks and captions in a 2D compositor

**Status:** accepted (2026-09-06) · **Owner:** GRATITUD3 · **Refs:** goal.md STU-1, STU-3, STU-4, W-5, QB-3, QB-9

## Context

STU-3 encodes video client-side with Mediabunny and muxes audio server-side; STU-4 wants captions, a colour LUT named by the mission's look, and 16:9 + 9:16. The live grade (W-5) is planned as a `postprocessing` LUT pass (AF-7), but the export had to ship before the post stack, and a real-time capture (`captureStream`) drops frames on the phone and the Quest.

## Decision

- **Offline, fixed step.** `planCut` (studio) plans the frames — the whole set or a bar range on the track's grid, 30 fps by default, ≤60 s — and `exportCut` re-renders the set **solid** (ghosts as bodies) at that step with the newest take's recorded camera, at 1080p on the live canvas with the live loop paused; each frame goes through a 2D compositor into Mediabunny's `CanvasSource` → WebCodecs (`avc` → `vp9` → `av1`, `vp8` → WebM) → `Mp4OutputFormat({ fastStart: 'in-memory' })`. The loop yields to the page every four frames so progress paints and input stays alive.
- **Looks are canvas filters** for now: a look = a CSS `filter` string (contrast / saturate / sepia / hue) + a radial vignette applied by the compositor; four looks ship (`35mm-dusk`, `vhs-1994`, `noir`, `clean`) and a mission names one. When W-5 lands, both the live grade and the export read the same LUT and the filter strings go.
- **Captions are a track** (`captionTrack`): title card 2.5 s, the director's markers 1.5 s at their times, end card 2 s + credit; drawn by the compositor with fades, sized to the short side so portrait reads the same.
- **Portrait** (9:16) changes the plan's width/height: the camera keeps its vertical field, the sides crop. No re-framing.
- Cuts upload to R2 through the Worker (≤64 MB) and get a share page (ADR-0005); the audio mux (fal `ffmpeg-api/compose`) is the next step, so the share page plays the video-only cut until then.

## Consequences

- - A clean 30 fps from a device that plays at 20; the same file on every tier; no GPU post dependency for the export.
- - Bar ranges make "export the drop" a one-liner and keep QB-9 in reach (a 30 s cut renders in well under 3 min on a laptop).
- − Filters are not LUTs: the exported look can differ from the live picture until W-5 unifies them.
- − `fastStart: 'in-memory'` keeps the whole file in RAM — fine for ≤60 s at 1080p; 4K (desktop optional) moves to a streaming target.
