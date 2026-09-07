# ADR-0009 — Cell streaming (W-3) on the sample worlds: placements, portals, procedural transitions

**Status:** accepted (2026-09-07) · **Owner:** GRATITUD3 · **Refs:** goal.md W-2, W-3, SCH-1, SCH-2, PHY-1, UX-3

## Context

W-3 wants the level as a graph of cells joined by transitions, ≤2 cells resident, the next cell streaming from 15 m before a transition and the far cell unloading on arrival — "walk from Garage → Pier → Alley without a loading screen". The Marble cells (M2) wait on the World Labs key and D-2, but the streaming logic, the physics seams and the loading choreography can be built and tested on the Spark sample worlds today, and should not need rewriting when the real cells land.

## Decision

- **One world frame, one physics world.** `level.json` (SCH-2) gains `placements`: a world origin per cell. Cells are placed, not teleported between: poses in takes, the camera rig, ghosts and the export all stay in world space, and the lowrider drives across a seam like across any road.
- **Portals are the schema's** (SCH-1 `transitions[]`: a portal AABB in cell space + `streamAt_m`), authored on **both** cells of every edge; the level builder rejects one-sided edges. `packages/engine/src/world/level.ts` holds the pure logic: the graph, XZ distance to a portal, and `CellStreamer.update(playerPos)` → `load` / `unload` / `arrive` events. Load when within `streamAt_m` of an exit portal of the active cell; keep ≤ `residentCells` (2: the active cell + one) by evicting the resident cell farthest from the player; **arrive** when the player enters the neighbour's return portal. Nothing loads or unloads on a timer; the streamer is deterministic in the player's path and unit-tested.
- **Transitions are procedural street segments** until the kitbash GLBs exist: an asphalt strip with curbs from exit portal to entry portal (tilted to bridge the height difference), fog sprites hiding the seam, a **road cut** through whatever the cells' ground grids have in the way (the grid is lowered to the road along the footprint; the splats above the road dissolve in an SDF box — W-4 "holes"), and a **gate** across either end while the cell there has no ground in the physics world. Doorway heights are authored approximately and snapped to the derived ground when it lands (the road is rebuilt then). The fence around a sample cell (PHY-1) opens where a road crosses it, and a cell's ground collider stops at the scan's coverage so no hole-filled phantom floor reaches into the next cell.
- **Ground per cell:** each resident sample cell derives its own ground grid + fence from its splats (or its collider GLB when it has one), added to the shared physics world when its splat finishes loading and removed on unload; height queries search the resident grids (active cell first). Physics never rebuilds on arrival; only the "active" pointer moves (spawn, HUD, perf cell, respawn).
- **What stays in the hub** for now: props, NPCs, the billboard and the missions live in the cell that was active at boot. Per-cell content (spawns, zones, NPCs) follows `cell.json` in M2.
- **Two levels ship in code** (`apps/web/src/world/levels.ts`): `strip` — valley ↔ street ↔ sutro over the network (the snow street re-centred on its own scan: the seed had it 90 m from the origin), the default when `?scene=valley|street|sutro`; `run` — three copies of the local butterfly sample, for the e2e harness and offline QA. `?level=` overrides; `?scene=` picks the active cell.

## Consequences

- - The Marble cells replace the cell definitions, not the code: `cell.json` already carries origin-free portals; the placement is the only new field.
- - Streaming is testable headless on local data (`tests/e2e`), and the streamer's decisions are unit-tested without a renderer.
- − A sample cell's ground is derived on the main thread when its splat lands (tens of ms): a hitch, not a loading screen — the collider GLBs of real cells make it a background load.
- − Procedural transitions look like what they are; the kitbash + fog-volume pass (M2) replaces the visuals, keeping the colliders.
- − Content does not stream with the cell yet (props, NPCs stay in the hub); missions in other cells wait for per-cell content.
