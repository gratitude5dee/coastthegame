/**
 * NPC behaviours (goal.md PHY-4, CHR/NPC loiter · approach · greet): a small state machine per NPC, pure numbers so
 * it is unit-testable and the same on every tier. The crowd (recast) does the walking; the brain decides *where* and
 * *when*, and emits the moments the game turns into lines and sounds.
 */
export type NpcState = 'idle' | 'loiter' | 'approach' | 'greet';

export interface NpcBrainOptions {
  /** Home position; loiter targets are picked within `loiterRadius` of it. */
  home: [number, number, number];
  loiterRadius?: number;
  /** Pause between loiter walks (s), random in [min, max]. */
  loiterPause?: [number, number];
  /** Start approaching the player when they come within this distance (m). */
  noticeDistance?: number;
  /** Stop approaching at this distance (m). */
  personalSpace?: number;
  /** Greet when the player is inside this distance (m); one greeting per `greetCooldown` s. */
  greetDistance?: number;
  greetCooldown?: number;
  /** How long a greeting holds the NPC in place (s). */
  greetHold?: number;
  /** Whether this NPC walks up to the player (the tutor does; extras only greet in passing). */
  approaches?: boolean;
  /** Seconds before the first greeting is allowed (default 0: greet as soon as the player is close). */
  greetDelay?: number;
  /** Deterministic randomness for tests. */
  random?: () => number;
}

export interface BrainEvent {
  kind: 'moveTo' | 'stop' | 'greet' | 'face';
  target?: [number, number, number];
}

export class NpcBrain {
  state: NpcState = 'idle';
  private timer = 0;
  private sinceGreet = Infinity;
  private target: [number, number, number] | null = null;
  readonly opts: Required<Omit<NpcBrainOptions, 'random'>> & { random: () => number };

  constructor(opts: NpcBrainOptions) {
    this.opts = {
      home: opts.home,
      loiterRadius: opts.loiterRadius ?? 6,
      loiterPause: opts.loiterPause ?? [3, 8],
      noticeDistance: opts.noticeDistance ?? 7,
      personalSpace: opts.personalSpace ?? 1.7,
      greetDistance: opts.greetDistance ?? 3.2,
      greetCooldown: opts.greetCooldown ?? 25,
      greetHold: opts.greetHold ?? 4,
      approaches: opts.approaches ?? false,
      greetDelay: opts.greetDelay ?? 0,
      random: opts.random ?? Math.random,
    };
    this.timer = this.pause();
    this.sinceGreet = this.opts.greetDelay > 0 ? this.opts.greetCooldown - this.opts.greetDelay : Infinity;
  }

  /**
   * Tick with the NPC's own position, the player's position and dt. Returns the events for this frame. `arrived` is
   * whether the crowd reports the last move target reached (or no target).
   */
  update(me: [number, number, number], player: [number, number, number], dt: number, arrived: boolean): BrainEvent[] {
    const out: BrainEvent[] = [];
    const o = this.opts;
    const d = dist(me, player);
    this.sinceGreet += dt;

    // Greeting wins whenever the player is close and the cooldown has passed.
    if (this.state !== 'greet' && d <= o.greetDistance && this.sinceGreet >= o.greetCooldown) {
      this.state = 'greet';
      this.timer = o.greetHold;
      this.sinceGreet = 0;
      this.target = null;
      out.push({ kind: 'stop' }, { kind: 'face', target: player }, { kind: 'greet' });
      return out;
    }

    switch (this.state) {
      case 'greet':
        this.timer -= dt;
        out.push({ kind: 'face', target: player });
        if (this.timer <= 0) {
          this.state = 'idle';
          this.timer = this.pause();
        }
        break;
      case 'approach':
        if (d <= o.personalSpace) {
          this.state = 'idle';
          this.timer = this.pause();
          this.target = null;
          out.push({ kind: 'stop' }, { kind: 'face', target: player });
        } else if (d > o.noticeDistance * 1.5) {
          this.state = 'idle';
          this.timer = this.pause();
          this.target = null;
          out.push({ kind: 'stop' });
        } else if (!this.target || dist(this.target, player) > 1) {
          // Re-aim at the moving player, but not every frame.
          this.target = [player[0], player[1], player[2]];
          out.push({ kind: 'moveTo', target: this.target });
        }
        break;
      case 'loiter':
        if (arrived) {
          this.state = 'idle';
          this.timer = this.pause();
          this.target = null;
        } else if (o.approaches && d <= o.noticeDistance && this.sinceGreet >= o.greetCooldown) {
          this.state = 'approach';
          this.target = null;
        }
        break;
      case 'idle':
        if (o.approaches && d <= o.noticeDistance && d > o.personalSpace && this.sinceGreet >= o.greetCooldown) {
          this.state = 'approach';
          this.target = null;
          break;
        }
        this.timer -= dt;
        if (this.timer <= 0) {
          this.state = 'loiter';
          const a = o.random() * Math.PI * 2;
          const r = Math.sqrt(o.random()) * o.loiterRadius;
          this.target = [o.home[0] + Math.sin(a) * r, o.home[1], o.home[2] + Math.cos(a) * r];
          out.push({ kind: 'moveTo', target: this.target });
        }
        break;
    }
    return out;
  }

  private pause() {
    const [a, b] = this.opts.loiterPause;
    return a + this.opts.random() * (b - a);
  }
}

function dist(a: [number, number, number], b: [number, number, number]) {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}
