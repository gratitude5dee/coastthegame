# $COAST the Game

A web-native, cross-reality game/studio hybrid: play inside worlds made from your own reality (Gaussian splats via World Labs Marble + phone capture), as your own avatar or as **$COAST**, and turn every minute of play into GTA-grade cinematic clips set to $COAST's music — owned on-chain.

- **Spec:** [`goal.md`](./goal.md) (what & why) · **Agent rules:** [`AGENTS.md`](./AGENTS.md) (how)
- **Stack:** three.js 0.180 + Spark 2.1 (Gaussian splats, WebGL2) · WebXR (Quest 3, Vision Pro) · Rapier physics · Vite/TS PWA · Cloudflare Workers + R2 + Durable Objects · OpenAI Realtime (voice director) + GPT-6 Astra (planner) · World Labs Marble · Tripo · fal (MiniMax H3 / Wan VACE) · Decart Lucy (live restyle) · Phantom + Metaplex (Solana)
- **Platforms:** Desktop Chrome/Edge · iPhone Safari (magic window + capture) · Meta Quest 3 · Apple Vision Pro · Android Chrome (bonus)

## Quick start

```bash
pnpm i
pnpm dev            # apps/web on http://localhost:5173
pnpm test           # vitest
pnpm test:e2e       # Playwright + SwiftShader screenshots
pnpm build          # production bundle (Cloudflare Workers static assets)
```

Copy `.env.example` → `.env` for local dev; production secrets live in Cloudflare (`wrangler secret put …`) and in the Codex environment.

## Layout

```
apps/web/           the game/studio client (Vite + TS PWA)
packages/engine/    platform tiers, world (Spark), physics, actors, camera rig, intents
packages/director/  scene-op schema, deixis resolver, Realtime + Astra clients
packages/studio/    takes, shots, passes, WebCodecs export, cut assembly
workers/api/        Cloudflare Worker: auth, ephemeral keys, budgets, jobs, R2/DO/Queues
tools/assets/       headless Blender scripts, vendor job runners, gltf/LoD pipeline
art/                concept art, style guide, UI kit (approved outputs only)
assets/             small runtime assets + manifests (large binaries live in R2)
docs/               ADRs, research, platform matrix, tasks, costs
skills/             vendored SKILL.md files for the coding agent
tests/              unit + e2e
```

## Status

Milestone **M0 — Foundation** (see `docs/tasks.md`). The seed renders a sample Spark splat with tier detection; everything else is spec.
