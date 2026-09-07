# ADR-0002 — Characters are GLB skinned meshes with Mixamo bone naming (no splat skinning)

**Status:** accepted (2026-09-06) · **Refs:** goal.md A6, CHR-1…5

## Context

Spark's `SplatSkinning` is experimental and has no importer for standard rigs. Avatar vendors are volatile (Ready Player Me, HEAT, RADiCAL gone within a year). Tripo auto-rig outputs `mixamo` or `tripo` bone naming; Mixamo's FBX library is alive but unmaintained; Meshy offers rigging + a 600-motion library as a fallback.

## Decision

- All characters (hero, avatars, NPCs) are glTF skinned meshes; skeleton = Mixamo bone names, 1 unit = 1 m, T-pose, in-place clips.
- Production path: Tripo H3.1 image-to-3D → Tripo Auto-Rig (`spec:"mixamo"`) → Tripo preset retargets → Mixamo FBX gestures converted headlessly (`tools/assets/blender/fbx_to_glb.py`) → `gltf-transform optimize` (meshopt, KTX2; **no Draco on skinned meshes**).
- Every rig/clip is stored as plain GLB in R2 + manifest; no hosted avatar IDs at runtime.
- CI validation step: bone count ≤80, rest pose, scale, root motion off, clip names match CHR-2.

## Local import checkpoint (2026-09-07)

CHR-1 / CAP-1 now use one `AvatarAsset` / `Avatar` path for uploaded, URL, and generated self-contained GLBs. The default is a source-generated, 22-bone / 228-triangle mannequin, not the campaign hero. Player, NPC possession and ghost instances own separate skeletons/materials; assets retain shared geometry/textures until their last instance releases them. Unit tests exercise the known-good rig and actual deformed vertices after normalization. This is not certification of the full CHR-2 clip list or a universal rest-pose validator.

- Import checks enforce 20 MiB source, 64 MiB decoded buffers/accessors, 80 bones, 30,000 triangles, and bounded embedded textures. External image/buffer URIs are rejected. Meshopt uses Three's bundled decoder; Draco and KTX2 currently return actionable conversion errors rather than fetching remote decoders.
- Normalize to a 1.8 m character in meter units, centered on X/Z with the rest-pose feet at Y=0. The UI explicitly selects source forward (`-Z` or `+Z`); it is not inferred from arbitrary geometry. Mixamo names and their track bindings are canonicalized to loader-safe `mixamorigHips` form. Unknown rigs remain static figurines; no unverified Tripo joint mapping is guessed.
- Named idle/walk/run/fall clips are sampled at absolute time with planar root translation removed; supported rigs without a matching clip use procedural gait. Unsupported/unrigged meshes stay rigid. Full crossfade state machines, arbitrary clip selection, foot IK, six onboarding motions and recorded bone tracks remain pending. The control pose pass now reads available canonical Mixamo joints from these sampled instances; missing face landmarks and unsupported/unrigged bodies are omitted, while legacy actors retain the procedural proxy. This is rendered-rig readback, not full recorded bone motion.
- Takes and cut manifests snapshot avatar ID/name/tint, never the model URL or source image. Root replay stays authoritative; bone animation is reconstructed from time/speed/grounded, so exact live skeletal phase is not yet recorded. Up to eight imported assets remain in page memory for earlier ghosts. The device-storage follow-up below adds opt-in persistence. A saved take whose model is absent still refuses replay with an explanation rather than silently wearing the current avatar. Legacy takes without avatar metadata retain their capsule fallback.
- Avatar changes are blocked while recording/exporting, possessing an NPC, or in XR. Failed or superseded loads retain the old character. The optional card owns input while open; its close button remains available during work.

Generation is an opt-in Worker adapter, not a browser-side key or agent-time asset-generation call. The session Durable Object atomically reserves the budget and stores the request, then runs bounded alarm-driven submission/polling. Keeping jobs beside their ledger intentionally avoids cross-object reservation ambiguity. Request IDs are session-scoped job IDs, making a lost create response recoverable by GET. Ambiguous submission is retained as unknown and never automatically retried. Reservations remain charged against the session cap even on failure; they are conservative budget accounting, not confirmed vendor invoices. The UI retains pending inputs/request IDs in tab-scoped sessionStorage, asks for consent, and checks existing jobs only on request. Guest session IDs still have ADR-0005's limitations; this is not production user authentication or a global spending gate.

Verified provider restrictions:

- **Meshy v6 text-to-3D (fal):** enabled only with a Worker `FAL_KEY`; requests an unrigged 30k-triangle target and imports `model_glb.url` through the same checks. Provider outputs may still need optimization if they exceed byte/texture/geometry limits. No paid end-to-end generation has been verified.
- **Hunyuan3D v3:** adapter retained but unavailable before reservation. Its documented minimum `face_count` is 40,000, above CHR-1's 30k import budget; an approved reduction step is required. [Official schema](https://fal.ai/models/fal-ai/hunyuan3d-v3/image-to-3d/api).
- **Tripo:** unavailable before reservation. The documented presets do not cover the requested six onboarding motions (notably point); the v2.5 and v1.0 preset lists differ and batches allow five motions. An approved subset or alternate retarget source is needed rather than inventing presets. [Retarget documentation](https://developers.tripo3d.ai/en/docs/animations-retarget).

## Opt-in device storage (2026-09-07)

- `apps/web/src/avatarStore.ts` uses a separate `coast-avatars` v1 IndexedDB with metadata, binary assets and selection settings. It does not migrate or delete the take database. Limits are eight assets, 128 MiB total GLB bytes and 20 MiB each; inventory/budget checks and writes share one readwrite transaction. No automatic eviction or fake persistent memory fallback.
- **Save on this device** is unchecked by default. Validated source bytes, a bounded display name, source-forward and target height are saved; source URLs are not. The ID hashes exact GLB bytes plus versioned normalization options. Filenames do not change identity; duplicate saves retain the original saved label. Different orientation/height creates a different identity. Hashes and full GLB validation are checked again on restoration.
- Startup loads only the remembered saved selection asynchronously after starting the render loop; it does not await that load to start gameplay. A QA `?avatar=` URL takes precedence. Saved-take replay lazily prepares the referenced asset before creating its ghost, without switching the live player. Newer review, stop, recording, export or scene disposal invalidates pending review work; late errors cannot overwrite a newer request.
- The library exposes explicit **Use saved** and confirmed **Remove saved** actions. Removal deletes only the named device copy and matching remembered selection. It does not delete takes or evict currently loaded instances; those remain usable until the page closes. Missing/corrupt files are reported rather than silently substituting a different avatar. A later exact reimport can satisfy stable-ID references, but historical UUID-based imports have no automatic migration because their missing bytes cannot be reconstructed.
- Page-only imports leave the prior remembered saved choice unchanged. **Use mannequin** clears the remembered choice when storage permits. Storage/quota failures keep gameplay available and are disclosed. Secure-context SHA-256 is required for stable IDs/saving; without it imports can remain page-only. Browser/site-data deletion or storage eviction can still remove local files; this is not encrypted storage, cloud backup or production asset hosting.

## Consequences

- - Vendor-independent, portable, works with `AnimationMixer` today; VRM wrapping possible later.
- − Selfie avatars are stylized likenesses, not scans (Avaturn/CC5 are the paid/desktop alternatives).
- − Retarget drift between Tripo/Meshy/Mixamo naming needs the CI validation step.
