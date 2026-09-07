# The director's grammar (goal.md DIR-4)

What you can say to the set — spoken (hold `` ` `` / LT / MIC), typed (`/`), or through the voice model. Every line
below parses into the same **scene acts** (`packages/director/src/schema.ts`) that the OpenAI Realtime tools emit, so
the grammar is the contract and the model is one way of speaking it (ADR-0006). The parser is
`packages/director/src/grammar.ts`; `tests/unit/grammar.test.ts` is the executable version of this page.

## Shape

- **Verb + object + place**, in that order: _put the crate next to the car_ · _move that there_.
- **Several directions in one breath**, split on `,` `;` `then` `and`: _camera low, follow the car, action_.
- Case, trailing punctuation and articles (_the / a / my / that_) don't matter. Numbers are digits: _35 mm_, _turn it 90_.
- **Pointing words** — _that / this / it_ for things, _there / here_ for places — are paired with what you were pointing
  at when you said them (DIR-3): the k-th pointing word in the sentence takes the k-th slice of the speech window, and
  the resolver prefers an explicit click / trigger / pinch inside ±700 ms of it. _put that there_ = two pointing events.
- Objects are named by **description** (_the crate_, _the blue can_, _the ball_, _the car_, _the photographer_, _Rico_) or
  are **you** (_me / myself / $COAST_). Ambiguity asks a one-word question instead of guessing (below).

## Takes

| Say                                                              | Act                           |
| ---------------------------------------------------------------- | ----------------------------- |
| _action_ · _roll_ · _rolling_ · _record_ · _shoot_               | `record start`                |
| _cut_ · _stop_ · _that's a wrap_                                 | `record stop`                 |
| _take two_ · _retake_ · _again_ · _one more_ · _from the top_    | `record start` (next take)    |
| _replay_ · _playback_ · _show me the take_ / _the set_           | `replay_take` (the whole set) |
| _mark_ · _mark beat_ · _mark beat drop_ · _drop a marker chorus_ | `mark_beat` (label optional)  |
| _undo_ · _never mind_ · _scratch that_ · _go back_               | `undo`                        |

Markers become captions in the cut at the time you said them (STU-4).

## Perspective

_actor_ · _director_ · _producer_ (also _go director_, _switch to producer_, _director mode_) → `set_mode`. Only the
active mode's tools are exposed to the model (CAM-8); a director who says _put that there_ hops to the producer's
tools for that act and comes back.

## Camera (director)

| Say                                                                                                                   | Act                          |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| _wide_ · _medium_ · _close_ / _closer_ / _tight_ · _low_ · _high_ · _dutch_ (optionally _camera …_, _… shot_)         | `camera { shot }`            |
| _follow the car_ · _track me_ · _stay on Rico_                                                                        | `camera { follow }`          |
| _look at the crate_ · _frame the billboard_ · _focus on that_                                                         | `camera { look_at }`         |
| _push in_ · _pull out_ · _orbit_ / _circle_ · _crane up_ / _higher_ · _crane down_ / _lower_ · _dolly left_ / _right_ | `camera { move }`            |
| … _slow_ / … _fast_ after a move                                                                                      | 3 s / 0.6 s instead of 1.5 s |
| _35 mm_ · _lens 85 mm_ · _camera 24mm_                                                                                | `camera { lens_mm }`         |

Shots tween the rig (distance, height, field of view) without changing mode; a dutch rolls the horizon and the next
shot rolls it back; _follow_ re-targets the rig on a prop, the lowrider or an NPC and _follow me_ brings it home.

### Keyframed paths (CAM-7)

| Say                                                                   | Act                                                                        |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| _set a key_ · _keyframe_ · _drop a key here_                          | `camera { path: key }` — the camera as it stands, timed from the first key |
| _play the path_ · _fly the path in 8 seconds_ · _run the path looped_ | `camera { path: play, path_seconds?, loop? }` — the locked shot            |
| _free camera_ · _release the camera_ · _stop the path_                | `camera { path: stop }`                                                    |
| _clear the path_ · _forget the keys_                                  | `camera { path: clear }`                                                   |
| _drop the last key_                                                   | `camera { path: undo_key }`                                                |

Two keys make a path (a centripetal Catmull-Rom through the positions, slerped orientation, lerped lens, eased per
segment). While it plays the rig rides it and hands the camera back at the last key; with two keys or more the path
also drives the **cut export** instead of a take's recorded camera.

## Light & weather (director, producer)

| Say                                                     | Act                          |
| ------------------------------------------------------- | ---------------------------- |
| _golden hour_ · _sunset_ · _magic hour_                 | `set_time golden`            |
| _blue hour_ · _dusk_ · _twilight_                       | `set_time blue`              |
| _night_ · _midnight_                                    | `set_time night`             |
| _noon_ · _midday_ · _daylight_                          | `set_time fog_noon`          |
| _fog_ · _misty_ · _haze_ · _rain_ · _drizzle_ · _clear_ | `set_weather fog/rain/clear` |

## The world (producer; _put / move_ also from director)

| Say                                                                                               | Act                                                      |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| _put the crate there_ · _move that next to the car_ · _drop it behind me_ · _bring the ball here_ | `move { obj, place }`                                    |
| _spawn a crate_ · _add a can there_ · _give me a ball next to the car_                            | `spawn { asset, place }` (in front of you when no place) |
| _turn the crate 90_ · _rotate it around_ · _spin that left_                                       | `rotate { yaw_deg }`                                     |
| _face the car at the billboard_ · _point it toward me_                                            | `rotate { face }`                                        |
| _make that bigger_ · _scale the crate 2x_ · _make it tiny_ · _half size_                          | `scale { factor }`                                       |
| _paint the crate red_ · _make it chrome_ · _colour that gold_                                     | `set_material { color }`                                 |
| _delete that_ · _remove the ball_ · _get rid of it_                                               | `delete` (confirms below 0.8)                            |

Places: _there / here_ (pointing), or a relation to something — _next to_ / _beside_ / _by_ / _near_, _behind_,
_in front of_, _left of_, _right of_, _on_ / _on top of_, _in_ / _inside_. Relations resolve in **your** frame
(_in front of me_ is in front of your face, _in front of the car_ is off its nose).

## People

| Say                                                                      | Act                     |
| ------------------------------------------------------------------------ | ----------------------- |
| _be the photographer_ · _possess Rico_ · _let me be Mari_ · _I'm Dee_    | `possess` (ACT-3)       |
| _dance_ · _wave_ · _sit_ · _celebrate_ · _pose_ · _flex_ · _bow_ · _nod_ | `play_anim` (with rigs) |

Possession swaps identity and place with that NPC; the next take is theirs and its ghost wears their look.

## When the set asks

An act below **0.6 confidence** — or a `delete` / a scale over 3× below **0.8** — shows a ghost preview and asks
_this one?_ or _there?_. Answer with one of:

- _yes_ · _yeah_ · _do it_ · _go ahead_ · _that one_ · _exactly_ → commit
- _no_ · _nope_ · _cancel_ · _not that one_ · _forget it_ → drop it
- _the left one_ · _the right one_ · _the closer one_ · _the far one_ · _the first one_ · _the other one_ → pick
  (never a bare _closer_ — that is a camera shot)

_undo_ is always available and reverses the last committed act.

## What the model adds

With the voice model live, the same words go through its tools with a scene summary (≤ 2 KB) and the active mission
brief as context, so phrasing can drift further from the tables above — _get me a nice low angle on the car as it
rolls past_ still arrives as `camera { shot: low, follow: car }`. The nightly suite runs ten spoken utterances against
the real model and expects ≥ 9 of them to land as the acts this page lists (DIR-6).
