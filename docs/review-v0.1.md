# Review of goal.md v0.1 → v0.2 (Claude Fable 5.1, 2026-09-06)

An adversarial review pass (principal engineer + game director lens) was run against v0.1 before hand-off to Astra. Every blocker and most feasibility/design findings were folded into v0.2 and the scaffold; the rest are listed as open decisions (goal.md §12). This file is the disposition record.

## Blockers found → fixed in v0.2
| # | Finding | Disposition |
|---|---|---|
| 1 | Deictic `t` timestamps were unfillable — the Realtime model has no clock and no word timings | DIR-1/2/3 rewritten: client stamps the speech window; model passes deictic word + ordinal; Bolt's rule pairs n pointing events with n deictics; `call_id` replaces `request_id`. Implemented in `packages/director/src/{schema,deixis}.ts` + fixture suite (7/7). |
| 2 | Golden path could not meet QB-10 ($1.50): Dream alone ≈ $1.80–3.60 | Dream removed from the golden path (premium toggle with meter); per-step budget table ≈ $0.90; hero/VACE renders async post-session (GEN-6). |
| 3 | 90 s allotted for renders that take 6–18 min | Only Turbo drafts are synchronous; QB-9 re-scoped to ≤3 min for game render + ≤2 Turbo drafts. |
| 4 | 1080p 16-bit PNG pass sequences ≈ 1 GB per cut | STU-2: control passes ≤720p 8-bit video, only for faithful spans. |
| 5 | Milestone order: QB-4 gated at M3 but CameraRig lands in M5; "vertical slice" undefined | New **M3.5 Vertical slice** with an explicit ID list; QB-4 moved there. |
| 6 | Fixed-step contradiction (60 Hz sim vs re-sim at 1/24) | STU-1: sim always 60 Hz; export re-times to 30 fps; poses authoritative; props recorded. |
| 7 | Take size claim (≤1 MB/min) unsupported | ACT-2/SCH-4: 16-bit quats, delta keyframes, world-edit log. |
| 8 | User-capture path assumed `build-lod` in Workers | CAP-2/W-1: user cells use runtime `lod:true` on the 500k spz; `.rad` is agent-time only; alignment client-side. |
| 9 | Handedness note was a Unity artefact | W-2: rotate, never mirror; verify spz + collider + pano together. |
| 10 | 1 fps image frames overflow Realtime context | DIR-1: one frame per PTT press + one per act; old image items pruned. |
| 11 | Day-one schemas undefined | New §7.16 (cell, level, mission, take, manifest, deixis fixture) + TS types in `packages/engine/src/world/cell.ts`, `packages/studio/src/missions.ts`. |
| 12 | Untestable gates (PHY-5, QB-6, QB-11, QB-12) | All rewritten with metrics, named shots (`docs/shots.md`) and oracles. |
| 13 | W-3 resident-cell contradiction; `budgets.ts` `residentCells:1` | Active + nearest neighbour on every tier; budgets updated. |
| 14 | Tripo preset ids wrong | `preset:biped:*` per docs, with a verify-on-first-call note. |
| 15 | Metaplex standard deferred | Core on devnet now; Token Metadata only if D-6 requires. |

## Feasibility findings → adopted
Quest gate set to 750K splats at framebuffer 0.7 (raise with `/perf` evidence); QB-3 requires code-splitting; QB-8 retargets 6 onboarding clips synchronously; QB-5 defines "visible" as ghost/highlight and commits audio on PTT release; Dream dev testing capped at 2 min/day; D-2/D-7 (licensing) moved before M2 spend; server-side audio mux in v1 (WebCodecs AAC gaps); Vision Pro "gaze" renamed head ray; calendar re-baselined (D-8: slice ~Oct 9, teaser Nov 19, beta mid-Dec).

## Design findings → adopted
Shot meter + ★ verdicts with numeric hints + 3-take limit + unlocks + bar-by-bar reel (MIS-1…6); role partition with mode-gated tools (CAM-8); golden path re-scripted (Photographer tutor, empty billboard first, Director re-frames, no Producer detour); mission names the look, Dream is a 3-preset toggle; 9:16 phone path; world-edit log in Takes; click/tap fallback for put-that-there; "first 30 seconds" polish priority.

## Agent-operability findings → adopted
D-0 provisioning checklist incl. Codex allowlist; "never idle on a device gate"; IWER for headless XR; `FakeRealtime` transcript replay; AF-7 "decided, not open" list (Hono, `postprocessing`, own camera paths, no Theatre.js, vanilla TS UI, prebuilt `build-lod`); planner-authored + human-approved missions; VR gesture map (INP-5); NPC live replies via the Worker (no second Realtime session); diorama semantics (scene root, physics paused, write-back); measurement recipes (§10.7).

## Scaffold findings → fixed
Schema: `list_assets`/`group`/`ungroup`/`spawn.tags`/`desc.near`/`next_to`, `anyOf` + `$defs`, mode filtering, no timestamps from the model. Budgets: `residentCells: 2`, Quest framebuffer 0.7, `lodRenderScale`, damping as time constants. Tiers: software-renderer → fallback, `?tier=` override. Seed: `seed`/`tier` params, `performance.mark`s, LoD-ready + frame-count settle, local sample splat. Worker: CORS origin, session header, size-capped perf reports. Wrangler: R2 CORS/Range note. E2E: `toHaveScreenshot` baselines with masked HUD. Setup: no hard `sudo`, bpy wheel Python check, prebuilt `build-lod` URL, KTX-Software resolved from the release API, no lockfile-mutating fallback. Blender: no Draco on colliders; Mixamo cm→m scale, `mixamorig:` prefix normalization and rig validation. Jobs: preset ids. `.gitignore` + `scripts/check-binaries.sh` (5 MB rule in CI). Studio types: Dream is a session, Provenance carries user refs + bar range.

## Not adopted (deliberately)
- Multiplayer stays out of v1 (D-9).
- WebGPU render path stays a 2027 revisit (ADR-0001).
- Self-hosted real-time video (Daydream Scope/StreamDiffusionV2) documented as a v2 option only.
