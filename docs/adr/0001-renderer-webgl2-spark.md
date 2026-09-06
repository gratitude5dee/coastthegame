# ADR-0001 — Single WebGL2 render path: three.js 0.180 + Spark 2.1

**Status:** accepted (2026-09-06) · **Owner:** GRATITUD3 · **Refs:** goal.md A3, W-1, QB-2

## Context
Gaussian splats are the base layer. Options: Spark 2.1 (World Labs, MIT, WebGL2, LoD + `.rad` streaming, SDF edits, XR wrapper), three.js r186 native splat renderer (WebGPU/TSL with WebGL fallback, SH0, no LoD/streaming), @mkkellogg/gaussian-splats-3d, PlayCanvas SuperSplat viewer. WebXR on Quest Browser is WebGL2 in production (WebGPU-in-XR flag-gated); three.js WebGPU-backend XR is unreliable in 2026; iOS Safari 26 has WebGPU but no WebXR.

## Decision
One render path everywhere: `three@0.180.0` (exact pin; Spark peer ≥0.180) + `@sparkjsdev/spark@2.1.x` on `WebGLRenderer`. Post-processing via `postprocessing` with per-tier budgets. LoD via offline `build-lod --quality --rad-chunked` and `paged: true`.

## Consequences
- + One code path for desktop, Quest, iPhone, Vision Pro, Android; proven by Starspeed/HoloLab at scale.
- + Streaming LoD makes multi-cell levels feasible within 500K–2.5M splat budgets.
- − No WebGPU compute for effects in v1; three.js upgrades are gated by Spark's peer range and the `gl.texSubImage2D` sort upload.
- − Uniform scale only on `SplatMesh` (non-uniform needs experimental `covSplats`).
- Revisit in 2027 when WebXR/WebGPU binding ships on Quest and three.js native splats gain LoD.
