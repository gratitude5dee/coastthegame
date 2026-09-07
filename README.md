# $COAST the Game

A web-native, cross-reality game/studio hybrid: play inside worlds made from your own reality (Gaussian splats via World Labs Marble + phone capture), as your own avatar or as **$COAST**, and turn every minute of play into GTA-grade cinematic clips set to $COAST's music — owned on-chain.

- **Spec:** [`goal.md`](./goal.md) (what & why) · **Agent rules:** [`AGENTS.md`](./AGENTS.md) (how)
- **Stack:** three.js 0.180 + Spark 2.1 (Gaussian splats, WebGL2) · WebXR (Quest 3, Vision Pro) · Rapier physics · Vite/TS PWA · Cloudflare Workers + R2 + Durable Objects · OpenAI Realtime (voice director) + GPT-6 Astra (planner) · World Labs Marble · Tripo · fal (MiniMax H3 / Wan VACE) · Decart Lucy (live restyle) · Phantom + Metaplex (Solana)
- **Platforms:** Desktop Chrome/Edge · iPhone Safari (magic window + capture) · Meta Quest 3 · Apple Vision Pro · Android Chrome (bonus)

## Quick start

```bash
pnpm i
pnpm dev            # apps/web on http://localhost:5173
pnpm dev:api        # the Worker on http://localhost:8787 (workerd, local R2/DO) — takes, cuts + share links, /perf
pnpm dev:https      # same app over https (self-signed) — WebXR on a Quest / mic on a phone need a secure LAN origin
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

Open `http://localhost:5173/?cam=director` (desktop) or the LAN URL Vite prints (phone). URL params for QA: `?scene=valley|street|sutro|butterfly` (the first three are cells of the **sample strip** — walk out of the valley's far end and the snow street streams in), `?level=strip|run` (`run` = three local butterflies on short roads, the streaming test bed), `?cell=<id>` (Marble cell), `?cam=actor|director|producer`, `?physics=1`, `?lod=0` (skip the LoD build), `?time=golden|blue|night|fog_noon` (start under a grade), `?look=clean|35mm-dusk|vhs-1994|noir|neon-night` (start under a look), `?post=0|1` (the post stack off / on regardless of tier), `?mission=1|2` (auto-brief), `?vehicle=1` (start in the lowrider), `?beat=1` (hydraulics on the beat), `?say=camera low, follow the car` (a direction once the world is up), `?voice=realtime` (the OpenAI voice director, needs the Worker + key), `?perf=1`, `?tier=desktop|phone|quest|fallback`.

| Do                                             | Keyboard / mouse                                                                                                                                                                                 | Touch                   | Gamepad         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | --------------- |
| Move · look · sprint · jump                    | WASD · drag / pointer lock · Shift · Space                                                                                                                                                       | left stick · right drag | sticks · LB · A |
| Actor / director / producer                    | Tab                                                                                                                                                                                              | MODE                    | Y               |
| Grab / drop · throw                            | E · F                                                                                                                                                                                            | GRAB · tap              | X · B           |
| Spray paint (holding a can)                    | click = puff · hold in actor mode = stroke · Z undo                                                                                                                                              | tap                     | trigger         |
| Put that there                                 | click a prop, then click the ground · Z undo                                                                                                                                                     | tap, tap                | — (voice in M5) |
| Talk to the Photographer → mission             | she walks up to you (blue NPC); the extras greet in passing — subtitles at the bottom                                                                                                            | same                    | same            |
| Action / cut a take · replay the set           | Enter · P (every take of the mission performs together) · **Cut → MP4** on the verdict card exports it (with its provenance manifest; the share page shows the credits)                          | ACTION                  | Start           |
| Possess an NPC (play their part next take)     | V near them · V near the body that carries $COAST switches back                                                                                                                                  | BE                      | Back            |
| Direct by saying it                            | hold **`** and speak (Chrome / Safari speech) · or `/` and type: _camera low, follow the car, action_ · _set a key … play the path in 6 seconds_ (a keyframed camera path; it drives the export) | MIC (hold) · SAY        | LT (hold)       |
| The reel (top right)                           | fills bar by bar as missions are earned · click a mission to watch its best take · P stops                                                                                                       | same                    | —               |
| Answer the director's question                 | _yes_ · _no_ · _the left one_ · _the closer one_ (a pending move shows as a ghost)                                                                                                               | same                    | —               |
| Lowrider: get in / out                         | E next to it                                                                                                                                                                                     | GRAB→EXIT               | X               |
| Drive · handbrake · hop                        | WASD · Shift · Space (Shift+Space = all four)                                                                                                                                                    | stick · HOP             | sticks · LB · A |
| Hydraulic switches (hold)                      | I front · K back · J left · L right                                                                                                                                                              | LIFT (front)            | d-pad           |
| Hop on the beat (auto-hydraulics + click)      | H                                                                                                                                                                                                | BEAT                    | RT              |
| Time of day · collider debug · reset           | T (noon → golden → blue, then night / fog noon once the reel unlocks them; or say _golden hour_ / _fog_ / _make it noir_) · C · R · M mute                                                       | —                       | —               |
| **Quest (WebXR)**: walk · snap turn · teleport | left stick · right stick flick · push right stick, release                                                                                                                                       | —                       | —               |
| Quest: jump/hop · grab/car · action · diorama  | A · X · Y · B (select = trigger, throw = right squeeze, brake = left squeeze, beat = left stick press)                                                                                           | —                       | —               |

No headset? `?xrsim=1` on the dev server boots an emulated Quest 3 with an on-screen puppeteering panel (IWER); press ENTER VR.

## Bring your own character (CHR-1 / CAP-1)

**U** or the **Avatar** button opens the optional card. Upload a self-contained GLB, paste a URL, or return to the walking mannequin. Choose whether the source faces −Z or +Z; imports normalize to 1.8 m tall with rest-pose feet on the ground. `?avatar=<encoded-url>&avatarForward=-Z` loads a QA character. Invalid/oversized imports leave the current character intact. The importer supports embedded meshopt geometry but currently rejects Draco, KTX2 and externally referenced textures/buffers with conversion guidance.

Mixamo-named rigs use named idle/walk/run/fall clips when present, otherwise a procedural gait. Unrigged meshes remain rigid figurines. Player, NPC possession and ghosts use independent instances. Takes and cut manifests preserve the chosen avatar name/ID/tint, but not its URL. Check **Save on this device** before importing to retain the exact GLB locally. **Saved avatars → Use saved** restores one; the remembered saved selection returns after reload. Saved-take replay loads its referenced model without changing the current player's selection. **Remove saved** asks for confirmation, removes only that device copy, and leaves takes and currently loaded copies untouched. Full recorded bone tracks, foot IK and CHR-2 crossfades are not implemented yet.

Device storage is opt-in IndexedDB (`coast-avatars`), separate from takes, bounded to eight files / 128 MiB total GLB bytes / 20 MiB per file. Stable IDs hash bytes and normalization options, not filenames or URLs; identical imports deduplicate, while a different forward direction gets a different ID. There is no automatic eviction or cloud backup. Quota/storage failures are reported; the import remains usable for the page when saving fails. Clearing browser/site data can remove saved files. Page-only imports do not change the remembered saved choice; **Use mannequin** clears it. Up to eight distinct imported assets are loaded in memory per page, independently of the disk limit. Reimporting the exact bytes/options can restore a new stable-ID take after device removal; older UUID-based imports from before this checkpoint cannot be recovered automatically.

Generation requires a configured Worker `FAL_KEY`, an explicit consent checkbox and a session-budget reservation. **Meshy v6 text-to-3D** is wired through a durable, idempotent job; use **Check existing job / use result** to poll. Pending inputs/request IDs stay in tab-scoped sessionStorage for reload recovery; checking a job does not submit or charge again. The $1.60 reservation is conservative and remains against the session cap on failures, not a claim of the provider's final invoice. No paid generation was used to verify this implementation.

**Tripo is gated off** pending an approved mapping for the six onboarding clips; its documented presets lack point. **Hunyuan is gated off** because its documented 40k-face minimum exceeds the 30k import budget and requires a reduction step. Upload and URL still work without provider keys or a Worker. See [ADR-0002](docs/adr/0002-characters-glb-mixamo.md) for limits and decisions. No deployment or provider provisioning is performed by importing a character.

## Control reference package (STU-2 / GEN-2)

After cutting a take, choose **Start (s)** and **End (s)** on the verdict card, then **Control package**. The span is at most five seconds. **Download .tar** contains matching `beauty`, `depth` and `pose` MP4/WebM videos, `hero.png` (the first beauty frame), `camera.json`, `prompts.json`, `prompts.txt`, and a SHA-256 file manifest in `package.json`. The files stay local; this does not submit to a video model or upload anything.

The prompt bundle describes the actual recorded subspan, current look/time/cell, avatar identities and sampled camera movement. It includes plain-language Seedance/Veo/Kling/LTX/Wan drafts; each endpoint's accepted reference/control formats must still be verified before submission. The pose pass uses available Mixamo rig joints, omits unsupported/unrigged bodies and missing face landmarks, and keeps a procedural fallback only for legacy actors. Its manifest reports the source counts. This package has no audio or captions; full recorded bone motion remains pending.

Agent/QA entry point:

```js
const result = await window.__coastExportControl({ startS: 0, endS: 1, preview: true });
result.hero;
result.prompts;
result.package.url;
```

Explicit `passes: ['depth', 'pose']` skips the beauty video but keeps the hero still and metadata. Export bounds are 720 short side / 1280 long side, five seconds, and up to 60 fps; smaller frame rates are available through the QA hook. Archive creation requires `crypto.subtle` in a secure context. See [ADR-0012](docs/adr/0012-control-passes.md) for cleanup, timing and remaining fidelity limits.

## Status

Milestone **M3 — actor mode** on sample worlds (see `docs/tasks.md`): Rapier physics with splat-derived ground, the character, props with put-that-there, the **lowrider** (raycast vehicle + hydraulics + beat grid), **NPCs on a runtime navmesh** (Recast/Detour crowd, loiter · approach · greet), **possession and multi-take blocking**, the **director's console** (spoken or typed directions → scene acts, the surface the voice model drives in M5), the camera rig, the **M3.5 vertical slice** (missions → takes → verdict → billboard/download), the **Coast Cut export** (fixed-step 1080p30 MP4 of the whole set via WebCodecs + Mediabunny) and **cell streaming** (W-3: the sample worlds strung into a level by procedural roads — the next cell streams in 15 m before its doorway, never more than two resident, no loading screen; ADR-0009). Marble cells (M2) wire in as soon as a World Labs key lands in `.env`.
