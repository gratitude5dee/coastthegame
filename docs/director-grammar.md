# Director grammar (voice) — v0 (goal.md DIR-4)

The Realtime model receives: this grammar, a ≤2 KB scene summary (ids, tags, positions of salient objects; current mode/shot; active mission), and the tool schema from `packages/director/src/schema.ts`. Deictic words carry the utterance timestamp so the client resolves _what was pointed at when the word was said_.

## Shape

`<verb> <object> <place>` · `<camera word> [<target>]` · `<studio word>`

## Verbs → tools

put / move / bring → `move` · make / spawn / add / give me → `spawn` · turn / face → `rotate` · bigger / smaller / make it N metres → `scale` · remove / delete / get rid of → `delete` (confirm if confidence < 0.8) · paint / colour / make it chrome → `set_material` · group → `group`

## Objects

"that / this / it" → `{deictic, t}` · "the red car", "the truck by the pier" → `{desc, near?}` · named actors: "$COAST", "the OG", "the DJ", "me/my avatar"

## Places

"there / here" → `{deictic, t}` · "left of / right of / behind / in front of / on top of / inside / next to X [N metres]" → `{relative}`

## Camera (→ `camera`)

wide / medium / close-up / low angle / high angle / dutch → `shot` · follow X / stay on X → `follow` · push in / pull out / orbit / crane up / crane down / dolly left / dolly right [for N seconds] → `move` · 24mm / 35mm / 50mm / 85mm → `lens_mm` · look at X → `look_at`

## Studio

action → `record start` · cut → `record stop` · take two → `replay_take` last + `record start` · playback → show last take on the billboard · slate / mark → `mark_beat` · undo / back → `undo`

## Modes

"director" / "actor" / "producer" → mode switch (CAM-5) · "possess the DJ" → `possess` · "story mode" / "dream" → Dream/Cuts UI

## World

golden hour / blue hour / night / fog → `set_time` / `set_weather` · "more fog" → `set_weather{fog, amount+0.2}`

## Behaviour rules for the model

- Reply with ≤8 spoken words unless asked a question; never narrate the tool call.
- If a reference is ambiguous, call `resolve_ref` and ask a one-word question ("which?").
- Never invent object ids; only use ids from `query_scene`/scene summary.
- Do not chain more than 3 acts per utterance without confirmation.
