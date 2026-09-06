# Vendored skills for the coding agent

Copied from GRATITUD3's skill library on 2026-09-06 so Codex can read them in-repo (Codex discovers `SKILL.md` files; Claude Code reads them via `skills/`). Read the relevant `SKILL.md` before touching that domain:

| Skill | Use it for |
|---|---|
| fal-generate, fal-models-catalog, fal-prompting | choosing/calling fal endpoints (MiniMax H3*, Wan VACE, Tripo/Meshy on fal) |
| fal-3d | image/text → 3D via fal (Tripo/Meshy/Hunyuan3D) — Tripo rig/retarget use Tripo's own API |
| fal-video-edit | upscales, background removal, audio for generated clips |
| ltx2, seedance-2-0 | alternative video models (fallbacks in goal.md §7.8) |
| ffmpeg, ffmpeg-agent-actions | Cut assembly, loudness, VMAF QC, ABR ladders (PROBE→DECIDE→EXECUTE→VERIFY) |
| threejs-* | fundamentals, loaders (GLTF/KTX2/meshopt), post-processing, interaction, animation, lighting |
| cinematography | shot language for prompts and the director grammar |
| elevenlabs, sound-effects | NPC TTS, SFX generation |
| playwright-recording | the screenshot/GIF harness |
| solana-skill | Phantom/Metaplex minting (ADR-0004) |
| writing-for-agents, to-spec, to-tickets | writing ADRs, task breakdowns, PR descriptions |

Do not edit these copies; propose changes upstream in the skill library.
