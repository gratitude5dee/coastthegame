# Tasks (mirror of goal.md §9 — keep status here; one PR per line ideally)

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `(id)` = goal.md requirement IDs

## M0 — Foundation

- [x] Monorepo scaffold, `pnpm dev/build/test/test:e2e` wiring, CI workflow
- [x] Seed: three 0.180 + Spark 2.1 sample splat, tier detection + `budgets.ts` (PLT-1)
- [x] Deterministic screenshot harness (`?scene&cam&t&shot`) with SwiftShader — 2 baseline PNGs committed under `tests/e2e/__screenshots__/`; extend to real cells in M2
- [ ] Cloudflare deploy: Worker static assets + `pnpm deploy` + preview URL in PR (BE-4)
- [x] `/perf` in-app (`apps/web/src/perf.ts`: 600-frame ring, fps/frameMs p50/p95/max, QB-3/4/5 marks, `?perf=1` overlay + "Send report" → `/api/perf/report`) (BE-3)
- [ ] `/perf` dashboard page reading `/api/perf/report` objects from R2 (BE-3)
- [x] Service worker shell (`apps/web/public/sw.js` + `registerServiceWorker()` in `src/pwa.ts`): offline app shell, cache-first hashed assets/icons/samples, never `/api/*` or cross-origin (UX-2)
- [ ] `scripts/setup.sh` validated in a fresh Codex environment (≤10 min)
- [x] ESLint/Prettier root config (`eslint.config.js`, `.prettierrc`; `pnpm lint` = eslint + prettier --check)
- [x] Code-split Spark/three (QB-3): `three` 477 kB / 120 kB gzip, `spark` 4.93 MB / 1.75 MB gzip, app chunk 7.5 kB (was one 5.4 MB / 1.9 MB gzip chunk)
- [ ] Loading choreography stub (UX-3); Rapier + MediaPipe on demand via dynamic `import()` (QB-3)

## M1 — Art direction pack (AD-*)

- [ ] `art/style/STYLE.md` (pillars, palette, materials, camera language, do/don't)
- [ ] 8 key-art images (5 cells + hub + 2 moods) via imagegen; prompt log in `art/PROMPTS.md`
- [ ] $COAST turnaround (front/side/back + 3 expressions), lowrider concept, UI kit sheet
- [ ] **Approval checkpoint with GRATITUD3** → `art/concept/approved/`

## M2 — World v0 (W-*, PHY-1/5)

- [ ] Marble adapter (`tools/assets/adapters/marble.ts`) + `cell-*.json` jobs for 5 cells + hub; costs in `docs/cells.md`
- [ ] Handedness/scale fix + `.rad` LoD build + R2 publish + `cell.json` schema
- [ ] Rapier trimesh from collider; `align-collider` tool + CI gate (≤3%)
- [ ] Cell graph + streaming transitions (≤2 resident); pano skybox choreography (UX-3)
- [ ] Time-of-day presets + fog modifier (W-5)

## M3 — Actor mode ×3 platforms (ACT/INP/PHY/CAM-4)

- [ ] KCC + intents: KB/M, touch sticks, gamepad, XR sticks/teleport; footsteps
- [ ] Grab/throw props; SDF tagging wall; VR hand fog-touch + paint (Quest 3)
- [ ] Lowrider raycast vehicle + beat-driven hydraulics (PHY-3)
- [ ] Gates QB-1/2/3/4 with real-device `/perf` reports (desktop, Quest 3, iPhone)

## M4 — Characters & NPCs (CHR-_, ACT-_)

- [ ] Tripo adapter; $COAST hero (rig mixamo + clip set + 3 outfits)
- [ ] Selfie → avatar pipeline ≤4 min (QB-8); 8 premade + randomize
- [ ] 7 NPCs: navmesh, behaviours, cached dialogue + TTS (AUD-1)
- [ ] Possess / record / replay + 3-take demo

## M5 — Director & voice (CAM-_, DIR-_)

- [ ] CameraRig modes + transitions; VR diorama producer mode (CAM-3)
- [ ] Realtime WebRTC client + ephemeral secrets + tool schema wiring + ghost preview/undo
- [ ] Deixis resolver ≥40 unit tests; scripted voice suite (30 utterances, ≥27 pass)
- [ ] Astra planner: mission → shot list; 12 curated missions

## M6 — Studio & generative video (STU-_, GEN-_)

- [ ] Fixed-step recording + passes + Mediabunny export + R2 upload; billboard replay
- [ ] Cut assembly on beat grid, captions, 16:9 + 9:16, provenance manifest
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
