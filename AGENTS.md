# AGENTS.md — operating instructions for the build agent (Codex / GPT-6 Astra)

You are building **$COAST the Game**. The product spec is `goal.md` (read it first, fully). This file is about *how* you work in this repo.

## 0. Reasoning & tools
- Use `xhigh`/`high` reasoning for architecture, visual QA, physics/camera tuning, and anything with a QB gate; `medium` for boilerplate.
- Skills: use the built-in `imagegen` system skill for concept art/textures (log prompts in `art/PROMPTS.md`). Repo-vendored skills live in `skills/` (fal-*, ffmpeg-agent-actions, threejs-*, cinematography, solana-skill, playwright-recording, elevenlabs, sound-effects, writing-for-agents, to-spec, to-tickets) — read the relevant `SKILL.md` before touching that domain.
- MCP: Blender MCP is **not** available in cloud tasks (no GUI). Use headless `blender -b --python tools/assets/blender/<script>.py`. If a local desktop session has Blender MCP, you may use it, but every result must be reproducible by a headless script committed to `tools/assets/blender/`.

## 1. Environment
- `scripts/setup.sh` is the Codex environment setup script (Node 22, pnpm 9, Rust stable + Spark `build-lod`, Python 3.11+ with `bpy` or a Blender 5.2 LTS tarball, ffmpeg, `@gltf-transform/cli`, KTX-Software `toktx`, Playwright chromium). Keep it idempotent and ≤10 min.
- Secrets come from the Codex environment (never from files): `OPENAI_API_KEY`, `WORLDLABS_API_KEY`, `TRIPO_API_KEY`, `FAL_KEY`, `DECART_API_KEY`, `ELEVENLABS_API_KEY`, `GOOGLE_MAPS_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `HELIUS_RPC_URL`. See `.env.example` for the full list and which are optional. If a required secret is missing, stop that thread and ask; do not stub vendor calls silently — write an explicit `MockProvider` behind the same adapter interface and say so in the PR.
- Network: vendor APIs only. Never scrape X/Twitter or Google tiles. Never disable TLS verification.

## 2. Workflow
1. **Pick a requirement ID** from `goal.md` (or a task in `docs/tasks.md`). One PR ≈ one ID (or a small cluster).
2. **Plan** in the PR description: files, approach, risks, how you'll verify.
3. **Build** with exact version pins (`three@0.180.0`, `@sparkjsdev/spark@2.1.x`). No dependency upgrades outside a dedicated "chore(deps)" PR with screenshot diffs.
4. **Verify**:
   - `pnpm lint && pnpm typecheck && pnpm test` (vitest) must pass.
   - `pnpm test:e2e` (Playwright + SwiftShader) captures deterministic screenshots at `/?scene=<id>&cam=<preset>&t=<s>&seed=<n>`; commit the PNGs under `tests/e2e/__screenshots__/` and compare them **with your own vision** against `art/concept/approved/`. Write the score (0–10) and what to fix in `art/DIFF.md`. Iterate until QB-12 (≥8) for the shots the PR touches.
   - Headless runs prove *correctness*, not *performance*. Performance evidence = `/perf` reports from real devices (`docs/perf/<date>-<device>.json`). Ask GRATITUD3 to run the device checklist (`docs/device-checklist.md`) when a milestone gate needs it — and **keep working on non-gated requirement IDs while you wait** (never idle on a device gate).
   - Screenshot baselines (`tests/e2e/__baselines__/`) are Linux/SwiftShader-only; always pass `tier=desktop` in harness URLs (SwiftShader would otherwise detect as `fallback`). Regenerate with `--update-snapshots` only in a PR that explains the visual change in `art/DIFF.md`.
   - WebXR code paths run headless through **IWER** (Immersive Web Emulation Runtime) in the e2e harness (M0); voice paths run through **`FakeRealtime`** transcript replay (`tests/fixtures/realtime/`) — the real Realtime API is only hit by the nightly job.
5. **Document**: ADR in `docs/adr/` for any deviation from `goal.md`; update `docs/costs.md` for spend; update `docs/tasks.md` status.
6. **PR hygiene**: title `[<ID>] <what>`, a GIF or screenshot, test evidence, cost line, open questions.

## 3. Assets & binaries
- Nothing >5 MB in git (`scripts/check-binaries.sh` runs in CI). Large outputs → R2 via `pnpm assets publish <job>` (content-hash keys) and register in `assets/manifests/<job>.json`.
- Every asset is produced by a **job spec** (`tools/assets/jobs/<id>.json`, schema in `tools/assets/jobs/schema.json`) so it can be re-run and parallelized. One manifest file per job; never edit another job's manifest.
- Parallelism: fan out independent jobs as separate Codex tasks (e.g., 6 cells × Marble, 7 NPCs × Tripo). Coordinate through job specs and manifests only.
- Splats: `.spz`/`.rad` never in git; `cell.json` (small) is in git.

## 4. Cost guardrails
- Daily vendor spend cap during development: **$40** without approval. Reference prices: Marble ≈ $1.2–2.5 / world, Tripo ≈ $0.6–0.8 / rigged character, H3 Max Turbo $0.04/s, H3 $0.13/s (2K), Lucy ≈ $2.40/min, Realtime ≈ $0.05–0.25/min.
- Before any batch >$10, post the plan (count × unit cost) in the PR and wait for approval unless it was pre-approved in `docs/costs.md`.
- Dev defaults: Marble draft mode where available, Tripo P1 low-poly for placeholders, H3 Max Turbo for previews, `gpt-realtime-2.1-mini` for voice.

## 5. Stop and ask (post in the PR and pause that thread)
- **D-0 provisioning** (Cloudflare/R2/KV/DNS, OAuth apps, Phantom app id, Maps billing, IPFS token, vendor keys, Codex internet allowlist) before the first deploy — scaffold with `MockProvider`s until answered.
- Art-direction approval (M1) and any change to `art/style/STYLE.md`.
- Sign-off of the 12 planner-authored missions (M5, MIS-5).
- Spend above the cap; anything on Solana **mainnet**; any licensing question (World Labs commercial terms, music).
- A vendor API that deviates from `goal.md` Appendix A (write what you observed).
- A QB gate you cannot meet after two honest attempts — propose the trade-off instead of silently lowering the bar.

## 6. Code conventions
- TypeScript strict; ESM; pnpm workspaces; vitest; Playwright. Prettier + ESLint configs at the root.
- `packages/engine` has **no DOM UI**; `apps/web` owns UI. `packages/director` and `packages/studio` depend on `engine`, never the reverse.
- All platform numbers come from `packages/engine/src/platform/budgets.ts`.
- Physics and gameplay run on a fixed 60 Hz step (36 Hz in VR when needed) with render interpolation. **Export never re-simulates**: takes store authoritative poses + world edits; export is 30 fps by re-timing (goal.md STU-1, ACT-2).
- Decided, not open (goal.md AF-7): Hono for the Worker, `postprocessing` for post, own CatmullRom camera paths (no Theatre.js), hand-rolled entity registry, vanilla TS UI, vitest + Playwright + IWER, prebuilt `build-lod` binary via `BUILD_LOD_URL`.
- Every vendor integration is an adapter with a `MockProvider` for tests.

## 7. Definition of Done (per PR)
- ACs of the requirement ID checked off in `docs/tasks.md`.
- Unit + e2e green; screenshots reviewed; `art/DIFF.md` updated if visuals changed.
- No new binaries in git; manifests updated; costs logged.
- Deploy preview URL (Cloudflare) in the PR.
