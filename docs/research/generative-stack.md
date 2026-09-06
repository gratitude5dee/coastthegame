# Generative & agent stack — state of play (2026-09-06)

## 1. "Astra" = GPT-6 Astra (OpenAI)
- Announcement (Sept 3, 2026): https://openai.com/index/gpt-6-astra/ — rolling out to limited orgs, then Plus/Pro/Business/Enterprise, API, Azure Foundry, AWS Bedrock.
- Model page: https://developers.openai.com/api/docs/models/gpt-6-astra — ID `gpt-6-astra`; context 1,050,000; max output 128K; **input text+image, output text only**; reasoning effort `low|medium|high|xhigh|max`; Responses, Chat Completions, Realtime endpoints; tools: web search, file search, image gen, code interpreter, hosted shell, apply_patch, skills, computer use, MCP, tool search. $10/M in, $1/M cached, $50/M out; premium above 272K input. Knowledge cutoff Apr 30, 2026. "Fast" mode 2× speed at 2× price.
- Coverage: https://thenewstack.io/openai-gpt6-astra-benchmarks/ (names Blender among apps Astra operates), https://9to5mac.com/2026/09/04/openai-releasing-major-upgrade-to-chatgpt-and-codex-with-gpt-6-astra-details-here/ , https://simonwillison.net/2026/Sep/3/gpt6-astra/ . Changelog (Sept 3): async tool calling, mid-turn steering via WebSockets: https://developers.openai.com/api/docs/changelog
- Codex: v0.153.x adds GPT-6-Astra; "Astra can keep notes across context windows". Plugin marketplace since v0.153.0.
- **OpenAI guides relevant to this build:** "How to build games with Astra" (Sept 4) https://developers.openai.com/blog/how-to-build-games-with-astra — Three.js (TSL, WebGL2+WebGPU), Vite, Rapier physics, Web Workers, **Playwright + SwiftShader headless tests**, image-gen for art direction, Blender for assets, Sites plugin for publishing. "Architectural visualization with Astra" (Sept 4) https://developers.openai.com/blog/architectural-visualization-with-astra — headless `blender --python` + bpy, exporting FBX + JSON scene descriptions.
- The referenced X posts (isidentical / gmi_cloud / OdinLovis, IDs 2095.6–2096.06e12) could not be fetched (X blocks); they fall in the Astra launch window. The @anshuc recipe ("Connect Codex to Blender MCP → paste the concept → imagegen skill → iterate until in-game screenshots match at 60fps, high reasoning") is the workflow `goal.md` §8 formalizes.
- Codex ↔ Blender: no official OpenAI integration. Community MCP bridge **ahujasid/blender-mcp** (`uvx blender-mcp`; Codex `config.toml` `[mcp_servers.blender]`) — guide https://kingy.ai/blog/blender-openai-astra-complete-guide/ ; official Blender Lab MCP v1.0 (see asset-pipeline.md). Both require a running Blender GUI → cloud tasks use headless bpy.
- Codex skills: SKILL.md-based; system skills in `openai/skills` `skills/.system/` — imagegen: https://github.com/openai/skills/blob/main/skills/.system/imagegen/SKILL.md (uses the built-in `image_gen` tool; `scripts/image_gen.py` CLI fallback; outputs under `$CODEX_HOME/generated_images/`).
- **Sign in with ChatGPT**: https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt — grants **name, email, profile picture only**; not conversations/memory/tokens/billing; partner list (Airtable, GitLab, HubSpot, Notion, Supabase, Vercel); no public developer OAuth docs → treat as partner-gated.
- **ChatGPT / Codex Sites**: https://developers.openai.com/codex/sites — `@Sites` plugin hosts websites/web apps/games as Cloudflare-Worker-compatible ES modules; owner/workspace/custom access; storage + DB; public sites can require Sign in with ChatGPT; custom domains (not Enterprise).

## 2. OpenAI Realtime API
- Guide: https://developers.openai.com/api/docs/guides/realtime — **WebRTC** (browser), WebSocket (server), SIP. Browser: server `POST /v1/realtime/client_secrets` → ephemeral secret → client SDP offer to `https://api.openai.com/v1/realtime/calls`, data channel `oai-events`. Function tools + **MCP servers** + connectors.
- Models: `gpt-realtime-2` (May 7, 2026; configurable reasoning, parallel tool calls with spoken preambles, 128K ctx, voices Cedar/Marin); **`gpt-realtime-2.1`** + **`gpt-realtime-2.1-mini`** (July 6, 2026); `gpt-realtime-translate`, `gpt-realtime-whisper`, `gpt-live-transcribe` (July 28). Beta removed May 12, 2026.
- `gpt-realtime-2.1`: https://developers.openai.com/api/docs/models/gpt-realtime-2.1 — input text/audio/**image**, output text/audio, **no video**; 128K ctx; $4/$24 text, $32/$64 audio in/out, $5 image in; function calling yes; structured outputs no. `-mini`: $0.60/$2.40 text, $10/$20 audio, $0.80 image.
- Image input: `conversation.item.create` with `content:[{type:"input_image", image_url:"data:image/png;base64,…"}]` (community-confirmed): https://community.openai.com/t/realtime-model-image-input/1355688 . No API video input: https://community.openai.com/t/when-will-gpt-realtime-2-1-with-live-video-input-be-released-in-the-api/1392430
- Observed cost ≈ $0.05–0.08/min on mini, ~3× on the full model (4,000-session study): https://hackernoon.com/openai-realtime-api-pricing-in-2026-real-world-data-from-4000-measured-sessions . Session cap 60 min (2025 figure; re-verify).

## 3. MiniMax Hailuo H3 family
- Docs: https://platform.minimax.io/docs/guides/video-generation — `POST https://api.minimax.io/v2/video_generation` → task → `GET /v2/query/video_generation/{task_id}`.
- **H3** (API July 31, 2026): 4–15 s, 768P/2K, 24 fps; text, first/last frame, **≤9 reference images, ≤3 reference videos (2–15 s), ≤3 reference audio**; native stereo audio; $0.13/s at 2K. https://huggingface.co/blog/ResterChed/minimax-h3-hailuo-3-0
- **H3 Max** (with fal, Aug 27, 2026): 5–15 s, 480P/768P, T2V + I2V. **H3 Max Turbo**: ~1.5 s for a 5 s clip; $0.025/s 480p, $0.04/s 768p; no reference mode. fal: `minimax/h3/{text,image,reference}-to-video`, `minimax/h3-max/{text,image}-to-video`, `minimax/h3-max-turbo/{text,image}-to-video` — https://fal.ai/minimax-h3-max , https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api . #1 on Artificial Analysis I2V.
- Open weights (Aug 2, 2026): `MiniMaxAI/MiniMax-H3` (33B); community licence excludes EU/UK/KR/**US** territories: https://www.atlascloud.ai/blog/tips/minimax-h3-open-source-weights
- **"Realtime" = faster-than-realtime batch clips, not frame streaming.** fal "Live" chains H3 Max clips: https://www.mindstudio.ai/blog/minimax-h3-max-realtime-ai-video . No parametric camera/depth/pose inputs; motion inherited from reference videos via prompt.

## 4. World Labs
- **Atlas** (Sept 1, 2026) https://www.worldlabs.ai/blog/atlas — omni world model: camera-controlled video up to 1 min at 1440p with camera poses as native input; reconstruction from 1–100+ images → point clouds / 3DGS; depth-map input; **early access with select partners only; no API**.
- **Marble / World API** (Jan 21, 2026) https://www.worldlabs.ai/blog/announcing-the-world-api ; https://docs.worldlabs.ai/api — base `https://api.worldlabs.ai`, header `WLT-Api-Key`; `POST /marble/v1/worlds:generate` (`world_prompt.type` = `text|image|multi-image|video`; multi-image takes `azimuth` per image), `GET /marble/v1/operations/{id}` (~5 min), `GET /marble/v1/worlds/{id}`, `POST /marble/v1/worlds/{id}:export` (`{asset_type:"splats",format:"ply"}` / `{asset_type:"mesh",format:"glb"}`), `POST /marble/v1/media-assets:prepare_upload`. Models `marble-1.1`, `marble-1.1-plus`, legacy `marble-1.0`.
  - Outputs: `assets.splats.spz_urls{100k,500k,full_res}`, `splats.semantics_metadata{metric_scale_factor, ground_plane_offset}` (units arbitrary), **`mesh.collider_mesh_url` (GLB, ~100–200k tris)**, post-export `hq_mesh_url`/`full_res_mesh_url` (~600k textured / ~1M tris), `imagery.pano_url`. FAQ: https://docs.worldlabs.ai/api/faq
  - Pricing: $1 = 1,250 credits; ≈$1.20–1.28/world (1.1), up to ≈$2.48 (1.1-plus), draft ≈$0.12–0.20; HQ mesh export ≈$2.80. App tiers Free/$20/$35/$95 with **commercial rights from Pro ($35)**; API commercial terms not stated → **confirm (D-2)**. https://invideo.io/blog/world-labs-marble-3d-worlds/ , https://radiancefields.com/platforms/world-labs
  - Coordinate gotcha: Unity importer applies −180° Z rotation ("Y flipped, X mirrored"): https://github.com/DakkuaDev/unity-worldlabs.ai-API-client-tool
- **Spark 2.0 is World Labs' renderer** (Apr 14, 2026): https://www.worldlabs.ai/blog/spark-2.0 — MIT, WebGL2 (not WebGPU), Rust→Wasm workers, `.RAD` streaming LoD, 500K–2.5M budgets.

## 5. Tripo, HEAT, Mixamo
- **Tripo** https://developers.tripo3d.ai/en — base `https://openapi.tripo3d.ai/v3`; **H3.1** (`v3.1-20260211`, PBR, ~40 s), **P1** low-poly (~10 s); text/image/multiview-to-3D, texture (standard/HD/8K), segmentation, retopology, rig, retarget, convert; GLB/FBX/OBJ/USDZ. Pricing (1 credit = $0.01): T2M 10–20, I2M 20–30, texture 10–30, retopo 30, **auto-rig 25, retarget 10/animation** https://developers.tripo3d.ai/en/pricing
  - Rig: `POST /animations/rig` https://developers.tripo3d.ai/en/docs/animations-rig — `model` `v1.0-20240301` (biped) / `v2.5-20260210` (quadruped, hexapod, octopod, avian, serpentine, aquatic); **`spec` = `tripo` or `mixamo`**; `out_format` glb|fbx; ~30 s; 150 MB max.
  - Retarget: `POST /animations/retarget` https://developers.tripo3d.ai/en/docs/animations-retarget — 90+ presets (`preset:biped:walk|run|idle|jump|dance_01`, sports…); `bake_animation`, `animate_in_place`, `export_with_geometry`; ~5 s. No custom BVH/FBX upload documented.
- **HEAT (heat.tech)** — animation library/marketplace with DCC plugins; **wound down Dec 2025** (docs domain now serves unrelated content). **Not** Movin (LiDAR mocap hardware). Do not depend on it.
- **Mixamo** — online, free with Adobe ID, ~2,000 FBX clips, no API, no updates since 2015: https://mocaponline.com/blogs/mocap-news/mixamo-alternatives

## 6. fal availability
- Video: `minimax/h3*` (above); `bytedance/seedance-2.5/*`, `alibaba/wan-3.0/*`, `fal-ai/ltx-2.5`; control: `fal-ai/wan-22-vace-fun-a14b/{depth,pose,reframe,inpainting,outpainting}` https://fal.ai/models/fal-ai/wan-22-vace-fun-a14b/depth/api
- 3D: `tripo3d/h3.1/image-to-3d`, `tripo3d/h3.1/text-to-3d`, `tripo3d/p1/image-to-3d`, `tripo3d/triposplat`, `tripo3d/tripo/v2.5/multiview-to-3d`; `meshy/v7/*`, `fal-ai/meshy/rigging/multi-animation`; `hunyuan-3d/v3.1/*`; `trellis-2`; `hyper3d/rodin/v2.5`; `sam-3/3d-objects`. **Tripo rig/retarget and World Labs Marble are NOT on fal** — use their own APIs.
- Realtime (WebSocket) page lists only image/segmentation/lip-sync models: https://fal.ai/realtime . Decart Lucy 2.5 live v2v is available on fal at $0.04/s (see asset-pipeline.md §7).

## 7. "Rough 3D render → video" conditioning (Sept 2026)
| Model | Depth/pose control video | Camera trajectory | Reference video | Reference images | First+last | V2V | Max |
|---|---|---|---|---|---|---|---|
| Wan 2.2 VACE Fun A14B (fal) | **Yes (depth, pose)** | no | via control video | yes | yes | yes | 720p, 81–241 fr |
| LTX-2.3 (open, 22B) | pose IC-LoRA, Union Control | camera LoRAs | yes | – | keyframes | retake | 4K/50fps (self-host) |
| World Labs Atlas | **depth maps** | **native camera poses** | image seq | 1–100+ | – | re-render | 1440p, 60 s (early access) |
| MiniMax H3 / H3 Max | no | prompt only | ≤3 clips | ≤9 | yes | yes (H3) | 2K, 15 s |
| Seedance 2.5 | no | prompt | ≤10 clips | ≤30 | yes | yes | 1080p, 30 s |
| Wan 3.0 | no | no | ≤5 clips | ≤10 | yes | – | 1080p, 30 s |
| Kling 3.0 Motion Control | body motion from video | presets | yes | 1 | – | – | 1080p, 30 s |
| Runway Aleph 2.0 / Gen-4.5 | no | no | Aleph input 2–30 s | ≤5 keyframes | yes | **yes** | 10 s |
| Gemini Omni 1.1 Flash | no | no | ≤3 s ref | yes | yes | yes | 1080p, 40 s |
| Veo 3.1 | no | no | no | ingredients | yes | extension | 8 s |

Recipe: depth+pose passes → Wan 2.2 VACE for strict adherence; beauty clip → Aleph / Omni / H3 V2V for looser photoreal restyle; H3 Max Turbo for <2 s drafts.

## Not verified / likely to change
X post contents; exact Codex skills docs; Realtime 60-min cap & image limits; H3 Max Turbo launch date; World Labs API commercial licence; Tripo rigged output vs Mixamo FBX clips; Gemini Omni pricing; Veo roadmap.
