# ADR-0011 — Content follows the cell: props, NPCs and the car are cell data, spawned with the ground and gone with the splats

**Status:** accepted (2026-09-07) · **Owner:** GRATITUD3 · **Refs:** goal.md W-3, SCH-1, PHY-2/3/4, W-5, ADR-0009

## Context

ADR-0009 streamed the sample worlds as cells but left everything that lives in them — the props to throw, the lowrider, the Photographer and the extras, the billboard — in the cell that was active at boot: walk to the next cell and it is empty; walk back and the hub's people are still standing in a cell that is no longer resident. `cell.json` (SCH-1) authors spawns, zones and transitions but nothing about what a cell _contains_, and the NPC navmesh was baked once from the boot cell's ground.

## Decision

- **`content` is a block of SCH-1** (`Cell.content`, and `SceneDef.content` for the sample worlds): `props[]` (shape, size, colour, mass, tags, a position in the cell's frame with `y` metres above the derived ground), `npcs[]` (name, colour, lines, whether they approach, a position the same way) and an optional `vehicle` (position, yaw). Ids are authored and must be unique across the level (a unit test checks the shipped levels); `PropSystem.nextId` skips them for anything the director spawns later.
- **The hub kit.** A level's hub with no `content` puts down what the hub always had — two crates, two spray cans, a ball, the lowrider, the Photographer, Rico, Mari and Dee — as a spawn-relative kit (`hubKit(spawn)` in `apps/web/src/world/levels.ts`), laid out for the −Z-looking camera every sample world boots with. Every other cell without content is empty. The missions (`mission.cell`) keep pointing at the hub.
- **Spawned with the ground, taken out with the splats.** A cell's content is spawned the moment its ground is in the physics world (the boot cell inside `initPhysics`, a streamed neighbour when its derived ground lands) and removed when the cell unloads — except what the player is holding or driving, which follows the player into the next cell and is re-homed there. Coming back reloads the cell and its content afresh (a fresh brain for each NPC; props at their authored spots — a thrown crate does not remember where it landed across an unload, and neither does a take: takes replay props kinematically from their own tracks).
- **One crowd, one navmesh across the resident set.** The NPC crowd is a single system; its navmesh is rebaked (async, ~100 ms on the sample grids) whenever a resident cell's ground comes or goes, from every resident cell's walkable surface (its collider GLB, else the derived ground grid) plus the roads between them, bounded to the union of the scans' coverage. The crowd keeps walking on the old mesh until the new one is ready, then the agents move over; a bake overtaken by a newer one is dropped. Rebakes are coalesced to one per frame.
- **A cell arrives under its own light.** `lighting.preset` (SCH-1) / `SceneDef.lighting` dissolves the grade to the cell's preset on arrival — unless the player (T, `?time=`) or the director (`set_time`) has picked a time, which then holds across cells. On the strip: the snow street at blue hour, the tower in the fog; the valley stays neutral because the missions ask for golden hour themselves.

## Consequences

- - The Marble cells author their content in `cell.json` next to their spawns and doorways; nothing in the runtime is hub-specific any more except the billboard, which belongs to the studio session.
- - Walking the strip now means meeting different people under different light in each cell, with the hub exactly as before (the e2e slice and the physics smoke see the same `crate_1`, `can_3`, `lowrider` and Photographer).
- - `tests/e2e/streaming.spec.ts` counts content in and out across three cells, including the hub's kit coming back.
- − A cell's content resets on reload: props return to their authored spots. Persisting prop poses per cell (and the takes that moved them) is a session-store question for M6.
- − The navmesh rebake is main-thread Recast work; on a big Marble collider it will want a worker (as will the ground derivation) — the same background-load item ADR-0009 lists.
- − Zones (`poi`, `nogo`, `drive`, `tag_wall`) are still not read by the runtime.
