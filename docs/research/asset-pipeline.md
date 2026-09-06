# Asset pipeline & interaction design research (2026-09-06)

## 1. Blender MCP + headless

- **Official Blender Lab MCP v1.0** (late Apr 2026, with Blender 5.1): natural-language interface to bpy with docs lookup; tools seen: `execute_blender_code`, `get_screenshot_of_window_as_json` ([Blender Lab Q1 report](https://www.blender.org/development/blender-lab-activity-report-q1-2026/), [repo](https://projects.blender.org/lab/blender_mcp)). Anthropic became a Blender corporate patron and ships a Claude Blender connector ([CG Channel](https://www.cgchannel.com/2026/04/ai-developer-anthropic-becomes-blenders-latest-corporate-patron/)).
- **ahujasid/blender-mcp** (MIT, 27k★): scene inspection, object/material ops, `execute_blender_code`, viewport screenshots, Poly Haven / Sketchfab / Poly Pizza / Hyper3D Rodin / Hunyuan3D integrations ([GitHub](https://github.com/ahujasid/blender-mcp)). Verdict in reviews: "excellent operator, poor modeller" — generate hero meshes elsewhere; use MCP for placement/lighting/batch ops.
- Codex CLI: `codex mcp add blender … -- uvx --from 'git+https://projects.blender.org/lab/blender_mcp.git@v1.0.0#subdirectory=mcp' blender-mcp` or `~/.codex/config.toml` `[mcp_servers.blender]` ([note.com](https://note.com/yasudadesu/n/n69b1d1c6d319?hl=en), [Müller](https://jan-hendrik-mueller.de/blog/blender-mcp-config-codex-claude-code-opencode/)). Claude Code: `claude mcp add blender -- uvx blender-mcp`. The add-on listens on TCP 9876 inside a **running Blender GUI** → cloud tasks use headless scripts.
- Blender **5.2 LTS** (July 14, 2026; 5.2.1 Aug 25) ([release](https://www.blender.org/releases/5-2/)). Headless: `blender -b file.blend --python script.py`; containers: [blenderkit/headless-blender](https://github.com/BlenderKit/headless-blender-container), [blender-docker-cli](https://github.com/szabolcsdombi/blender-docker-cli), [blenderless](https://pypi.org/project/blenderless/). Cycles CPU bakes work headless; EEVEE/Workbench need a GPU/EGL context.
- Recipe agent → GLB → three.js: bpy build/import → Cycles bake (`scene.cycles.bake_type='COMBINED'` → `bpy.ops.object.bake`) → `export_scene.gltf(GLB, export_apply=True, draco for static)` → `gltf-transform optimize --compress meshopt --texture-compress ktx2` (or `gltfpack -cc -tc`) → `GLTFLoader` + `MeshoptDecoder` + `KTX2Loader.detectSupport(renderer)` ([gltf-transform](https://gltf-transform.dev/), [meshoptimizer](https://meshoptimizer.org/gltf/)).

## 2. Photo → rigged avatar

- **Ready Player Me shut down Jan 31, 2026** (Netflix acquisition); Union Avatars offline July 2026 ([Avatar SDK status](https://avatarsdk.com/blog/2026/08/31/avatar-platforms-2026-whos-alive-whos-gone/)).
- **Tripo**: image-to-3D H3.1 ~40 s untextured / ~120 s PBR (20–40 credits); Auto-Rig v2.0 with **tripo/mixamo bone naming**, GLB/FBX, ~30 s, 25 credits; retarget 10 credits/animation ([rig](https://developers.tripo3d.ai/en/models/rig)). Selfie → rigged GLB ≈ $0.60–0.80, ~3 min. Yields a likeness, not a face scan.
- **Meshy** (Meshy-7): image-to-3D 20 credits, rigging 5 credits (~17 s, humanoid, GLB/FBX with walk/run), 600+ motion library ([API](https://www.meshy.ai/api), [rigging](https://docs.meshy.ai/en/api/rigging-and-animation)); on fal.
- **Hunyuan3D** 2.x open weights + [UniRig](https://github.com/VAST-AI-Research/UniRig) (self-host). **Rodin Gen-2.5** (June 2026) fast modes, API. True likeness services: **Avaturn** ($800/mo, Mixamo-compatible) ([pricing](https://avaturn.me/pricing/)), Avatar SDK MetaPerson, Reallusion Headshot 3 + CC5 (desktop). Stylized: VRoid (VRM).
- **VRM / three-vrm** `@pixiv/three-vrm` v3.5.x (three ≥ r176) + `three-vrm-animation` — normalized humanoid bone map ([releases](https://github.com/pixiv/three-vrm/releases)).
- Mixamo: online, free, FBX/DAE, unmaintained, outages in 2025 ([Cinevva](https://app.cinevva.com/guides/free-character-animations-rigging)).

## 3. Motion

- Dead: HEAT (Dec 2025), RADiCAL (acquired by Autodesk Apr 2026; portal closed July 2026), Wonder Studio → Autodesk Flow Studio.
- Presets: Tripo retarget (rig v2.5): `preset:idle/walk/run/jump/dive/climb/slash/shoot/hurt/fall/turn`; v1.0 biped 90+ incl. dances; bake multiple presets into one GLB ([retarget docs](https://developers.tripo3d.ai/en/docs/animations-retarget)). Meshy 600+ motions. Free CC0: Quaternius UAL, Kenney; Cinevva auto-rigger + 260 clips.
- Video→mocap: DeepMotion ($15/mo, API), QuickMagic ($9.99/mo), Plask, Move AI, Rokoko Vision (free), Meshcapade; Kinetix video→emote API $0.10/emote ([Tato comparison](https://tato.studio/blog/best-ai-video-to-mocap)).
- Text→motion: Tencent HY-Motion 1.0 (open, SMPL, ≤5 s), DeepMotion SayMotion (API), Uthana (API).
- Simplest path (goal.md CHR-2): Tripo rig (mixamo) → Tripo presets → Mixamo FBX (hip-hop/talk gestures) converted headlessly (`tools/assets/blender/fbx_to_glb.py`) → rap performance via phone video → QuickMagic/DeepMotion → retarget → one GLB with named clips → `AnimationMixer` crossfades.

## 4. NPCs, dialogue, TTS

- Field guide: tight persona prompts, capped replies, action whitelist, generate "texture" not plot; players notice >~800 ms gaps; cache everything ([Cinevva](https://app.cinevva.com/guides/ai-npcs-dialogue)). Platforms: Convai (web SDK), Inworld (TTS $5–25/M chars), NVIDIA ACE. Architecture paper: [arXiv 2504.13928](https://arxiv.org/html/2504.13928v1).
- Design (goal.md AUD-1): build-time dialogue graphs per NPC + cached TTS; live LLM only for free-text, cache keyed on `(npc, normalized_intent, world_state_hash)`; WebLLM fallback.
- TTS/voice: GPT-Realtime-2.x ($32/$64 audio in/out; mini ≈ $0.05–0.08/min), ElevenLabs Flash (~75 ms, $0.05/1k chars), Hume EVI 3 (~300 ms, BYO-LLM) ([Hume](https://www.hume.ai/blog/announcing-evi-3-api)).

## 5. "Put That There" → voice + deixis

- Bolt 1980: verb + object + location; "there" samples cursor coordinates at utterance time; "that" via simultaneous pointing ([PDF](https://www.media.mit.edu/speech/papers/1980/bolt_SIGGRAPH80_put-that-there.pdf)).
- 2025–26: "Revisiting put-that-there" — LLM fuses segmented 3D scene + verbal + pointing + gaze into JSON placement actions ([arXiv 2511.02378](https://arxiv.org/abs/2511.02378v1)); reference-based manipulation framework ([arXiv 2608.04798](https://arxiv.org/html/2608.04798)); VR coreference study: **pointing precision 0.95 vs gaze 0.72** → weight pointing over gaze ([arXiv 2509.08689](https://arxiv.org/html/2509.08689v1)); CHI 2026 gaze+speech review ([ACM](https://dl.acm.org/doi/10.1145/3772318.3791662)); visionOS 27 LLM Siri via eye contact + speech. Engine agents: Unity MCP (open beta May 2026), Blender MCP, Unreal MCP servers.
- Resolution rules and the query/act tool schema are implemented in `packages/director/src/{deixis,schema}.ts` (goal.md DIR-2/3).

## 6. Virtual production in the browser

- Camera paths: Theatre.js ([docs](https://www.theatrejs.com/docs/0.5/getting-started/with-three-js)) or `CatmullRomCurve3`; render with fixed `dt = 1/fps`.
- Export: [canvas-record](https://github.com/dmnsgn/canvas-record) (WebCodecs), [Mediabunny](https://mediabunny.dev/) (TS WebCodecs muxer, MPL-2.0) — both beat `MediaRecorder`; live via `canvas.captureStream(fps)` → WebRTC.
- Passes: depth (`MeshDepthMaterial` / depth texture), normals (`MeshNormalMaterial` override), ID (flat colours), 2D skeleton (projected joints) — mirrors the Blender previs recipe ([Flick guide](https://flick.art/blog/blender-ai-filmmaking)).
- Models accepting passes: Wan 2.1/2.2 VACE (depth/pose/flow/scribble) ([fal](https://fal.ai/models/fal-ai/wan-vace)); LTX-2.3 Union Control + camera LoRAs + motion tracks ([LTX](https://ltx.io/model/capabilities/video-motion-control)); Kling 3.0 Motion Control (reference video, 6 camera moves, no numeric API); MiniMax H3 (≤3 reference clips inherit motion/camera). Faithfulness: depth + pose + beauty reference > Canny > text camera vocab > motion reference alone.
- 3D-native: Marble exports SPZ/PLY + GLB; Atlas (partner early access) takes 1–6 refs + explicit camera path → 1440p 1-min video + splats.

## 7. Real-time video (story-mode "Dream")

- **Decart Lucy 2.5** (July 15, 2026): live v2v 720p 30 fps <40 ms/frame; WebRTC (LiveKit) SDKs JS/Python/Swift/Android; `setPrompt()` live; $0.02/s direct, $0.04/s on fal ([CreativeAI](https://www.creativeainews.com/blog/decart-lucy-2-5-realtime-ai-video-editing-2026/), [SDK](https://github.com/DecartAI/sdk), [fal](https://fal.ai/learn/tools/real-time-video-editing-with-ai)). Feed `renderer.domElement.captureStream(fps)` as the MediaStream ([best practices](https://docs.platform.decart.ai/models/realtime/streaming-best-practices)). Oasis 2.0 = Decart's playable world model.
- Open/self-host: StreamDiffusionV2 (58 fps on 4×H100, 20+ fps on a 4090) ([arXiv](https://arxiv.org/abs/2511.07399)); Krea Realtime 14B (CC-BY-NC) ([GitHub](https://github.com/krea-ai/realtime-video)); **Daydream Scope** runs StreamDiffusionV2/LongLive/Krea/MemFlow with VACE depth/pose control in real time (17–22 fps on RTX 5090) ([paper](https://arxiv.org/html/2602.14381v1), [Scope](https://huggingface.co/daydreamlive/scope)).
- Not streaming: MiniMax H3 / H3 Max (5 s clip in ~2.5 s, async), LTX-2.5 Fast (batch), Runway Characters ($0.20/min conversational).
- Feeding a game render: 640×360–720p beauty via captureStream → Lucy; self-hosted: beauty + depth (+pose) into Scope/VACE; stable style prompt, debounce 300 ms; ~1 GPU per viewer.

## Recommended decisions (adopted in goal.md)

Official Blender MCP for desktop, headless bpy in cloud; headless containers for batch; gltf-transform meshopt+KTX2 (no Draco on skinned); Tripo H3.1 for hero meshes (Meshy fallback, Hunyuan3D self-host); Tripo selfie→rig (Avaturn/Meshy fallback, VRM for stylized); Mixamo bone names; Tripo presets + Mixamo FBX (Meshy fallback); rap via video→mocap (SayMotion/HY-Motion fallback); NPC graphs + cached TTS (Realtime mini live path; Hume/WebLLM fallback); voice editing via function-calling + client-side deixis; fixed-step recording + WebCodecs; Wan-VACE / LTX offline, Lucy live, Scope self-host, Atlas later.

## Open risks

Vendor mortality; official Blender MCP is v1.0 and GUI-bound; rig compatibility drift (validate bone count/rest pose/scale/root motion in CI); likeness vs game-readiness; 7× LLM/TTS cost variance; deixis accuracy without pointer rays; real-time restyle economics (~$72/h/viewer); camera-control APIs are prose; three.js/WebGPU churn.
