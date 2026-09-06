# ADR-0002 — Characters are GLB skinned meshes with Mixamo bone naming (no splat skinning)

**Status:** accepted (2026-09-06) · **Refs:** goal.md A6, CHR-1…5

## Context

Spark's `SplatSkinning` is experimental and has no importer for standard rigs. Avatar vendors are volatile (Ready Player Me, HEAT, RADiCAL gone within a year). Tripo auto-rig outputs `mixamo` or `tripo` bone naming; Mixamo's FBX library is alive but unmaintained; Meshy offers rigging + a 600-motion library as a fallback.

## Decision

- All characters (hero, avatars, NPCs) are glTF skinned meshes; skeleton = Mixamo bone names, 1 unit = 1 m, T-pose, in-place clips.
- Production path: Tripo H3.1 image-to-3D → Tripo Auto-Rig (`spec:"mixamo"`) → Tripo preset retargets → Mixamo FBX gestures converted headlessly (`tools/assets/blender/fbx_to_glb.py`) → `gltf-transform optimize` (meshopt, KTX2; **no Draco on skinned meshes**).
- Every rig/clip is stored as plain GLB in R2 + manifest; no hosted avatar IDs at runtime.
- CI validation step: bone count ≤80, rest pose, scale, root motion off, clip names match CHR-2.

## Consequences

- - Vendor-independent, portable, works with `AnimationMixer` today; VRM wrapping possible later.
- − Selfie avatars are stylized likenesses, not scans (Avaturn/CC5 are the paid/desktop alternatives).
- − Retarget drift between Tripo/Meshy/Mixamo naming needs the CI validation step.
