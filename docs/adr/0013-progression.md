# ADR-0013 — Progression: what stars unlock, when, and what stays free

**Status:** accepted (2026-09-07) · **Owner:** GRATITUD3 · **Refs:** goal.md MIS-1, MIS-3, MIS-4, CAM-6, PHY-3, W-5, §3.1

## Context

MIS-4 says stars unlock outfits, lenses (24/35/50/85), hydraulic patterns, time presets and NPC cameos, and that the reel fills bar by bar. The reel exists (ADR-0007's take format, the strip, persistence); the rewards did not: every lens, preset and hop was free from the first frame, and a mission's `reward.unlock` was a string nobody read. Two constraints shape the design: the golden path (§3.1) must never wait on a star — mission 1 asks for golden hour and a low wide shot — and nothing new should need saving, because the reel is already the record of what the player earned.

## Decision

- **Unlocks are derived from the reel, never stored.** `unlocksFor(reel, missions)` (`packages/studio/src/unlocks.ts`, pure) = every earned mission's own `reward.unlock` (≥ 1★, in track order) + a **star ladder** over the total stars of the reel: 2★ night · 3★ 50 mm · 4★ the gold fit · 5★ the pancake · 6★ 85 mm and DJ Coast · 8★ fog noon · 9★ the chrome fit. A worse take never takes anything back (the reel keeps the best verdict). The only stored choice is the **loadout** — which unlocked outfit is worn and which pattern the beat runs (`coast:loadout`) — and it is re-validated against the unlocks at boot.
- **Free, always:** the 24 mm (the rig's default), noon / golden hour / blue hour, the classic hop sequence, the default fit, every look (MIS-6 is the mission's, not a reward). Gates: a longer lens asked of the director (`camera { lens_mm }` → the nearest catalogue stop), night and fog noon from the T key and `set_time`; `?time=` and the screenshot harness stay free (QA).
- **What an unlock is** lives in the catalogue so the game can apply it without knowing the id: a lens is a focal length; a pattern is a hop sequence the beat-driven hydraulics step through; a time is a preset; an outfit is a colour on the placeholder body (CHR-2's three outfits map onto these ids when the rigs land); a cameo is a person who walks into the hub once earned (spawned with the hub's content, so they leave and return with the cell).
- **Saying it:** the verdict card lists what the take unlocked and what the next star brings; a refused lens / preset / fit answers with the rung ("the chrome fit is locked — 5★ more on the reel unlocks it"); the director's `loadout` op takes _wear the gold fit · put on the chrome · default fit · three-wheel motion · pancake · classic hops_.
- **Mission 1's reward is the 35 mm** (it was the free 24 mm); mission 2's stays the three-wheel motion.

## Consequences

- - Two missions already carry the whole loop: earn → unlock → wear / run / shoot with it; the 12-mission reel (M5) only extends the ladder.
- - Nothing to migrate: old saved reels produce the same unlocks on the next boot.
- − The ladder is authored by hand; a planner-authored mission set (MIS-5) will want the rungs re-tuned to its star budget.
- − Outfits are colours until the rigs land; cameos are placeholder capsules with two lines.
