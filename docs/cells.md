# Cells

One row per Marble world (goal.md W-2 / AD-2). `tools/assets/adapters/marble.ts` updates `source`, `model`, `cost`, `status` and `world id` when a job runs; `splats (full)` and `collider tris` are filled by the LoD/align steps (M2).

| cell         | source         | model      | cost | splats (full) | collider tris | status | world id |
| ------------ | -------------- | ---------- | ---- | ------------- | ------------- | ------ | -------- |
| garage (hub) | key art + text | marble-1.1 |      |               |               | todo   |          |
| pier         | key art + text | marble-1.1 |      |               |               | todo   |          |
| alley        | key art + text | marble-1.1 |      |               |               | todo   |          |
| rooftop      | key art + text | marble-1.1 |      |               |               | todo   |          |
| lookout      | key art + text | marble-1.1 |      |               |               | todo   |          |

## How to generate

Job specs live in `tools/assets/jobs/cell-<id>.json` (`type: "marble"`, schema in `tools/assets/jobs/schema.json`). Each one is a text prompt written to the art brief (goal.md §8); drop approved key art into `inputs.images` (repo-relative paths, ≤4 images → Marble `image` / `multi-image` prompt with azimuths 0/90/180/270) once M1 is signed off.

1. `cp .env.example .env` and set `WORLDLABS_API_KEY` (git-ignored; the runner loads `.env` without overriding your shell). **D-2 (Marble commercial terms) must be answered before the first paid run** (goal.md §9 M2).
2. `pnpm assets list` — shows the five cell jobs and their budgets.
3. `pnpm assets run cell-pier --dry-run` — prints the exact `worlds:generate` request body (no key, no API call) plus the estimated cost, today's spend and the output paths.
4. `pnpm assets run cell-pier` — generates the world (~5 min, ≈$1.28 for `marble-1.1`, ≈$2.48 for `marble-1.1-plus`), then downloads into `tools/assets/out/cells/pier/`:
   `pier.100k.spz`, `pier.500k.spz`, `pier.full.spz` (Marble `spz_urls`), `pier.collider.glb` (the free `collider_mesh_url`), `pier.pano.jpg` (`pano_url`) and writes `cell.json` (SCH-1, `packages/engine/src/world/cell.ts`). The same files are mirrored (hard-linked or copied) into `apps/web/public/cells/pier/` so the dev server serves them at `/cells/pier/…`; only `cell.json` is tracked in git.
   The spend is appended to `docs/costs.md` and this table is updated.
5. Open `pnpm dev` at `/?cell=pier` once the client loads `/cells/<id>/cell.json` (M2 client work).

Guardrails: the adapter refuses to start when the model's unit price exceeds `budgetUsd` or would push today's `docs/costs.md` log over `DAILY_SPEND_CAP_USD` (default $40). Re-running a job **reuses** the world recorded in `cell.json` (re-downloads only what is missing); pass `--force` to pay for a new world, or set `params.worldId` to adopt a world generated elsewhere. An interrupted poll leaves `tools/assets/out/cells/<id>/marble-operation.json` and is resumed on the next run instead of re-generating. `pnpm assets publish cell-pier` (R2 + `assets/manifests/`) is not implemented yet.

`cell.json` written for a cell (relative URLs; `transform` comes from Marble `semantics_metadata`, rotation is a 180° X rotation — rotate, never mirror; spawn/zones/transitions are placeholders to be authored):

```jsonc
{
  "id": "pier",
  "version": "2026-09-06.1",
  "title": "Pier / boardwalk",
  "source": { "kind": "marble", "worldId": "<world id>", "model": "marble-1.1", "promptRef": "text" },
  "assets": {
    "spz100k": "/cells/pier/pier.100k.spz",
    "spz500k": "/cells/pier/pier.500k.spz",
    "spzFull": "/cells/pier/pier.full.spz",
    "collider": "/cells/pier/pier.collider.glb",
    "pano": "/cells/pier/pier.pano.jpg",
  },
  "transform": { "metricScale": 1, "groundOffset": 0, "rotationEuler": [180, 0, 0] },
  "spawns": [{ "id": "default", "pos": [0, 0, 0], "yaw": 0 }],
  "zones": [],
  "transitions": [],
  "lighting": { "preset": "golden", "envmapFromPano": true },
  "alignViews": [{ "id": "v1", "pos": [0, 1.6, 6], "lookAt": [0, 1, 0] } /* v2…v6 every 60° on a 6 m ring */],
  "extra": { "marble": { "worldId": "<world id>", "worldMarbleUrl": "…", "caption": "…", "thumbnailUrl": "…", "job": "cell-pier" } },
}
```
