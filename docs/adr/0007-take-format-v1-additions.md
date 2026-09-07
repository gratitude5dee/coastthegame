# ADR-0007 — Take format v1 additions and the world-edit replay policy

**Status:** accepted (2026-09-06) · **Owner:** GRATITUD3 · **Refs:** goal.md ACT-2, ACT-3, ACT-4, SCH-4, STU-1, W-4

## Context

SCH-4 defines `take.bin` as a JSON header plus a packed body, and ACT-2 asks the world-edit log to "repaint the wall and re-throw the can" on replay. The rigs are not in yet (M4), so takes carry root poses only; meanwhile the lowrider, the props and possession all had to replay correctly in the multi-take set (ACT-2) and in the offline export (STU-1), which never re-simulates.

## Decision

- **Body columns:** `t`, `pos`, `yaw`, `speed`, `camPos`, `camQuat`, then a `u8` flags column — bit 0 grounded, bit 1 **driving**. Files written before the driving bit decode unchanged (bit 1 reads 0). 53 bytes per sample; a 60 s take at 30 Hz is ~95 kB, well under the 1 MB/min budget even with bone tracks to come.
- **Prop pose tracks** (`props?: PropTrack[]` in the header, `v` stays 1): per prop, 30 Hz poses recorded **only while the prop moves**; the rest pose is pinned one period before motion starts, the track closes with the freshest pose, and tracks with fewer than two samples are dropped. Replay drives props **kinematically** from the tracks (STU-1) — the live hand wins while the player is holding that prop.
- **World edits:** `propGrab` / `propRelease` / `propThrow`, `sdfPaint`, and `marker` (the director's "mark beat drop" → a caption at that time). **Tags are not repainted on replay:** paint is a persistent world edit that stays in the SplatEdit until undone, so replaying it into the same world would double every puff. A take's `sdfPaint` log is the seed for the painter when the set is restored into a fresh world (the reel), which is the only time repainting is right.
- **Possession is an identity swap** (ACT-3): the player capsule takes the NPC's identity (look, name, lines) and the NPC entity takes the one the player had; the take header's `actorId` names who performed it and the ghost wears that look. The `Controller` slot swap of ACT-1 arrives with the skinned rigs (M4), when an NPC body is worth keeping.
- Takes upload to the session's shelf at cut (`ACT-4`, ADR-0005); the cell version they reference is the sample world's id until `cell.json` versions exist.

## Consequences

- - Backward compatible; replays are deterministic across tiers and in the export; a thrown can lands in the same place every time.
- - Ghosts, the reel and the export share one pose source (`TakeSet`), including the see-through lowrider for driving poses.
- − Paint from an earlier session does not reappear on a fresh page until the seed path lands.
- − A possessed NPC is still the player's kinematic capsule with a different look; NPC-specific bodies wait for M4.
