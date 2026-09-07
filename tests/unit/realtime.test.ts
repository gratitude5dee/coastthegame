import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeixisBuffer } from '../../packages/engine/src/intents/intents';
import { ActExecutor, type SceneOps } from '../../packages/director/src/executor';
import { FakeRealtime, RealtimeClient, type FakeRealtimeEvent } from '../../packages/director/src/realtime';
import { TOOL_MODES } from '../../packages/director/src/schema';

/**
 * goal.md DIR-1/DIR-2/DIR-6: the Realtime event stream drives the same executor as the typed grammar. `FakeRealtime`
 * replays a recorded transcript (no audio, $0), the clicks it carries land in the deixis buffer at their times.
 */
function scene() {
  const log: string[] = [];
  const positions = new Map<string, [number, number, number]>([
    ['crate_1', [2, 0, -3]],
    ['crate_2', [8, 0, -3]],
    ['lowrider', [6, 0, 2]],
    ['me', [0, 0, 0]],
  ]);
  const ops: SceneOps = {
    byDescription: (d) => (/car|lowrider/.test(d) ? ['lowrider'] : /crate/.test(d) ? ['crate_1', 'crate_2'] : []),
    positionOf: (id) => positions.get(id),
    radiusOf: () => 0.5,
    move: (id, pos) => (log.push(`move ${id} → ${pos.join(',')}`), true),
    rotate: () => false,
    scale: () => false,
    remove: () => false,
    setMaterial: () => false,
    spawn: () => null,
    setTime: () => true,
    setWeather: () => false,
    setLook: () => false,
    setLoadout: () => 'nothing unlocked yet',
    possess: () => false,
    playAnim: () => false,
    replay: () => false,
    record: () => false,
    markBeat: () => false,
    undo: () => 0,
    camera: (r) => (log.push(`camera ${JSON.stringify(r)}`), true),
    setMode: () => true,
  };
  return { ops, log };
}

interface Fixture {
  clicks: { at: number; pointerHit?: string; groundPoint?: [number, number, number] }[];
  events: FakeRealtimeEvent[];
}

describe('RealtimeClient over FakeRealtime', () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/realtime/camera-low-follow-car.json'), 'utf8')) as Fixture;

  it('configures the session for the mode, runs tool calls through the executor with the recorded speech windows, replies per call', () => {
    const { ops, log } = scene();
    const buffer = new DeixisBuffer();
    const transport = new FakeRealtime();
    const transcripts: string[] = [];
    const spoken: string[] = [];
    const states: string[] = [];
    const client = new RealtimeClient({
      executor: new ActExecutor(ops),
      ops,
      buffer,
      mode: () => 'director',
      speakerForward: () => [0, -1],
      sceneSummary: () => ({ props: ['crate_1', 'crate_2'], car: 'lowrider' }),
      missionBrief: () => 'Low & slow: a low angle on the crate',
      now: transport.now,
      onTranscript: (t) => transcripts.push(t),
      onAssistant: (t) => spoken.push(t),
      onState: (s) => states.push(s),
    });
    client.attach(transport);
    const update = transport.sent[0] as { type: string; session: { tools: { name: string }[]; instructions: string } };
    expect(update.type).toBe('session.update');
    expect(update.session.instructions).toContain('Perspective now: director');
    expect(update.session.instructions).toContain('Low & slow');
    expect(update.session.instructions).toContain('"car":"lowrider"');
    const names = update.session.tools.map((t) => t.name);
    expect(names).toContain('camera');
    expect(names).toContain('move');
    expect(names).not.toContain('scale'); // producer-only (CAM-8)
    for (const n of names) expect(TOOL_MODES[n]).toContain('director');

    // The clicks the fixture recorded land in the buffer at their times, interleaved with the events by `at`.
    const events = [...fixture.events];
    const clicks = [...fixture.clicks];
    const merged: (FakeRealtimeEvent | { click: Fixture['clicks'][number] })[] = [];
    while (events.length || clicks.length) {
      const e = events[0];
      const c = clicks[0];
      if (c && (!e || c.at <= (e.at ?? 0))) {
        merged.push({ click: clicks.shift()! });
      } else merged.push(events.shift()!);
    }
    let handled = 0;
    for (const m of merged) {
      if ('click' in m) {
        buffer.push({
          t: m.click.at,
          clickEdge: true,
          ...(m.click.pointerHit ? { pointerHit: m.click.pointerHit } : {}),
          ...(m.click.groundPoint ? { groundPoint: m.click.groundPoint } : {}),
        });
      } else handled += transport.replay(client, [m]);
    }
    expect(handled).toBeGreaterThan(10);
    expect(transcripts).toEqual(['Camera low, follow the car.', 'Put that there.', 'What crates are there?']);
    expect(spoken).toEqual(['Low and on the car.', 'Done.', 'Two crates.']);
    expect(log).toEqual(['camera {"shot":"low"}', 'camera {"followId":"lowrider"}', 'move crate_1 → 5,0,-6']);
    // call_2 was delivered twice: acted on once (idempotent by call_id).
    expect(client.acts.map((a) => a.env.callId)).toEqual(['call_1', 'call_2', 'call_3']);
    expect(client.acts[2]!.env.speech).toEqual({ startMs: 5000, endMs: 7000 });
    expect(client.acts[2]!.env.deicticTotal).toBe(2);
    // Every call got a function_call_output and a response.create; the query answered with data, not an act.
    const outputs = transport.sent.filter((s) => s.type === 'conversation.item.create') as { item: { call_id: string; output: string } }[];
    expect(outputs.map((o) => o.item.call_id)).toEqual(['call_1', 'call_2', 'call_3', 'call_4', 'call_5']);
    const q = JSON.parse(outputs[3]!.item.output) as { ok: boolean; data: { id: string }[] };
    expect(q.ok).toBe(true);
    expect(q.data.map((d) => d.id)).toEqual(['crate_1', 'crate_2']);
    expect(JSON.parse(outputs[4]!.item.output).error).toMatch(/unknown tool teleport_player/); // refused, never executed
    expect(transport.sent.filter((s) => s.type === 'response.create')).toHaveLength(5);
    expect(states).toEqual([
      'connecting',
      'ready',
      'listening',
      'thinking',
      'ready',
      'listening',
      'thinking',
      'ready',
      'listening',
      'thinking',
      'ready',
    ]);
    client.close();
    expect(transport.closed).toBe(true);
    expect(client.state).toBe('closed');
  });

  it('re-sends the session when the mode changes, and only then', () => {
    const { ops } = scene();
    let mode: 'director' | 'producer' = 'director';
    const transport = new FakeRealtime();
    const client = new RealtimeClient({
      executor: new ActExecutor(ops),
      ops,
      buffer: new DeixisBuffer(),
      mode: () => mode,
      speakerForward: () => [0, -1],
      now: transport.now,
    });
    client.attach(transport);
    client.refreshTools();
    expect(transport.sent).toHaveLength(1);
    mode = 'producer';
    client.refreshTools();
    expect(transport.sent).toHaveLength(2);
    const tools = (transport.sent[1] as { session: { tools: { name: string }[] } }).session.tools.map((t) => t.name);
    expect(tools).toContain('scale');
    expect(tools).not.toContain('camera');
  });
});
