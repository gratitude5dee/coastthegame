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

## Playing the dev build

Open `http://localhost:5173/?cam=director` (desktop) or the LAN URL Vite prints (phone). URL params for QA: `?scene=valley|street|sutro|butterfly`, `?cell=<id>` (Marble cell), `?cam=actor|director|producer`, `?physics=1`, `?mission=1|2` (auto-brief), `?vehicle=1` (start in the lowrider), `?beat=1` (hydraulics on the beat), `?perf=1`, `?tier=desktop|phone|quest|fallback`.

| Do                                             | Keyboard / mouse                                                                                       | Touch                   | Gamepad         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------- | --------------- |
| Move · look · sprint · jump                    | WASD · drag / pointer lock · Shift · Space                                                             | left stick · right drag | sticks · LB · A |
| Actor / director / producer                    | Tab                                                                                                    | MODE                    | Y               |
| Grab / drop · throw                            | E · F                                                                                                  | GRAB · tap              | X · B           |
| Spray paint (holding a can)                    | click = puff · hold in actor mode = stroke · Z undo                                                    | tap                     | trigger         |
| Put that there                                 | click a prop, then click the ground · Z undo                                                           | tap, tap                | — (voice in M5) |
| Talk to the Photographer → mission             | she walks up to you (blue NPC); the extras greet in passing — subtitles at the bottom                  | same                    | same            |
| Action / cut a take · replay the set           | Enter · P (every take of the mission performs together)                                                | ACTION                  | Start           |
| Possess an NPC (play their part next take)     | V near them · V near the body that carries $COAST switches back                                        | BE                      | Back            |
| Lowrider: get in / out                         | E next to it                                                                                           | GRAB→EXIT               | X               |
| Drive · handbrake · hop                        | WASD · Shift · Space (Shift+Space = all four)                                                          | stick · HOP             | sticks · LB · A |
| Hydraulic switches (hold)                      | I front · K back · J left · L right                                                                    | LIFT (front)            | d-pad           |
| Hop on the beat (auto-hydraulics + click)      | H                                                                                                      | BEAT                    | RT              |
| Time of day · collider debug · reset           | T · C · R · M mute                                                                                     | —                       | —               |
| **Quest (WebXR)**: walk · snap turn · teleport | left stick · right stick flick · push right stick, release                                             | —                       | —               |
| Quest: jump/hop · grab/car · action · diorama  | A · X · Y · B (select = trigger, throw = right squeeze, brake = left squeeze, beat = left stick press) | —                       | —               |

No headset? `?xrsim=1` on the dev server boots an emulated Quest 3 with an on-screen puppeteering panel (IWER); press ENTER VR.

## Status

Milestone **M3 — actor mode** on sample worlds (see `docs/tasks.md`): Rapier physics with splat-derived ground, the character, props with put-that-there, the **lowrider** (raycast vehicle + hydraulics + beat grid), **NPCs on a runtime navmesh** (Recast/Detour crowd, loiter · approach · greet), the camera rig, and the **M3.5 vertical slice** (missions → takes → verdict → billboard/download). Marble cells (M2) wire in as soon as a World Labs key lands in `.env`.
