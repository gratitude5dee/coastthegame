---
name: ffmpeg-agent-actions
description: >
  Generate FFmpeg and ffprobe commands for audio/video engineering with
  broadcast-grade discipline (PROBE -> DECIDE -> EXECUTE -> VERIFY). USE when
  the user mentions FFmpeg, ffprobe, afir, convolution reverb, impulse response,
  IR, EBU R128, LUFS, loudnorm, true peak, VMAF, SSIM, PSNR, spectrogram,
  waveform, filter_complex, lavfi, silencedetect, scenedetect, blackdetect,
  chromakey, HDR tonemap, LUT, codec ladder, HLS, DASH, RTMP, SRT, NVENC,
  VideoToolbox, QSV, or VAAPI. ALSO use when the task is described without
  naming FFmpeg: "normalize for Spotify/Apple/YouTube", "make it 9:16 for
  Reels/TikTok", "cut a clip", "extract frames for vision AI", "green screen",
  "downscale", "compress for web", "burn subtitles", "remove silence", "check
  broadcast compliance", "compare encode quality", "batch process a folder",
  "apply room reverb", "build HLS stream". Always prefer this skill over
  writing FFmpeg from memory; it ships platform delivery specs, safe defaults,
  and executable scripts.
---

# FFmpeg Agent Actions

A complete cognitive architecture for agentic FFmpeg workflows: decision scaffolding, platform specs, executable scripts, and deep references.

---

## MENTAL MODEL — Always Think in This Order

Before generating any FFmpeg command, walk these four phases:

1. **PROBE** — Never assume what's in a file. Run `scripts/probe.sh INPUT` or `ffprobe -v quiet -print_format json -show_format -show_streams INPUT` first. Codec, sample rate, channel layout, pixel format, duration, and frame rate all change what commands are valid.
2. **DECIDE** — Match the task to a domain (see routing table below) and pick the heuristic (codec, bitrate, filter chain). Prefer stream copy (`-c copy`) over re-encode whenever possible; it's faster and lossless.
3. **EXECUTE** — Build the command from the reference file's verified patterns. Never invent filter names or parameter keys from memory — load the reference.
4. **VERIFY** — After execution, probe the output. Confirm duration matches, codec is correct, loudness target hit, no silent truncation. For quality-critical work, run VMAF or SSIM against the source.

Skipping PROBE is the #1 cause of wrong-codec, wrong-aspect, and wrong-sample-rate bugs. Skipping VERIFY is how silent corruption ships to production.

---

## ROUTING TABLE — Which Reference to Load

Match the user's task to one of these before generating commands. For multi-domain tasks, load more than one reference.

| User Intent / Keywords | Load Reference |
|---|---|
| afir, convolution reverb, impulse response, IR, cabinet sim, room sim, sofalizer, afirdn | `references/audio-ir-convolution.md` |
| LUFS, EBU R128, loudnorm, true peak, waveform image, spectrogram, silence detection, astats | `references/audio-analysis.md` |
| EQ, compressor, limiter, gate, denoise, pitch shift, time stretch, chorus, flanger, phaser, mastering chain | `references/audio-processing.md` |
| VMAF, SSIM, PSNR, blackdetect, freezedetect, scenedetect, QC report, frame extraction, HDR metadata | `references/video-analysis.md` |
| scale, crop, pad, 9:16, letterbox, deinterlace, stabilize, overlay, drawtext, subtitles, LUT, color grade, HDR→SDR | `references/video-processing.md` |
| H.264, H.265, HEVC, AV1, VP9, ProRes, DNxHR, CRF, bitrate, preset, codec ladder, 2-pass | `references/transcoding.md` |
| NVENC, VideoToolbox, QSV, VAAPI, AMF, hardware encode, GPU acceleration | `references/hardware-acceleration.md` |
| glitch, datamosh, Ken Burns, crossfade, xfade, green screen, chromakey, split screen, vignette, film grain | `references/creative-effects.md` |
| RTMP, HLS, DASH, SRT, live stream, low latency, segment, concat, rebroadcast, WHIP | `references/streaming.md` |
| SRT file, WebVTT, ASS, burn-in subtitles, soft subtitles, closed captions, CEA-608, CEA-708 | `references/subtitles-captions.md` |
| metadata, ID3, chapter markers, cover art, tags, MediaInfo, broadcast wrapper | `references/metadata-tagging.md` |
| batch, folder, parallel, watch, queue, pipeline, AI vision prep, stem prep, progress tracking | `references/batch-automation.md` |
| error, failed, won't encode, codec not found, filter not found, sync drift, corrupt, weird output | `references/troubleshooting.md` |

---

## EXECUTABLE SCRIPTS — `scripts/` Folder

These are production-grade, parameterized, error-handled scripts. Call them instead of rebuilding inline. All scripts use `set -euo pipefail` and exit non-zero on failure.

| Script | Purpose | Usage |
|---|---|---|
| `scripts/probe.sh` | Universal inspection — JSON + human-readable summary | `probe.sh INPUT` |
| `scripts/hwenc-detect.sh` | Detect available GPU encoders on this machine | `hwenc-detect.sh` |
| `scripts/loudnorm.sh` | Broadcast-quality two-pass LUFS normalization | `loudnorm.sh INPUT OUTPUT [target_lufs=-14]` |
| `scripts/ir-apply.sh` | Convolution reverb with SR match + safety checks | `ir-apply.sh DRY IR OUT [wet=7] [dry=10]` |
| `scripts/vmaf.sh` | Perceptual quality score (reference vs encoded) | `vmaf.sh REFERENCE ENCODED` |
| `scripts/abr-ladder.sh` | HLS multi-bitrate ladder generation | `abr-ladder.sh INPUT OUTPUT_DIR` |
| `scripts/qc-report.sh` | Compliance report: codec, loudness, black, silence | `qc-report.sh INPUT > report.txt` |
| `scripts/frames-for-ai.sh` | Frame extraction with burned timestamp for vision pipelines | `frames-for-ai.sh INPUT FPS OUTDIR` |

If the user is on a Windows system or can't run bash, translate the script body into a direct `ffmpeg` one-liner — the script is also a worked example.

---

## 30-YEAR HEURISTICS — Codec & Delivery Decisions

When the user asks for "the right codec" or "good bitrate", apply these rules of thumb rather than blind recipes.

### Codec Selection (by purpose)

| Goal | First choice | Why |
|---|---|---|
| Maximum compatibility (any browser, any phone) | H.264 `libx264`, yuv420p, baseline/main | Decodes everywhere including 10-year-old devices |
| Best quality per byte, modern devices | H.265 `libx265` | ~40–50% smaller than H.264 at same quality; iOS/Android/Safari native |
| Best quality per byte, patent-free, future-proof | AV1 `libsvtav1` (not `libaom-av1` for production) | ~30% smaller than HEVC; SVT-AV1 is 10–50× faster than aom |
| Editing / intermediate codec | ProRes 422 (`prores_ks -profile:v 2`) or DNxHR HQ | Fast to decode on NLEs; visually lossless at modest file sizes |
| Archive / master | H.264 CRF 18 in MKV, or FFV1 lossless | CRF 18 is visually lossless to most eyes; FFV1 for regulatory archives |
| Animation / flat color content | AV1 or VP9 at higher CRF | Block artifacts on gradients; AV1's film grain synthesis helps |

### Quality Targets (by CRF)

- **H.264**: CRF 18 = visually lossless. CRF 23 = default, good for web. CRF 28 = compressed, acceptable.
- **H.265**: Add ~5 to the H.264 CRF for equivalent quality. CRF 23 (H.264) ≈ CRF 28 (H.265).
- **AV1 (SVT-AV1)**: Add ~5–7 to the H.265 CRF. CRF 30–35 is typical for streaming.

### Bitrate Targeting (when CBR is required for streaming)

| Resolution | H.264 (kbps) | H.265 (kbps) | AV1 (kbps) |
|---|---|---|---|
| 360p (640×360) | 400–700 | 250–450 | 200–350 |
| 480p (854×480) | 800–1400 | 500–900 | 400–700 |
| 720p (1280×720) | 2000–3500 | 1200–2200 | 900–1700 |
| 1080p (1920×1080) | 4000–6500 | 2500–4500 | 1800–3500 |
| 1440p | 8000–12000 | 5000–8000 | 3500–6000 |
| 4K (3840×2160) | 16000–25000 | 10000–16000 | 7000–12000 |

### When to Copy vs Re-Encode

- **Rewrap only** (`-c copy`) when: changing container, trimming on keyframes, extracting streams, remuxing HLS → MP4.
- **Re-encode** when: changing resolution, frame rate, codec, pixel format, or applying any filter. Re-encoding is lossy — avoid repeated re-encodes on the same file.

---

## UNIVERSAL COMMAND SKELETON

Every non-trivial FFmpeg invocation follows this structure. Learn the pattern and the recipes become composable.

```
ffmpeg \
  [GLOBAL OPTIONS: -y / -n / -hide_banner / -loglevel / -stats] \
  [HWACCEL: -hwaccel cuda -hwaccel_output_format cuda] \
  [INPUTS: -i IN1 -i IN2 ...] \
  [FILTER GRAPH: -filter_complex "..." OR -vf "..." / -af "..."] \
  [MAPPING: -map 0:v -map 1:a ...] \
  [STREAM ENCODE: -c:v ENCODER -c:a ENCODER + params] \
  [CONTAINER: -movflags +faststart / -f hls / -f dash] \
  [OUTPUT]
```

### Rules that prevent 90% of bugs

1. **Always put `-ss` BEFORE `-i` for fast seek** (keyframe-accurate). Put `-ss` AFTER `-i` only for frame-accurate but slow seek.
2. **Always add `-map` when using `-filter_complex`** — default stream selection fails silently on complex graphs.
3. **Always add `-pix_fmt yuv420p` for web/mobile delivery** — 4:2:2 and 4:4:4 won't play in browsers or on iPhones.
4. **Always add `-movflags +faststart` to MP4 outputs for streaming** — moves the moov atom to the start so playback begins before full download.
5. **Never use `-y` in production scripts** — silent overwrite of wrong file is catastrophic. Use `-n` to skip or check with `[ -f output ]` first.
6. **Loglevel discipline**: `-loglevel error` for scripts, `-loglevel warning` for dev, default for debugging.
7. **For precise cuts, put `-to` after `-i`** — `-t` is duration, `-to` is end timestamp.
8. **Escape commas inside filter params** with `\,` or switch to full quote + `:` separator.

---

## PLATFORM DELIVERY SPECS — Ready-to-Ship

Load `assets/cheatsheet.md` for the full reference. The hottest targets:

| Platform | Video | Audio | Resolution | Notes |
|---|---|---|---|---|
| **Spotify** | n/a | AAC/Ogg Vorbis | n/a | **-14 LUFS**, -1 dBTP, loudnorm required |
| **Apple Music** | n/a | AAC 256k | n/a | **-16 LUFS**, -1 dBTP (Sound Check) |
| **YouTube** | H.264 High / AV1 | AAC 384k stereo | 1920×1080 @ 24/30/60 | **-14 LUFS**, 2-pass recommended |
| **YouTube Shorts** | H.264 | AAC 192k | 1080×1920 @ 30/60 | 9:16 vertical, ≤60s |
| **Instagram Reels** | H.264 Main | AAC 128k | 1080×1920 @ 30 | 9:16, max 90s, ≤4 GB |
| **Instagram Feed** | H.264 | AAC 128k | 1080×1350 (4:5) | Max 60s |
| **TikTok** | H.264 | AAC 128k | 1080×1920 @ 30 | 9:16, max 10min, MP4/MOV |
| **X / Twitter** | H.264 High | AAC LC | 1920×1080 @ 30/60 | Max 2:20, ≤512 MB |
| **Broadcast EBU R128** | Per spec | AAC/AC3/PCM | 1920×1080i29.97 | **-23 LUFS**, -1 dBTP, LRA ≤18 |
| **Netflix (dialog)** | HEVC Main10 | AC-3 / EAC-3 / DDP | 3840×2160 HDR10 | **-27 LUFS** dialog, IMF preferred |

---

## AGENTIC PIPELINE PATTERNS

These are the high-value composite workflows. Each chains probe → decide → execute → verify.

### Pattern A — "Normalize for <platform>"
```
probe audio → measure LUFS → compute delta from target → two-pass loudnorm → verify output LUFS
```
Use `scripts/loudnorm.sh INPUT OUTPUT -14` (change target by platform).

### Pattern B — "Make this ready for Reels/TikTok/Shorts"
```
probe video → confirm aspect → if landscape: blur-bg-fill to 9:16 → normalize audio to -14 LUFS
  → encode H.264 yuv420p CRF 23 + faststart → verify duration ≤ platform cap
```

### Pattern C — "Quality-check this encode"
```
probe both reference + encoded → VMAF + SSIM + PSNR → if VMAF < 85: re-encode at lower CRF
```
Use `scripts/vmaf.sh REF ENC`.

### Pattern D — "Prep for AI vision pipeline"
```
probe video → extract 1 fps frames with burned timestamp → scale to ≤1280 width for token efficiency
  → output manifest.json mapping filename → seconds
```
Use `scripts/frames-for-ai.sh INPUT 1 frames/`.

### Pattern E — "Apply room IR to dialog"
```
probe dialog → probe IR → if sample rates differ: resample IR → afir with tukey gain norm
  → apply mild limiter → normalize to -16 LUFS for podcast
```
Use `scripts/ir-apply.sh DRY IR OUT`.

### Pattern F — "Generate streaming ladder"
```
probe source → verify ≥1080p → split to 4 rungs (1080/720/480/360) → encode each with aligned keyframes
  → write master.m3u8 → verify each rung plays
```
Use `scripts/abr-ladder.sh INPUT hls/`.

---

## ANTI-PATTERNS — Do NOT Do These

Common mistakes that look right but aren't. Each has bitten engineers for decades.

1. **Re-encoding when `-c copy` would work** — lossy, slow, wasteful.
2. **Using `-filter:v` AND `-vf`** on the same stream — they conflict; pick one.
3. **Mixing `-filter_complex` output without `-map`** — FFmpeg will often pick the wrong stream and you won't notice until someone complains.
4. **Running `-i` twice without realizing streams are numbered** — `-map 0:a` vs `-map 1:a` matter even when both inputs are the same file.
5. **Using `atempo` outside 0.5–2.0 range without chaining** — fails silently or errors. Chain: `atempo=2.0,atempo=1.5` for 3×.
6. **Normalizing loudness in one pass** — measurement-based (`loudnorm`) one-pass is approximate. For broadcast compliance, always two-pass.
7. **Resampling IR on-the-fly inside `afir`** — `afir` doesn't resample. If sample rates differ, you'll get wrong pitch or a crash. Pre-resample the IR.
8. **Hardware encode for archival** — NVENC/VideoToolbox are fast but 5–15% lower quality than `libx264 -preset slow` at the same bitrate. Use HW for dailies/previews/live, CPU for deliverables.
9. **Forgetting `-pix_fmt yuv420p`** on a ProRes → MP4 conversion — ProRes is typically 4:2:2, which breaks browser playback.
10. **Using VBR audio for broadcast** — broadcast requires constant bitrate PCM or AC3. VBR AAC will fail automated QC.
11. **Trusting the first `-ss` on a badly-indexed file** — some MKV/TS files seek inaccurately. Verify with a probe of the cut output.
12. **Using `-c:v copy` after a filter** — filters imply re-encode. `-c:v copy` will silently disable the filter.

---

## WHAT TO LOAD WHEN

- **Always start** with this SKILL.md and the routing table above.
- **Load one or more references** from the table based on the task.
- **Run a script** from `scripts/` for the 8 most common high-stakes workflows.
- **Load `assets/cheatsheet.md`** when the user wants a printable reference or asks for specs for a specific platform not in the table above.
- **Load `references/troubleshooting.md`** whenever the user reports an error, unexpected output, or "doesn't work".

Keep this SKILL.md in context at all times; load reference files on-demand.
