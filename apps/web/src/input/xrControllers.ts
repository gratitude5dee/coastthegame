/**
 * WebXR controller provider (goal.md INP-2, CAM-4): reads the session's `xr-standard` gamepads every frame and writes
 * FrameInput like any other provider — gameplay never sees XR. Left stick moves (head-relative; throttle/steer in the
 * car), right stick snap-turns and arms the teleport (hydraulic switchbox in the car); A hops/jumps, B cycles the rig,
 * X grabs / gets in, Y is action, triggers select along the controller ray, left squeeze sprints/brakes, right squeeze
 * throws, left stick press toggles hop-on-the-beat, right stick press undoes.
 *
 * Controller target-ray poses come from three's `renderer.xr.getController(i)` groups, parented to the localFrame so
 * their world matrices are in game space.
 */
import * as THREE from 'three';
import { SnapTurn, TeleportArm } from '@coast/engine';
import type { FrameInput, InputProvider } from './intents';

type Hand = 'left' | 'right';

export class XrControllerProvider implements InputProvider {
  readonly id = 'xr';
  readonly controllers: Record<Hand, THREE.Group | null> = { left: null, right: null };
  private readonly grips: THREE.Group[] = [];
  private prev = new Map<string, boolean>();
  private readonly snap = new SnapTurn(Math.PI / 6);
  private readonly tele = new TeleportArm();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpDir = new THREE.Vector3();
  private readonly ray = new THREE.Ray();
  deadzone = 0.15;
  /** True while the car owns the sticks (the game sets this). */
  driving = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    frame: THREE.Object3D,
  ) {
    for (let i = 0; i < 2; i++) {
      const c = renderer.xr.getController(i);
      c.addEventListener('connected', (e) => {
        const src = (e as unknown as { data?: XRInputSource }).data;
        if (src?.handedness === 'left' || src?.handedness === 'right') this.controllers[src.handedness] = c;
      });
      c.addEventListener('disconnected', () => {
        for (const h of ['left', 'right'] as const) if (this.controllers[h] === c) this.controllers[h] = null;
      });
      frame.add(c);
      this.grips.push(c);
    }
  }

  get active() {
    return this.renderer.xr.isPresenting;
  }

  poll(_dt: number, out: FrameInput) {
    const session = this.renderer.xr.getSession();
    if (!session || !this.renderer.xr.isPresenting) return;
    const pads: Partial<Record<Hand, Gamepad>> = {};
    for (const src of session.inputSources) {
      if (src.gamepad && (src.handedness === 'left' || src.handedness === 'right')) pads[src.handedness] = src.gamepad;
    }
    const dz = (v: number) => (Math.abs(v) < this.deadzone ? 0 : v);
    const edge = (key: string, now: boolean) => {
      const was = this.prev.get(key) ?? false;
      this.prev.set(key, now);
      return now && !was;
    };
    const pressed = (g: Gamepad | undefined, i: number) => !!g?.buttons[i]?.pressed;

    const L = pads.left;
    const R = pads.right;
    if (L) {
      const x = dz(L.axes[2] ?? 0);
      const y = dz(L.axes[3] ?? 0);
      out.move.x += x;
      out.move.y += -y; // stick forward = −y
      out.sprint = out.sprint || pressed(L, 1);
      if (edge('L4', pressed(L, 4))) out.interact = true; // X
      if (edge('L5', pressed(L, 5))) out.action = true; // Y
      if (edge('L3', pressed(L, 3))) out.beatToggle = true;
      if (edge('L0', pressed(L, 0))) out.select = true; // trigger
      out.primaryHeld = out.primaryHeld || pressed(L, 0);
    }
    if (R) {
      const x = dz(R.axes[2] ?? 0);
      const y = dz(R.axes[3] ?? 0);
      if (this.driving) {
        out.hydro.x += x;
        out.hydro.y += -y;
        this.tele.cancel();
      } else {
        out.snapTurn += this.snap.update(x);
        out.teleport = this.tele.update(y);
      }
      if (edge('R4', pressed(R, 4))) out.jump = true; // A
      if (edge('R5', pressed(R, 5))) out.modeCycle = true; // B
      if (edge('R0', pressed(R, 0))) out.select = true; // trigger
      out.primaryHeld = out.primaryHeld || pressed(R, 0);
      if (edge('R1', pressed(R, 1))) out.throwEdge = true; // squeeze
      if (edge('R3', pressed(R, 3))) out.undo = true;
    }
    out.pointerRay = this.pointerRay('right') ?? this.pointerRay('left') ?? this.headRay();
    out.xrPresenting = true;
  }

  /** World-space target ray of a controller (null when it has no pose yet). */
  pointerRay(hand: Hand): THREE.Ray | null {
    const c = this.controllers[hand];
    if (!c) return null;
    c.updateWorldMatrix(true, false);
    c.matrixWorld.decompose(this.tmpPos, this.tmpQ, this.tmpDir);
    this.tmpDir.set(0, 0, -1).applyQuaternion(this.tmpQ);
    return this.ray.set(this.tmpPos, this.tmpDir).clone();
  }

  private headRay(): THREE.Ray | null {
    const cam = this.renderer.xr.getCamera();
    cam.updateWorldMatrix(true, false);
    cam.matrixWorld.decompose(this.tmpPos, this.tmpQ, this.tmpDir);
    this.tmpDir.set(0, 0, -1).applyQuaternion(this.tmpQ);
    return this.ray.set(this.tmpPos, this.tmpDir).clone();
  }

  dispose() {
    for (const g of this.grips) g.removeFromParent();
  }
}
