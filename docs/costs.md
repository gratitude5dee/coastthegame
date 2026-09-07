# Costs ledger

Daily dev cap: **$40** (AGENTS.md §4). Log every vendor spend here (date · job · vendor · units · USD). Pre-approved batches are listed first.

## Reference unit prices (verified 2026-09-06)
| Vendor | Unit | USD |
|---|---|---|
| World Labs Marble 1.1 | world | ≈1.20–1.28 (draft ≈0.12–0.20; 1.1-plus up to ≈2.48; HQ mesh export ≈2.80) |
| Tripo | image→3D + HD texture | ≈0.30–0.50 |
| Tripo | auto-rig / retarget | 0.25 / 0.10 per clip |
| fal MiniMax H3 Max Turbo | second of video (768p) | 0.04 |
| fal MiniMax H3 | second of video (2K) | 0.13 |
| fal Wan 2.2 VACE | 5 s clip | ≈0.10–0.30 |
| Decart Lucy 2.5 | minute live | ≈1.20 direct / 2.40 via fal — **dev testing capped at 2 min/day** |
| OpenAI Realtime 2.1-mini | minute | ≈0.05–0.08 (full model ≈3×) |
| OpenAI gpt-6-astra | 1M in / 1M out tokens | 10 / 50 |
| Google 3D Tiles | 1,000 root tileset requests | 6.00 (1,000 free/mo) |
| ElevenLabs Flash | 1k chars | 0.05 |

## Pre-approved batches
- M2: 5 Marble worlds (hub + 4 cells) × ≤$2.50 = ≤$12.50 (colliders are free — do not buy HQ mesh exports unless a cell fails PHY-5)
- M4: $COAST hero + 7 NPCs + 8 premade avatars via Tripo ≈ 16 × $0.80 = ≤$13

## Log
| date | job | vendor | units | USD |
|---|---|---|---|---|
| 2026-09-07 | CHR-1 / CAP-1 local avatar implementation and mocked generation tests | none | no paid requests | 0 |
| 2026-09-07 | STU-2 / GEN-2 control reference package and local prompt composition | none | no paid requests or uploads | 0 |

Avatar jobs reserve $1.60 for Meshy v6 full text-to-3D before submission (conservative headroom over the referenced $0.80 generation price). This counts against the session cap and remains reserved on failed or unknown outcomes; it is not a metered vendor invoice. Hunyuan's dormant $0.75 estimate is never reserved while that provider is blocked by the 40k/30k geometry mismatch. Tripo remains disabled pending approved clip mapping. The per-session ledger is not a global daily spend gate; live generation/deployment still requires the appropriate provisioning and authorization.
