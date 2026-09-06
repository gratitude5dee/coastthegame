import type { FrameInput, InputProvider } from './intents';

/** Gamepad provider (standard mapping): left stick move, right stick look, A jump, X grab, B throw, Y mode, LB sprint, RB undo. */
export class GamepadProvider implements InputProvider {
  readonly id = 'gamepad';
  private prev = new Map<number, boolean>();
  deadzone = 0.15;
  lookSpeed = 2.4; // rad/s at full deflection

  poll(dt: number, out: FrameInput) {
    const pads = navigator.getGamepads?.() ?? [];
    const gp = pads.find((p) => p && p.connected);
    if (!gp) return;
    const dz = (v: number) => (Math.abs(v) < this.deadzone ? 0 : v);
    out.move.x += dz(gp.axes[0] ?? 0);
    out.move.y += -dz(gp.axes[1] ?? 0);
    out.look.x += dz(gp.axes[2] ?? 0) * this.lookSpeed * dt;
    out.look.y += dz(gp.axes[3] ?? 0) * this.lookSpeed * dt;
    const pressed = (i: number) => !!gp.buttons[i]?.pressed;
    const edge = (i: number) => {
      const now = pressed(i);
      const was = this.prev.get(i) ?? false;
      this.prev.set(i, now);
      return now && !was;
    };
    if (edge(0)) out.jump = true; // A
    if (edge(2)) out.interact = true; // X
    if (edge(1)) out.throwEdge = true; // B
    if (edge(3)) out.modeCycle = true; // Y
    if (edge(5)) out.undo = true; // RB
    out.sprint = out.sprint || pressed(4); // LB
  }

  dispose() {}
}
