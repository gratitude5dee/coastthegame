# Tasks (mirror of goal.md §9 — keep status here; one PR per line ideally)

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `(id)` = goal.md requirement IDs

## M0 — Foundation

- [x] Monorepo scaffold, `pnpm dev/build/test/test:e2e` wiring, CI workflow
- [x] Seed: three 0.180 + Spark 2.1 sample splat, tier detection + `budgets.ts` (PLT-1)
- [x] Deterministic screenshot harness (`?scene&cam&t&shot`) with SwiftShader — 2 baseline PNGs committed under `tests/e2e/__screenshots__/`; extend to real cells in M2
- [~] Cloudflare deploy: Worker static assets + `pnpm deploy` + preview URL in PR (BE-4) — **the Worker is on Hono** (`workers/api/src/index.ts`, AF-7): sessions (`x-coast-session`), the per-session budget ledger in `SessionDO` (BE-2, gates the Realtime secret), takes to R2 (ACT-4), Coast Cuts to R2 with range playback + `/c/<token>` share pages (STU-3), perf reports + `/perf` dashboard (BE-3); `tests/api/worker.test.ts` runs it on workerd with emulated R2/DO; `pnpm dev:api` + the Vite proxy locally — the deploy itself needs `CLOUDFLARE_API_TOKEN`
- [x] `/perf` in-app (`apps/web/src/perf.ts`: 600-frame ring, fps/frameMs p50/p95/max, QB-3/4/5 marks, `?perf=1` overlay + "Send report" → `/api/perf/report`) (BE-3)
- [x] `/perf` dashboard page reading `/api/perf/report` objects from R2 (BE-3) — served by the Worker (`GET /perf`, `GET /api/perf/reports`)
- [x] IWER wired: `?xrsim=1` installs an emulated Quest 3 (+ `@iwer/devui` puppeteering on the dev server); `tests/e2e/xr.spec.ts` drives it headless
- [x] Service worker shell (`apps/web/public/sw.js` + `registerServiceWorker()` in `src/pwa.ts`): offline app shell, cache-first hashed assets/icons/samples, never `/api/*` or cross-origin (UX-2)
- [ ] `scripts/setup.sh` validated in a fresh Codex environment (≤10 min)
- [x] ESLint/Prettier root config (`eslint.config.js`, `.prettierrc`; `pnpm lint` = eslint + prettier --check)
- [x] Code-split Spark/three (QB-3): `three` 477 kB / 120 kB gzip, `spark` 4.93 MB / 1.75 MB gzip, app chunk 7.5 kB (was one 5.4 MB / 1.9 MB gzip chunk)
- [x] Loading choreography (UX-3): static title card in `index.html` adopted by `apps/web/src/ui/loading.ts` — weighted stages fetch (Spark `onProgress`) → detail (LoD) → physics, reveal wipe timed to the next beat, 30 s stall fallback; pano-skybox stage lands with M2. Rapier on demand via dynamic `import()` (QB-3); MediaPipe pending

## M1 — Art direction pack (AD-*)

- [ ] `art/style/STYLE.md` (pillars, palette, materials, camera language, do/don't)
- [ ] 8 key-art images (5 cells + hub + 2 moods) via imagegen; prompt log in `art/PROMPTS.md`
- [ ] $COAST turnaround (front/side/back + 3 expressions), lowrider concept, UI kit sheet
- [ ] **Approval checkpoint with GRATITUD3** → `art/concept/approved/`

## M2 — World v0 (W-*, PHY-1/5)

- [ ] Marble adapter (`tools/assets/adapters/marble.ts`) + `cell-*.json` jobs for 5 cells + hub; costs in `docs/cells.md`
- [ ] Handedness/scale fix + `.rad` LoD build + R2 publish + `cell.json` schema
- [ ] Rapier trimesh from collider; `align-collider` tool + CI gate (≤3%)
- [~] Cell graph + streaming transitions (≤2 resident); pano skybox choreography (UX-3) — **streaming skeleton on the sample worlds** (ADR-0009): `packages/engine/src/world/level.ts` (the graph from SCH-2 + `placements`, doorways from SCH-1 `transitions` on both cells of an edge, the pure `CellStreamer`: load within `streamAt_m`, evict the farthest, arrive in the return doorway), `transition.ts` (procedural roads: asphalt + curbs + fog sprites, a road cut through the cells' ground grids and an SDF dissolve through their splats, gates until the far cell's ground is in), fences open at doorways, ground colliders clipped to the scan's coverage; `apps/web/src/world/levels.ts` (`strip` = valley ↔ snow street ↔ sutro, `run` = three local butterflies for `tests/e2e/streaming.spec.ts`) — Marble cells, the kitbash segments and the pano choreography pending
- [~] Time-of-day presets + fog modifier (W-5) — **`packages/engine/src/world/grade.ts`**: five grades (noon, golden, blue, night, fog_noon) = per-splat dyno modifier (tint · saturation · lift · exp² fog from the camera), `SkyDome` (zenith/horizon/ground gradient, sun disc + glow, stars), sun + hemisphere lights and `scene.fog` from the same state, 1.2 s dissolves; `Atmosphere.setTime/setWeather` behind the director's `set_time` / `set_weather` (fog and rain as density), T cycles, `?time=`; the road fog sprites follow — post LUT (`postprocessing`) and the pano env map pending

## M3 — Actor mode ×3 platforms (ACT/INP/PHY/CAM-4)

- [x] KCC + intents: KB/M (pointer lock / drag), touch sticks + buttons, gamepad, **WebXR controllers** (`apps/web/src/input/xrControllers.ts`: sticks, snap turn, teleport, buttons → intents); **procedural SFX** (`apps/web/src/audio/sfx.ts`: footsteps by stride, jump/land, positional engine hum, hydraulic hiss/thump, spray hiss, clapper, wind bed; M mutes) — ElevenLabs/library catalogue (AUD-3) later
- [x] Grab/throw primitive props + click-to-select → click-to-place put-that-there with ghost + undo; **spray-paint tagging** (`packages/engine/src/world/paint.ts`: global Spark SplatEdit, SDF sphere puffs, strokes/undo, per-tier SDF budget; two cans, click/trigger sprays within arm's reach, logged as `sdfPaint` take edits) — VR hands pending
- [x] Lowrider raycast vehicle (`packages/engine/src/vehicles/lowrider.ts`: Rapier DynamicRayCastVehicleController, arcade tuning pinned by Node tests) + hydraulics (held switches I/J/K/L · d-pad · LIFT, hops with corner impulses) + enter/exit + chase/driver cams + touch pedals (PHY-3); beat grid `BeatClock` + metronome drive auto-hops (H) — placeholder body until the Tripo hero car (M4)
- [x] M3.5 slice: missions 1–2 (`MISSIONS_V0`: Low & slow → Hop on the one, beatSync judged on manual hops), take clip via `captureStream(0)` + `requestFrame` (robust at low fps), Photographer hands out the next mission after a ≥1★ verdict
- [ ] Gates QB-1/2/3/4 with real-device `/perf` reports (desktop, Quest 3, iPhone) — `pnpm dev:https` serves the LAN URL over TLS for the headset / phone pass

## M4 — Characters & NPCs (CHR-_, ACT-_)

- [ ] Tripo adapter; $COAST hero (rig mixamo + clip set + 3 outfits)
- [ ] Selfie → avatar pipeline ≤4 min (QB-8); 8 premade + randomize
- [~] 7 NPCs: navmesh, behaviours, cached dialogue + TTS (AUD-1) — **browser speech synthesis speaks the lines** (`apps/web/src/audio/tts.ts`: per-character voices for the NPCs, the director's replies and possession; `?tts=0`, M mutes) until ElevenLabs; **4 NPCs walking** (`packages/engine/src/npc/`: Recast navmesh baked at runtime from the cell collider or the splat-derived ground grid, Detour crowd with avoidance; `NpcBrain` idle · loiter · approach · greet; `apps/web/src/npc/npcs.ts`: kinematic capsules, `#coast-sub` subtitles) — the Photographer walks up and briefs you, Rico/Mari/Dee greet in passing; skinned rigs, 3 more NPCs, TTS pending
- [~] Possess / record / replay + 3-take demo — **multi-take blocking** (`packages/studio/src/set.ts`: the mission's takes replay together, in sync, while the next one rolls; ghosts hold their mark; the set loops after the cut) + **possession** (V / Back / BE swaps identity and place with the nearest NPC; takes carry the actor id, ghosts wear that look; driving poses replay as a see-through lowrider; **thrown / placed props replay kinematically** from per-take pose tracks, so the replay and the export re-throw the can) — skinned rigs and bone tracks pending

## M5 — Director & voice (CAM-_, DIR-_)

- [~] CameraRig modes + transitions ✓; **VR diorama producer mode (CAM-3)** ✓ world group at 1:12 on the table, physics paused (hand pick/place + write-back pending); XR rig moves `localFrame` (CAM-4) with snap turn + teleport; **keyframed camera paths (CAM-7)** ✓ `packages/engine/src/camera/path.ts` (own centripetal Catmull-Rom, time-keyed, slerped orientation, lerped lens, eased; `sample(t)` is pure so it scrubs) + the rig's **locked shot** (CAM-2: `lock/unlock/scrub/play`, hands the camera back at the last key) — _set a key · play the path in 8 seconds · free camera_ from the console; the export rides the path when it has two keys; a timeline UI pending
- [~] Realtime WebRTC client + ephemeral secrets + tool schema wiring + ghost preview/undo — **acts land** (`packages/director/src/executor.ts`: SceneAct → SceneOps with deixis resolution and the confidence gate; `grammar.ts`: the literal film-set grammar; `apps/web/src/director/console.ts`: the `/` bar, `?say=`, `__coastSay`); camera acts on the rig (shots, moves, lenses, follow / look at); **push-to-talk** through the browser's speech recognition (`voice.ts`: hold `/ LT / MIC, real speech window for deixis) and the **confirmation loop** (a question leaves the act pending with a ghost preview; _yes / no / the left one_ finish it); the WebRTC Realtime client + ephemeral key (needs`OPENAI_API_KEY`) pending
- [~] Deixis resolver ≥40 unit tests; scripted voice suite (30 utterances, ≥27 pass) — 40 utterances pass through the grammar + executor (`tests/unit/grammar.test.ts`, `executor.test.ts`); **`docs/director-grammar.md`** documents the vocabulary (DIR-4); scaling past 3× takes the destructive bar (DIR-3); the same suite against the real Realtime model is the nightly job (key pending)
- [~] **The reel** (MIS-4, `packages/studio/src/reel.ts` + `apps/web/src/ui/reel.ts`): the track's bars across the top, missions marked, filled gold when earned, stars per mission, click to watch the best take again (persisted per browser) — unlocks (outfits, lenses, patterns) pending
- [ ] Astra planner: mission → shot list; 12 curated missions

## M6 — Studio & generative video (STU-_, GEN-_)

- [~] Fixed-step recording + passes + Mediabunny export + R2 upload; billboard replay — **Cut → MP4** (`packages/studio/src/export.ts` plans the frames: whole set or a bar range, 30 fps, ≤60 s; `apps/web/src/studio/exporter.ts` re-renders the set solid at a fixed step, the newest take's camera, 1080p through WebCodecs → Mediabunny MP4/WebM; the verdict card's button + `__coastExport`) — passes, R2 upload, server-side audio mux pending; billboard replay ✓ (real-time clip)
- [~] Cut assembly on beat grid, captions, 16:9 + 9:16, provenance manifest — **captions + looks + 9:16** (`packages/studio/src/captions.ts`: title card, the director's markers at their times, end card + credit; a look per mission as a grade + vignette the 2D compositor applies over every frame; the 9:16 button on the verdict card); **provenance manifest** (STU-5, SCH-7: `packages/studio/src/provenance.ts` — cells, takes, shot, generative spans, references, cost, app version + commit, the file's sha256; built at export, uploaded next to the cut (`PUT /api/cuts/:id/manifest`, the cut upload itself is refused unless it hashes to the manifest), public with the share token, credits on the share page) — beat-grid assembly across missions pending
- [ ] fal jobs (Turbo draft / VACE faithful / H3 hero) via Queue + JobDO; Dream mode (Lucy) desktop
- [ ] Gates QB-9, QB-10 (budget ledger)

## M7 — Capture, onboarding, grounding (CAP-_, GRD-_)

- [ ] Guided phone capture → Marble → playable ≤10 min (QB-7)
- [ ] Object photo → Tripo prop; WZRD profile adapter (flag); OAuth + guest
- [ ] Quest room capture + 3-point alignment; phone GPS/compass + QR beacon; Explore map (3D Tiles + attribution)

## M8 — Identity & minting (ID-*)

- [ ] Phantom Connect sign-in; Metaplex mint on devnet with provenance; share page + "remix this shot"
- [ ] Mainnet flag; royalties/splits documented (D-6)

## M9 — Polish & awards

- [ ] All QB gates on all platforms; Lighthouse; a11y; audio mix; loading + UI motion
- [ ] Trailer made with the studio; case study; Awwwards/FWA/Webby drafts in `docs/awards/`
- [ ] 6-device bug bash; crash-free ≥99%
