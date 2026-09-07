/**
 * Utterance grammar (goal.md DIR-1 fallback / DIR-2): turns what the player said or typed into `SceneAct`s — the same
 * acts the Realtime model emits as tool calls. The voice path (M5) hands the model the tool schema and the transcript;
 * this grammar is the deterministic path: typed commands (the `/` bar), the scripted voice suite, and offline play.
 * It is deliberately small and literal — a film-set vocabulary, not natural-language understanding.
 *
 * Deixis: every that/this/it/there/here in the utterance is counted (the client stamps `deicticTotal`) and each
 * deictic reference carries its 1-based ordinal among them, so the resolver can pair words with pointing events.
 */
import type { CameraMove, LookName, ObjectRef, PlaceRef, Relation, RigMode, SceneAct, ShotName } from './schema';

/** Replies to a question the executor asked ("this one?", "there?"): not scene acts, they finish a pending one. */
export type Meta =
  { kind: 'confirm' } | { kind: 'cancel' } | { kind: 'pick'; which: 'first' | 'second' | 'left' | 'right' | 'near' | 'far' };

export interface Clause {
  text: string;
  /** null when nothing matched (surfaced as "didn't get …") — or when the clause is a reply (`meta`). */
  act: SceneAct | null;
  meta?: Meta;
}

export interface Utterance {
  /** Normalised transcript the acts were parsed from. */
  transcript: string;
  /** Every clause in order, matched or not. */
  clauses: Clause[];
  acts: SceneAct[];
  /** that/this/it/there/here occurrences in the whole utterance (the deixis pairing needs the total). */
  deicticTotal: number;
  /** Clauses nothing matched. */
  unknown: string[];
}

const DEICTIC = /\b(that|this|it|there|here)\b/g;
const ARTICLES = /^(the|a|an|my|our|that|this)\s+/;

/** "$COAST" / "me" / "myself" are the player; everything else is a description the scene index resolves. */
function nameRef(raw: string): ObjectRef {
  const s = raw.trim().replace(ARTICLES, '');
  if (/^(me|myself|coast|\$coast|my body|my own body|player)$/.test(s)) return { id: 'me' };
  return { desc: s };
}

export function parseUtterance(text: string): Utterance {
  const transcript = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const deicticTotal = (transcript.match(DEICTIC) ?? []).length;
  let ordinal = 0;
  const next = () => ++ordinal;
  /** A noun phrase → object reference; deictic words take the next ordinal. */
  const obj = (raw: string): ObjectRef => {
    const s = raw.trim();
    if (/^(that|this|it|that one|this one)$/.test(s))
      return { deictic: s.startsWith('this') ? 'this' : s === 'it' ? 'it' : 'that', ordinal: next() };
    return nameRef(s);
  };
  const RELATIONS: [RegExp, Relation][] = [
    [/^(next to|beside|by|near) (.+)$/, 'next_to'],
    [/^behind (.+)$/, 'behind'],
    [/^in front of (.+)$/, 'in_front'],
    [/^(to the )?left of (.+)$/, 'left'],
    [/^(to the )?right of (.+)$/, 'right'],
    [/^(on top of|onto|on) (.+)$/, 'on_top'],
    [/^(inside|in|into) (.+)$/, 'inside'],
  ];
  const place = (raw: string): PlaceRef | null => {
    const s = raw.trim();
    if (/^(there|over there|right there|down there|up there)$/.test(s)) return { deictic: 'there', ordinal: next() };
    if (/^(here|over here|right here)$/.test(s)) return { deictic: 'here', ordinal: next() };
    for (const [re, rel] of RELATIONS) {
      const m = re.exec(s);
      if (m) return { relative: { to: obj(m[m.length - 1]!), rel } };
    }
    return null;
  };
  const PLACE_WORDS =
    '(there|here|over there|right there|down there|up there|over here|right here|next to .+|beside .+|by .+|near .+|behind .+|in front of .+|(?:to the )?left of .+|(?:to the )?right of .+|on top of .+|onto .+|on .+|inside .+|into .+|in .+)';

  const acts: SceneAct[] = [];
  const unknown: string[] = [];
  const parsed: Clause[] = [];
  const clauses = transcript
    .split(/\s*(?:[,;]|\bthen\b|\band then\b|\band\b)\s*/)
    .map((c) => c.trim())
    .filter(Boolean);

  for (const c of clauses) {
    let m: RegExpExecArray | null;
    const before = acts.length;
    // ── replies to a question ──
    const meta = parseMeta(c);
    if (meta) {
      parsed.push({ text: c, act: null, meta });
      continue;
    }
    // ── takes ──
    if (/^(action|roll( it| camera| sound)?|rolling|we'?re rolling|record|start recording|shoot)$/.test(c)) {
      acts.push({ op: 'record', action: 'start' });
    } else if (/^(cut|stop|stop recording|that'?s a wrap|wrap|and cut)$/.test(c)) {
      acts.push({ op: 'record', action: 'stop' });
    } else if (/^(take (two|three|2|3)|retake|again|one more|go again|from the top|reset)$/.test(c)) {
      acts.push({ op: 'record', action: 'start' });
    } else if (/^(undo( that| it)?|never ?mind|scratch that|go back)$/.test(c)) {
      acts.push({ op: 'undo', n: 1 });
    } else if (
      /^(replay|replay (it|that|the take|the set)|play ?back|play (it|that) back|show me( the take| the set)?|roll playback)$/.test(c)
    ) {
      acts.push({ op: 'replay_take', take: 'set', actor: { id: 'me' } });
    } else if ((m = /^(mark (?:the )?beat|drop a mark(?:er)?|marker|mark)(?: (.+))?$/.exec(c))) {
      acts.push({ op: 'mark_beat', label: m[2]?.trim() || 'beat' });
    }
    // ── perspective ──
    else if ((m = /^(?:(?:go|switch|switch to|be|to) )?(actor|director|producer)(?: mode| view)?$/.exec(c))) {
      acts.push({ op: 'set_mode', mode: m[1] as RigMode });
    }
    // ── looks (MIS-6: the film stock on the picture) — before the light words: "neon night" is a look, "night" a time;
    // a bare "35mm" stays a lens (CAM-6), the look wants "35mm dusk" or a look word ("the 35mm stock") ──
    else if (
      (m =
        /^(?:(?:use|give me|make it|shoot|shoot it|grade|grade it|go|switch to|set|film|film it|put on|try) )?(?:(?:the|a|an|in) )?(clean|35 ?mm dusk|dusk 35 ?mm|35 ?mm(?= (?:look|grade|stock|film|lut|filter)$)|vhs(?: 1994| 94)?|noir|neon(?: night)?|monochrome|mono)(?: look| grade| stock| film| lut| filter)?$/.exec(
          c,
        ))
    ) {
      acts.push({ op: 'set_look', preset: lookNameFor(m[1]!) });
    }
    // ── light & weather ──
    else if (/(golden hour|sunset|sundown|magic hour|golden)/.test(c)) acts.push({ op: 'set_time', preset: 'golden' });
    else if (/(blue hour|dusk|twilight)/.test(c)) acts.push({ op: 'set_time', preset: 'blue' });
    else if (/\b(night|midnight|night ?time)\b/.test(c)) acts.push({ op: 'set_time', preset: 'night' });
    else if (/\b(noon|midday|day ?time|daylight|day)\b/.test(c)) acts.push({ op: 'set_time', preset: 'fog_noon' });
    else if (/\b(fog|foggy|mist|misty|haze|hazy)\b/.test(c)) acts.push({ op: 'set_weather', kind: 'fog' });
    else if (/\b(rain|rainy|drizzle)\b/.test(c)) acts.push({ op: 'set_weather', kind: 'rain' });
    else if (/^(clear|clear skies|clear it up|clear the fog|no fog|sunny)$/.test(c)) acts.push({ op: 'set_weather', kind: 'clear' });
    // ── camera ──
    else if (
      (m =
        /^(?:camera |cam |shot |go |get |give me a |make it |angle )?(low|high|wide|close|closer|tight|medium|dutch)(?: angle| shot| up| in)?$/.exec(
          c,
        ))
    ) {
      const w = m[1]!;
      const shot: ShotName = w === 'closer' || w === 'tight' ? 'close' : (w as ShotName);
      acts.push({ op: 'camera', shot });
    } else if ((m = /^(?:camera |cam )?(?:follow|track|stay on|stay with|stick with) (.+)$/.exec(c))) {
      acts.push({ op: 'camera', follow: obj(m[1]!) });
    } else if ((m = /^(?:camera |cam )?(?:look at|frame|frame up|focus on|point at) (.+)$/.exec(c))) {
      acts.push({ op: 'camera', look_at: obj(m[1]!) });
    } else if (
      (m =
        /^(?:camera |cam )?(push in|push-in|dolly in|move in|pull out|pull back|back off|move out|orbit|circle|go around|crane up|go up|higher|crane down|go down|lower|dolly left|slide left|dolly right|slide right)( slow(?:ly)?| fast| quick(?:ly)?)?$/.exec(
          c,
        ))
    ) {
      const word = m[1]!;
      const move: CameraMove = /push|dolly in|move in/.test(word)
        ? 'push_in'
        : /pull|back off|move out/.test(word)
          ? 'pull_out'
          : /orbit|circle|around/.test(word)
            ? 'orbit'
            : /up|higher/.test(word)
              ? 'crane_up'
              : /down|lower/.test(word)
                ? 'crane_down'
                : /left/.test(word)
                  ? 'dolly_left'
                  : 'dolly_right';
      const speed = m[2]?.trim();
      acts.push({ op: 'camera', move, duration_ms: speed?.startsWith('slow') ? 3000 : speed ? 600 : 1500 });
    } else if ((m = /^(?:camera |cam |lens )?(\d{2,3}) ?mm(?: lens)?$/.exec(c))) {
      acts.push({ op: 'camera', lens_mm: Number(m[1]) });
    }
    // ── keyframed paths (CAM-7) ──
    else if (/^(?:set|drop|add|mark) (?:a )?(?:key|keyframe|key ?frame|camera key)(?: here)?$|^(?:key|keyframe)(?: here)?$/.test(c)) {
      acts.push({ op: 'camera', path: 'key' });
    } else if (
      (m =
        /^(?:play|run|fly|roll) (?:the )?(?:path|camera path|move)(?: in (\d+(?:\.\d+)?) ?(?:s|sec|seconds?))?( looped| on a loop| looping)?$/.exec(
          c,
        ))
    ) {
      acts.push({ op: 'camera', path: 'play', ...(m[1] ? { path_seconds: Number(m[1]) } : {}), ...(m[2] ? { loop: true } : {}) });
    } else if (/^(?:stop|release|unlock|free) (?:the )?(?:path|camera|camera path)$|^free cam(?:era)?$/.test(c)) {
      acts.push({ op: 'camera', path: 'stop' });
    } else if (/^(?:clear|forget|scrap) (?:the )?(?:path|keys|keyframes|camera path)$/.test(c)) {
      acts.push({ op: 'camera', path: 'clear' });
    } else if (/^(?:drop|remove|undo|delete) (?:the )?last (?:key|keyframe)$/.test(c)) {
      acts.push({ op: 'camera', path: 'undo_key' });
    }
    // ── the world ──
    else if (
      (m = new RegExp(`^(?:put|move|place|drop|set|bring|take|stick) (.+?) ${PLACE_WORDS}$`).exec(c)) &&
      !/^(a|an|another|some) /.test(m[1]!)
    ) {
      const o = obj(m[1]!); // the object comes first in the sentence, so it takes the earlier deictic ordinal
      const p = place(m[2]!);
      if (p) acts.push({ op: 'move', obj: o, place: p });
      else unknown.push(c);
    } else if ((m = /^(?:face|point|aim|turn) (.+?) (?:at|to|toward|towards|to face) (.+)$/.exec(c))) {
      acts.push({ op: 'rotate', obj: obj(m[1]!), face: obj(m[2]!) });
    } else if ((m = /^(?:rotate|turn|spin) (.+?)(?: (\d+)(?: degrees)?| around| left| right)?$/.exec(c))) {
      const yaw = m[2] ? Number(m[2]) : / around$/.test(c) ? 180 : / left$/.test(c) ? 90 : / right$/.test(c) ? -90 : 90;
      acts.push({ op: 'rotate', obj: obj(m[1]!), yaw_deg: yaw });
    } else if (
      (m =
        /^(?:paint|color|colour|tint|make) (.+?) (red|blue|green|yellow|orange|purple|pink|white|black|gold|golden|chrome|silver|candy red|teal|cyan|grey|gray)$/.exec(
          c,
        ))
    ) {
      acts.push({ op: 'set_material', obj: obj(m[1]!), color: m[2] });
    } else if (
      (m =
        /^(?:make|scale) (.+?) (bigger|larger|huge|giant|smaller|tiny|twice as big|double|half(?: the)? size|half|(\d+(?:\.\d+)?)x)$/.exec(
          c,
        ))
    ) {
      const w = m[2]!;
      const factor = m[3]
        ? Number(m[3])
        : /huge|giant/.test(w)
          ? 3
          : /twice|double/.test(w)
            ? 2
            : /bigger|larger/.test(w)
              ? 1.5
              : /tiny/.test(w)
                ? 0.33
                : /half/.test(w)
                  ? 0.5
                  : 0.66;
      acts.push({ op: 'scale', obj: obj(m[1]!), factor });
    } else if ((m = /^(?:delete|remove|kill|get rid of|trash|erase|lose) (.+)$/.exec(c))) {
      acts.push({ op: 'delete', obj: obj(m[1]!) });
    } else if (
      (m = new RegExp(`^(?:spawn|add|create|make|give me|i need|drop|summon) (?:a |an |another |some )?(.+?)(?: ${PLACE_WORDS})?$`).exec(c))
    ) {
      const asset = m[1]!.trim();
      if (/^(that|this|it)\b/.test(asset)) unknown.push(c);
      else {
        const p = m[2] ? place(m[2]) : null;
        acts.push({ op: 'spawn', asset, place: p ?? { relative: { to: { id: 'me' }, rel: 'in_front', distance_m: 2 } } });
      }
    }
    // ── people ──
    else if ((m = /^(?:possess|be|become|switch to|control|play|take over|i'?m|i am|let me be) (.+)$/.exec(c))) {
      acts.push({ op: 'possess', actor: obj(m[1]!) });
    } else if ((m = /^(dance|wave|sit|celebrate|idle|pose|flex|bow|nod)$/.exec(c))) {
      acts.push({ op: 'play_anim', actor: { id: 'me' }, clip: m[1]! });
    } else unknown.push(c);
    parsed.push({ text: c, act: acts.length > before ? acts[acts.length - 1]! : null });
  }
  return { transcript, clauses: parsed, acts, deicticTotal, unknown };
}

function parseMeta(c: string): Meta | null {
  if (/^(yes|yeah|yep|yup|do it|go|go ahead|confirm|ok|okay|sure|that one|this one|that'?s it|exactly|correct)$/.test(c))
    return { kind: 'confirm' };
  if (/^(no|nope|cancel|not that one|not that|wrong one|forget it)$/.test(c)) return { kind: 'cancel' };
  // "the left one", "the closer one", "first one" — never a bare "closer" (that is a camera shot).
  const WORDS = 'first|second|other|left|right|near|nearer|nearest|close|closer|closest|far|farther|farthest|further|furthest';
  const m = new RegExp(`^(?:(?:the|take the|use the) (${WORDS})(?: one)?|(${WORDS}) one)$`).exec(c);
  if (!m) return null;
  const w = (m[1] ?? m[2])!;
  const which = /first/.test(w)
    ? 'first'
    : /second|other/.test(w)
      ? 'second'
      : /left/.test(w)
        ? 'left'
        : /right/.test(w)
          ? 'right'
          : /near|close/.test(w)
            ? 'near'
            : 'far';
  return { kind: 'pick', which };
}

/** The look a spoken name means (`schema.ts` LookName). */
function lookNameFor(word: string): LookName {
  if (word.startsWith('35') || word.startsWith('dusk')) return '35mm-dusk';
  if (word.startsWith('vhs')) return 'vhs-1994';
  if (word === 'noir' || word === 'monochrome' || word === 'mono') return 'noir';
  if (word.startsWith('neon')) return 'neon-night';
  return 'clean';
}
