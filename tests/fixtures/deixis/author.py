#!/usr/bin/env python3
"""
Authors the deixis fixture suite (goal.md SCH-6, QB-6): every expectation below is written from the DIR-3 rules by
hand — Bolt's pairing when the pointing events match the deictic words, the nominal time t_k = start + (end − start)·k/(n+1)
with an explicit event preferred within ±700 ms, the source priority hand > pointer > head > selection > last-mentioned
with its confidence bands (0.95 / 0.9 / 0.72 / 0.8 / 0.6), relations in the speaker's frame (forward −Z: right = +X).
The resolver is never consulted here; `tests/unit/deixis.test.ts` runs the suite and computes precision per source.

Scene (shared with the test's SceneIndex): car_red (2,0,0) · car_blue (10,0,0) · taco_truck (0,0,−5) · can_red (1,0,1) ·
cone_orange (3,0,3); "car" describes two cars, "truck" the taco truck. Run: python3 tests/fixtures/deixis/author.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = []


def fx(name, source, utterance, speech, n, buffer, cases, **extra):
    d = {"name": name, "source": source, "utterance": utterance, "speech": {"startMs": speech[0], "endMs": speech[1]},
         "deicticTotal": n, "buffer": buffer, "cases": cases}
    d.update(extra)
    OUT.append(d)


def obj(ordinal, id, lo, hi=1.0, word="that"):
    return {"ref": {"deictic": word, "ordinal": ordinal}, "kind": "object", "expect": {"id": id, "minConfidence": lo, "maxConfidence": hi}}


def ask(ordinal, question, word="that"):
    return {"ref": {"deictic": word, "ordinal": ordinal}, "kind": "object", "expect": {"question": question}}


def place(ordinal, pos, lo, word="there"):
    return {"ref": {"deictic": word, "ordinal": ordinal}, "kind": "place", "expect": {"pos": pos, "minConfidence": lo}}


def rel(to, r, pos, lo, d=None):
    ref = {"relative": {"to": to, "rel": r}}
    if d is not None:
        ref["relative"]["distance_m"] = d
    return {"ref": ref, "kind": "place", "expect": {"pos": pos, "minConfidence": lo}}


def click(t, id, ground=None, **k):
    s = {"t": t, "pointerHit": id, "clickEdge": True}
    if ground:
        s["groundPoint"] = ground
    s.update(k)
    return s


def hover(t, id, ground=None, **k):
    s = {"t": t, "pointerHit": id}
    if ground:
        s["groundPoint"] = ground
    s.update(k)
    return s


def pinch(t, id, point, strength=0.9, hand="right", **k):
    s = {"t": t, "handHit": {"hand": hand, "id": id, "point": point}, "pinchStrength": strength}
    s.update(k)
    return s


def trigger(t, id, point, hand="right"):
    return {"t": t, "handHit": {"hand": hand, "id": id, "point": point}, "clickEdge": True}


def gaze(t, id, **k):
    s = {"t": t, "headHit": id}
    s.update(k)
    return s


# ── pointer: Bolt's rule (events = deictics) ──
fx("pointer: one click, one deictic", "pointer", "delete that", (0, 800), 1,
   [hover(100, "car_blue"), click(450, "can_red"), hover(700, "cone_orange")], [obj(1, "can_red", 0.9)])
fx("pointer: two clicks for two deictics, in order", "pointer", "put that on that", (2000, 3500), 2,
   [click(2300, "can_red"), hover(2600, "car_red"), click(3100, "taco_truck"), hover(3400, "car_blue")],
   [obj(1, "can_red", 0.9), obj(2, "taco_truck", 0.9)])
fx("pointer: three clicks for three deictics — group this, that and that", "pointer", "group this and that and that", (0, 2400), 3,
   [click(300, "can_red"), click(1200, "cone_orange"), click(2100, "car_blue")],
   [obj(1, "can_red", 0.9, word="this"), obj(2, "cone_orange", 0.9), obj(3, "car_blue", 0.9)])
fx("pointer: click just before the speech starts still counts (padded window)", "pointer", "paint that", (1000, 1800), 1,
   [click(400, "cone_orange"), hover(1400, "car_red")], [obj(1, "cone_orange", 0.9)])
fx("pointer: click after the last word still counts (late pointing)", "pointer", "move that", (1000, 1600), 1,
   [hover(1300, "car_red"), click(2200, "can_red")], [obj(1, "can_red", 0.9)])
fx("pointer: click too long after the speech is ignored; the hovered thing at the nominal time wins", "pointer", "rotate that", (0, 1000), 1,
   [hover(450, "car_red"), hover(550, "car_red"), click(2400, "can_red")], [obj(1, "car_red", 0.9)])
fx("pointer: click too long before the speech is ignored", "pointer", "scale that", (3000, 4000), 1,
   [click(1500, "can_red"), hover(3500, "cone_orange")], [obj(1, "cone_orange", 0.9)])
# ── pointer: more events than deictics → nominal time + nearest event within ±700 ms ──
fx("pointer: four clicks, two deictics — each deictic takes the click nearest its nominal time", "pointer", "put that next to that", (0, 3000), 2,
   [click(200, "car_blue"), click(1100, "can_red"), click(1900, "taco_truck"), click(2900, "cone_orange")],
   [obj(1, "can_red", 0.9), obj(2, "taco_truck", 0.9)])  # t1 = 1000, t2 = 2000
fx("pointer: two clicks, one deictic — the one nearest the middle of the sentence", "pointer", "delete that", (0, 1000), 1,
   [click(50, "car_red"), click(650, "can_red")], [obj(1, "can_red", 0.9)])
fx("pointer: no click, one deictic — whatever the pointer was on mid-sentence", "pointer", "make that bigger", (0, 1200), 1,
   [hover(100, "car_blue"), hover(600, "cone_orange"), hover(1100, "car_red")], [obj(1, "cone_orange", 0.9)])
fx("pointer: no clicks, two deictics — hovers nearest the two nominal times", "pointer", "put that on that", (0, 3000), 2,
   [hover(900, "can_red"), hover(1500, "car_blue"), hover(2100, "taco_truck")], [obj(1, "can_red", 0.9), obj(2, "taco_truck", 0.9)])
# ── places from the pointer ──
fx("pointer: 'there' is the ground under the click", "pointer", "put it there", (0, 1200), 2,
   [click(400, "can_red"), click(900, "ground", [4, 0, -9])], [obj(1, "can_red", 0.9, word="it"), place(2, [4, 0, -9], 0.9)])
fx("pointer: 'there' without a click is the ground under the hover at its nominal time", "pointer", "drop a crate there", (0, 1000), 1,
   [hover(300, "ground", [1, 0, -2]), hover(500, "ground", [6, 0, -3]), hover(800, "ground", [9, 0, -1])], [place(1, [6, 0, -3], 0.9)])
fx("pointer: 'here' is the speaker's own ground point", "pointer", "bring the ball here", (0, 1000), 1,
   [hover(500, "ground", [0, 0, 0.5])], [place(1, [0, 0, 0.5], 0.9, word="here")])
fx("pointer: 'there' with no ground under the ray asks where", "pointer", "put it there", (0, 1000), 2,
   [click(300, "can_red"), {"t": 700, "clickEdge": True}], [obj(1, "can_red", 0.9, word="it"),
                                                            {"ref": {"deictic": "there", "ordinal": 2}, "kind": "place", "expect": {"question": "where?"}}])
# ── hand / controller ──
fx("hand: one pinch peak, one deictic", "hand", "delete that", (0, 900), 1,
   [pinch(300, "car_red", [2, 0, 0], 0.3), pinch(400, "car_red", [2, 0, 0], 0.85), pinch(500, "car_red", [2, 0, 0], 0.95),
    pinch(600, "can_red", [1, 0, 1], 0.4)], [obj(1, "car_red", 0.95)])
fx("hand: a held pinch is one event at its peak, paired with the one deictic", "hand", "paint that", (0, 1500), 1,
   [pinch(200, "cone_orange", [3, 0, 3], 0.75), pinch(233, "cone_orange", [3, 0, 3], 0.9), pinch(266, "taco_truck", [0, 0, -5], 0.97),
    pinch(299, "taco_truck", [0, 0, -5], 0.8), pinch(400, "car_red", [2, 0, 0], 0.2)], [obj(1, "taco_truck", 0.95)])
fx("hand: two pinches for 'put that there' — object then ground point", "hand", "put that there", (1000, 2200), 2,
   [gaze(1150, "car_blue", pinchStrength=0.1), pinch(1300, "taco_truck", [0, 0, -5], 0.92, headHit="car_blue"),
    gaze(1500, "taco_truck", pinchStrength=0.2), pinch(1800, "ground", [4, 0, -9], 0.85, headHit="pier_dj")],
   [obj(1, "taco_truck", 0.95), place(2, [4, 0, -9], 0.95)])
fx("hand: left-hand pinch counts the same as right", "hand", "move that", (0, 1000), 1,
   [pinch(500, "can_red", [1, 0, 1], 0.88, hand="left")], [obj(1, "can_red", 0.95)])
fx("hand: a weak pinch is not an event — the head ray at the nominal time resolves instead", "hand", "delete that", (0, 1000), 1,
   [pinch(200, "car_blue", [10, 0, 0], 0.4), gaze(500, "cone_orange"), gaze(800, "car_red")], [obj(1, "cone_orange", 0.7, 0.79)])
fx("controller: the trigger is a click edge on the hand ray — full hand confidence", "hand", "paint that", (0, 1000), 1,
   [trigger(500, "cone_orange", [3, 0, 3])], [obj(1, "cone_orange", 0.95)])
fx("controller: two triggers for two deictics, the second on the ground", "hand", "put that there", (0, 2000), 2,
   [trigger(600, "can_red", [1, 0, 1]), trigger(1500, "ground", [5, 0, -2])], [obj(1, "can_red", 0.95), place(2, [5, 0, -2], 0.95)])
fx("controller: a hand ray beats a pointer on the same sample", "hand", "delete that", (0, 1000), 1,
   [{"t": 500, "handHit": {"hand": "right", "id": "taco_truck", "point": [0, 0, -5]}, "pointerHit": "car_red", "clickEdge": True}],
   [obj(1, "taco_truck", 0.95)])
# ── head ray / gaze only ──
fx("head: gaze only, one deictic — lower band, resolves to the gazed thing mid-sentence", "head", "delete that", (100, 900), 1,
   [gaze(200, "cone_orange"), gaze(500, "cone_orange"), gaze(800, "car_blue")], [obj(1, "cone_orange", 0.7, 0.79)])
fx("head: gaze only, two deictics — the gaze at each nominal time", "head", "put that on that", (0, 3000), 2,
   [gaze(900, "can_red"), gaze(1500, "car_blue"), gaze(2000, "taco_truck"), gaze(2900, "cone_orange")],
   [obj(1, "can_red", 0.7, 0.79), obj(2, "taco_truck", 0.7, 0.79)])
fx("head: 'there' by gaze is the ground under the head ray, head confidence", "head", "put the cone there", (0, 1000), 1,
   [gaze(500, "ground", groundPoint=[7, 0, -4])], [place(1, [7, 0, -4], 0.7)])
fx("head: a pointer hover outranks the gaze on the same sample", "head", "scale that", (0, 1000), 1,
   [{"t": 500, "headHit": "car_blue", "pointerHit": "can_red"}], [obj(1, "can_red", 0.9)])
# ── selection / last-mentioned ──
fx("selection: nothing pointed, something selected — the selection, at its band", "selection", "paint that", (0, 1000), 1,
   [{"t": 500, "selection": "car_red"}], [obj(1, "car_red", 0.8, 0.8)])
fx("selection: a gaze outranks the selection", "selection", "delete that", (0, 1000), 1,
   [{"t": 500, "selection": "car_red", "headHit": "cone_orange"}], [obj(1, "cone_orange", 0.7, 0.79)])
fx("last: 'it' with nothing pointed is the last thing mentioned", "last", "make it bigger", (0, 1000), 1,
   [{"t": 300}, {"t": 700}], [obj(1, "can_red", 0.6, 0.6, word="it")], lastMentioned="can_red")
fx("last: a click still beats the last-mentioned thing", "pointer", "delete it", (0, 1000), 1,
   [click(500, "cone_orange")], [obj(1, "cone_orange", 0.9, word="it")], lastMentioned="can_red")
fx("none: nothing pointed, nothing mentioned — ask, never guess", "none", "paint that", (100, 700), 1,
   [{"t": 300}, {"t": 600}], [ask(1, "which?")])
fx("none: 'there' with nothing on the ground anywhere asks where", "none", "put the ball there", (0, 1000), 1,
   [{"t": 500}], [{"ref": {"deictic": "there", "ordinal": 1}, "kind": "place", "expect": {"question": "where?"}}])
# ── descriptions ──
fx("desc: a unique description resolves without pointing", "desc", "delete the truck", (0, 1000), 1, [],
   [{"ref": {"desc": "truck"}, "kind": "object", "expect": {"id": "taco_truck", "minConfidence": 0.85}}])
fx("desc: an ambiguous description asks 'this one?' with two candidates", "desc", "paint the car red", (0, 1000), 1, [],
   [{"ref": {"desc": "car"}, "kind": "object", "expect": {"question": "this one?"}}])
fx("desc: an unknown description asks which", "desc", "delete the unicorn", (0, 1000), 1, [],
   [{"ref": {"desc": "unicorn"}, "kind": "object", "expect": {"question": "which?"}}])
fx("desc: 'the car near the truck' picks the closer car", "desc", "move the car near the truck", (0, 1000), 1, [],
   [{"ref": {"desc": "car", "near": {"desc": "truck"}}, "kind": "object", "expect": {"id": "car_red", "minConfidence": 0.4}}])
# ── relations (speaker faces −Z: right = +X, behind = +Z, in front = −Z) ──
fx("relation: next to a clicked thing is off its right at 1 m", "pointer", "put the ball next to that", (0, 1000), 1,
   [click(500, "taco_truck")], [rel({"deictic": "that", "ordinal": 1}, "next_to", [1, 0, -5], 0.8, 1)])
fx("relation: behind the truck is its far side (away from me)", "desc", "drop a cone behind the truck", (0, 1000), 0, [],
   [rel({"desc": "truck"}, "behind", [0, 0, -7], 0.8, 2)])
fx("relation: in front of the truck is its near side", "desc", "put the can in front of the truck", (0, 1000), 0, [],
   [rel({"desc": "truck"}, "in_front", [0, 0, -3], 0.8, 2)])
fx("relation: left and right of the truck in my frame", "desc", "left of the truck", (0, 1000), 0, [],
   [rel({"desc": "truck"}, "left", [-2, 0, -5], 0.8, 2), rel({"desc": "truck"}, "right", [2, 0, -5], 0.8, 2)])
fx("relation: on top of the cone is one diameter up", "desc", "put it on the cone", (0, 1000), 0, [],
   [{"ref": {"relative": {"to": {"id": "cone_orange"}, "rel": "on_top"}}, "kind": "place", "expect": {"pos": [3, 2, 3], "minConfidence": 0.85}}])
fx("relation: inside is the thing's own spot", "desc", "put it in the truck", (0, 1000), 0, [],
   [{"ref": {"relative": {"to": {"id": "taco_truck"}, "rel": "inside"}}, "kind": "place", "expect": {"pos": [0, 0, -5], "minConfidence": 0.85}}])
fx("relation: behind me is at my back, in front of me along my forward (the speaker flips depth)", "desc", "drop it behind me", (0, 1000), 0, [],
   [{"ref": {"relative": {"to": {"id": "me"}, "rel": "behind", "distance_m": 2}}, "kind": "place", "expect": {"pos": [0, 0, 2], "minConfidence": 0.85}},
    {"ref": {"relative": {"to": {"id": "me"}, "rel": "in_front", "distance_m": 2}}, "kind": "place", "expect": {"pos": [0, 0, -2], "minConfidence": 0.85}}],
   speakerId="me")
fx("relation: facing +X, 'right of the truck' is toward +Z", "desc", "right of the truck", (0, 1000), 0, [],
   [rel({"desc": "truck"}, "right", [0, 0, -3], 0.8, 2)], speakerForward=[1, 0])
fx("relation: an ambiguous anchor asks before placing", "desc", "put the ball behind the car", (0, 1000), 0, [],
   [{"ref": {"relative": {"to": {"desc": "car"}, "rel": "behind"}}, "kind": "place", "expect": {"question": "this one?"}}])
fx("relation: a relation to a gazed thing carries the gaze's confidence", "head", "next to that", (0, 1000), 1,
   [gaze(500, "can_red")], [rel({"deictic": "that", "ordinal": 1}, "next_to", [2, 0, 1], 0.7, 1)])
# ── mixed devices / ordinals ──
fx("mixed: pinch for the thing, click for the place", "hand", "put that there", (0, 2000), 2,
   [pinch(500, "can_red", [1, 0, 1], 0.9), click(1500, "ground", [3, 0, -6])], [obj(1, "can_red", 0.95), place(2, [3, 0, -6], 0.9)])
fx("mixed: click for the thing, pinch on the ground for the place", "hand", "move that there", (0, 2000), 2,
   [click(500, "cone_orange"), pinch(1500, "ground", [8, 0, 2], 0.9)], [obj(1, "cone_orange", 0.9), place(2, [8, 0, 2], 0.95)])
fx("ordinals: an ordinal past the count clamps to the last deictic", "pointer", "that", (0, 1000), 1,
   [click(500, "car_blue")], [obj(5, "car_blue", 0.9)])
fx("ordinals: a missing ordinal means the first deictic", "pointer", "delete that", (0, 1000), 1,
   [click(500, "car_blue")], [{"ref": {"deictic": "that"}, "kind": "object", "expect": {"id": "car_blue", "minConfidence": 0.9}}])
fx("mixed: 'this' and 'it' are pointing words like 'that'", "pointer", "put this on it", (0, 2000), 2,
   [click(600, "can_red"), click(1400, "taco_truck")], [obj(1, "can_red", 0.9, word="this"), obj(2, "taco_truck", 0.9, word="it")])
fx("timing: a long sentence with the click early — nominal time is still inside ±700 ms of it", "pointer", "could you please delete that one over there for me", (0, 3000), 2,
   [click(900, "cone_orange"), hover(2000, "ground", [2, 0, -8])], [obj(1, "cone_orange", 0.9), place(2, [2, 0, -8], 0.9)])
fx("timing: a click 800 ms from the nominal time is too far — the nearest sample resolves instead", "pointer", "delete that", (0, 2000), 1,
   [click(100, "car_blue"), hover(1000, "can_red"), click(1900, "cone_orange")], [obj(1, "can_red", 0.9)])

def dumps(v, ind=0):
    """JSON the way the repo's Prettier prints it (objects expanded, scalar arrays inline), so `pnpm lint` stays clean."""
    pad = "  " * ind
    if isinstance(v, dict):
        if not v:
            return "{}"
        items = [f"{pad}  {json.dumps(k, ensure_ascii=False)}: {dumps(x, ind + 1)}" for k, x in v.items()]
        return "{\n" + ",\n".join(items) + f"\n{pad}}}"
    if isinstance(v, list):
        if not v:
            return "[]"
        if all(not isinstance(x, (dict, list)) for x in v):
            return "[" + ", ".join(json.dumps(x, ensure_ascii=False) for x in v) + "]"
        return "[\n" + ",\n".join(f"{pad}  {dumps(x, ind + 1)}" for x in v) + f"\n{pad}]"
    return json.dumps(v, ensure_ascii=False)


for i, d in enumerate(OUT):
    fname = f"{i + 5:03d}-{d['source']}-{''.join(c if c.isalnum() else '-' for c in d['name'].split(':')[-1].strip().lower())[:48].strip('-')}.json"
    with open(os.path.join(HERE, fname), "w") as f:
        f.write(dumps(d) + "\n")
print(f"{len(OUT)} fixtures, {sum(len(d['cases']) for d in OUT)} cases")
