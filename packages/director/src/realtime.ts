/**
 * The Realtime voice director (goal.md DIR-1, DIR-2, DIR-6): the OpenAI Realtime session's event stream in, scene
 * acts out. Transport-agnostic — the browser feeds it a WebRTC data channel (apps/web), tests feed it recorded
 * transcripts (`FakeRealtime`, tests/fixtures/realtime) — so the voice suite costs $0 per PR.
 *
 * What it does with the stream:
 *  - on open: `session.update` with the instructions, the scene summary and ONLY the active mode's tools (CAM-8);
 *  - `input_audio_buffer.speech_started/stopped` stamp the speech window the deixis resolver pairs words with;
 *  - `conversation.item.input_audio_transcription.completed` gives the transcript (deictic words are counted here —
 *    the model never supplies timestamps or ordinals it invents; the count keys the pairing);
 *  - a completed function call becomes an `ActEnvelope` keyed by its `call_id` (idempotent) and runs through the
 *    executor; the `ActResult` goes back as `function_call_output` and a `response.create` lets the model speak it;
 *  - query tools answer from the scene without touching it.
 */
import type { DeixisBuffer } from '@coast/engine';
import { resolveObject } from './deixis';
import type { ActExecutor, SceneOps } from './executor';
import { ALL_TOOL_NAMES, toRealtimeTools, type ActEnvelope, type ActResult, type ObjectRef, type RigMode, type SceneAct } from './schema';

export interface RealtimeTransport {
  send(event: Record<string, unknown>): void;
  close(): void;
}

export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export type RealtimeState = 'idle' | 'connecting' | 'ready' | 'listening' | 'thinking' | 'closed' | 'error';

export interface RealtimeClientOptions {
  executor: ActExecutor;
  ops: SceneOps;
  buffer: DeixisBuffer;
  mode: () => RigMode;
  speakerForward: () => [number, number];
  /** Scene summary JSON (≤ 2 KB) for the model's context; refreshed on `refreshScene()`. */
  sceneSummary?: () => unknown;
  /** The active mission brief, if any. */
  missionBrief?: () => string | null;
  now?: () => number;
  onTranscript?: (text: string, speech: { startMs: number; endMs: number }) => void;
  onAssistant?: (text: string) => void;
  onAct?: (env: ActEnvelope, result: ActResult) => void;
  onState?: (state: RealtimeState, detail?: string) => void;
}

/** What the model is told (DIR-4 in one breath; the grammar doc is longer, the model is not). */
export const DIRECTOR_INSTRUCTIONS = `You are the director's assistant on the set of "$COAST the Game", a film studio inside a video game.
The player speaks film-set directions; you turn each one into tool calls and say back, in a few words, what happened.
Vocabulary: shots (wide, medium, close, low, high, dutch), camera moves (push in, pull out, orbit, crane up/down, dolly left/right), follow / look at,
world edits (put that there, move/rotate/scale/delete/paint, spawn), light (golden hour, blue hour, night, noon, fog), people (be / possess <name>),
studio (action, cut, take two, playback, mark beat, undo). Objects and places may be pointed at: pass deictic words exactly as spoken
({deictic:"that"|"this"|"it"|"there"|"here", ordinal}) — the ordinal is that word's 1-based position among ALL deictic words in the utterance.
Never invent ids, positions or timestamps; use query_scene / resolve_ref when unsure, and prefer asking a one-word question over guessing.
Be brief: one short sentence, no lists.`;

const DEICTIC = /\b(that|this|it|there|here)\b/g;
const QUERY_TOOLS = new Set(['query_scene', 'resolve_ref', 'get_shot_state', 'list_assets']);
const ASSETS = ['crate', 'box', 'cone', 'can', 'spray can', 'ball', 'barrel'];

interface FunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export class RealtimeClient {
  state: RealtimeState = 'idle';
  private transport: RealtimeTransport | null = null;
  private speechStartMs = 0;
  private speechEndMs = 0;
  private lastTranscript = '';
  private deicticTotal = 0;
  private activeMode: RigMode | null = null;
  private readonly seen = new Set<string>();
  /** Every tool call handled, oldest first (the session's act log). */
  readonly acts: { env: ActEnvelope; result: ActResult }[] = [];
  private readonly now: () => number;

  constructor(private readonly opts: RealtimeClientOptions) {
    this.now = opts.now ?? (() => performance.now());
  }

  /** The data channel is open: configure the session for the active mode. */
  attach(transport: RealtimeTransport) {
    this.transport = transport;
    this.set('connecting');
    this.sendSession();
  }

  /** The mode changed (CAM-8): expose only its tools. */
  refreshTools() {
    if (this.transport && this.activeMode !== this.opts.mode()) this.sendSession();
  }

  /** The scene changed enough to be worth telling the model (a spawn, a mission brief). */
  refreshScene() {
    if (this.transport) this.sendSession();
  }

  close() {
    this.transport?.close();
    this.transport = null;
    this.set('closed');
  }

  /** One event from the wire (or a fixture). Returns true when it was one we act on. */
  handle(ev: RealtimeEvent): boolean {
    switch (ev.type) {
      case 'session.created':
      case 'session.updated':
        if (this.state === 'connecting') this.set('ready');
        return true;
      case 'input_audio_buffer.speech_started':
        this.speechStartMs = this.now();
        this.speechEndMs = 0;
        this.set('listening');
        return true;
      case 'input_audio_buffer.speech_stopped':
        this.speechEndMs = this.now();
        this.set('thinking');
        return true;
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(ev.transcript ?? '').trim();
        this.lastTranscript = text;
        this.deicticTotal = (text.toLowerCase().match(DEICTIC) ?? []).length;
        if (!this.speechEndMs) this.speechEndMs = this.now();
        this.opts.onTranscript?.(text, { startMs: this.speechStartMs, endMs: this.speechEndMs });
        return true;
      }
      case 'response.output_item.done': {
        const item = ev.item as Partial<FunctionCallItem> | undefined;
        if (item?.type === 'function_call' && item.call_id && item.name) {
          this.onToolCall({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments ?? '{}' });
          return true;
        }
        return false;
      }
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
      case 'response.output_text.done':
      case 'response.text.done': {
        const text = String(ev.transcript ?? ev.text ?? '').trim();
        if (text) this.opts.onAssistant?.(text);
        return true;
      }
      case 'response.done':
        if (this.state === 'thinking') this.set('ready');
        return true;
      case 'error': {
        const err = ev.error as { message?: string } | undefined;
        this.set('error', err?.message ?? 'realtime error');
        return true;
      }
      default:
        return false;
    }
  }

  // ── internals ──

  private sendSession() {
    const mode = this.opts.mode();
    this.activeMode = mode;
    const brief = this.opts.missionBrief?.();
    const scene = this.opts.sceneSummary?.();
    const instructions =
      DIRECTOR_INSTRUCTIONS +
      `\nPerspective now: ${mode}.` +
      (brief ? `\nMission: ${brief}` : '') +
      (scene !== undefined ? `\nScene: ${JSON.stringify(scene).slice(0, 2048)}` : '');
    this.transport?.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions,
        tools: toRealtimeTools(mode),
        tool_choice: 'auto',
        audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' }, turn_detection: { type: 'server_vad' } } },
      },
    });
  }

  private onToolCall(call: FunctionCallItem) {
    if (this.seen.has(call.call_id)) return; // idempotent: Realtime may redeliver
    this.seen.add(call.call_id);
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
    } catch {
      this.reply(call.call_id, { ok: false, affected: [], confidence: 0, error: 'arguments were not JSON' });
      return;
    }
    if (QUERY_TOOLS.has(call.name)) {
      this.reply(call.call_id, this.query(call.name, args));
      return;
    }
    if (!ALL_TOOL_NAMES.includes(call.name)) {
      this.reply(call.call_id, { ok: false, affected: [], confidence: 0, error: `unknown tool ${call.name}` });
      return;
    }
    const act = { op: call.name, ...args } as SceneAct;
    const env: ActEnvelope = {
      callId: call.call_id,
      mode: this.opts.mode(),
      speech: { startMs: this.speechStartMs, endMs: this.speechEndMs || this.now() },
      deicticTotal: this.deicticTotal,
      act,
    };
    let result: ActResult;
    try {
      result = this.opts.executor.execute(env, this.opts.buffer, this.opts.speakerForward());
    } catch (e) {
      result = { ok: false, affected: [], confidence: 0, error: e instanceof Error ? e.message : String(e) };
    }
    this.acts.push({ env, result });
    this.opts.onAct?.(env, result);
    this.reply(call.call_id, result);
  }

  private query(name: string, args: Record<string, unknown>): ActResult & { data?: unknown } {
    const ops = this.opts.ops;
    switch (name) {
      case 'query_scene': {
        const ids = ops.byDescription(String(args.filter ?? ''));
        return { ok: true, affected: ids, confidence: 1, data: ids.map((id) => ({ id, pos: ops.positionOf(id) })) };
      }
      case 'resolve_ref': {
        const r = resolveObject((args.ref ?? {}) as ObjectRef, {
          buffer: this.opts.buffer,
          scene: ops,
          speech: { startMs: this.speechStartMs, endMs: this.speechEndMs || this.now() },
          deicticTotal: this.deicticTotal,
          speakerForward: this.opts.speakerForward(),
          speakerId: 'me',
          ...(this.opts.executor.lastMentioned ? { lastMentioned: this.opts.executor.lastMentioned } : {}),
        });
        return { ok: !!r.value, affected: r.candidates, confidence: r.confidence, ...(r.question ? { question: r.question } : {}) };
      }
      case 'get_shot_state':
        return {
          ok: true,
          affected: [],
          confidence: 1,
          data: { mode: this.opts.mode(), transcript: this.lastTranscript, scene: this.opts.sceneSummary?.() ?? null },
        };
      case 'list_assets': {
        const q = String(args.query ?? '').toLowerCase();
        return { ok: true, affected: [], confidence: 1, data: ASSETS.filter((a) => !q || a.includes(q)) };
      }
      default:
        return { ok: false, affected: [], confidence: 0, error: `unknown query ${name}` };
    }
  }

  private reply(callId: string, result: ActResult & { data?: unknown }) {
    this.transport?.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
    });
    this.transport?.send({ type: 'response.create' });
  }

  private set(state: RealtimeState, detail?: string) {
    this.state = state;
    this.opts.onState?.(state, detail);
  }
}

/**
 * Replays a recorded event transcript into a client (tests, DIR-6). Events carry an optional `at` (ms from start)
 * used as the clock, so speech windows come out exactly as recorded.
 */
export interface FakeRealtimeEvent extends RealtimeEvent {
  at?: number;
}

export class FakeRealtime implements RealtimeTransport {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  private clock = 0;

  send(event: Record<string, unknown>) {
    this.sent.push(event);
  }

  close() {
    this.closed = true;
  }

  /** The clock the client should use (`now`): the `at` of the event being replayed. */
  now = () => this.clock;

  /** Feed a transcript, in order; returns how many events the client acted on. */
  replay(client: RealtimeClient, events: FakeRealtimeEvent[]): number {
    let handled = 0;
    for (const ev of events) {
      if (typeof ev.at === 'number') this.clock = ev.at;
      if (client.handle(ev)) handled++;
    }
    return handled;
  }
}
