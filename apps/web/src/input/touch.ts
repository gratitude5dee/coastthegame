import * as THREE from 'three';
import type { FrameInput, InputProvider } from './intents';

/**
 * Touch provider (goal.md INP-2, iPhone tier): left half = virtual move stick, right half = look drag,
 * tap (short, no drag) = select/place, on-screen buttons for action / jump / grab / mode. Pattern from Spark's
 * mobile-joystick example. While driving (`setDriving(true)`, PHY-3 "touch: on-screen pedals") the stick is
 * throttle/steer, JUMP reads HOP, GRAB reads EXIT, and two more buttons appear: LIFT (hold = front up) and BEAT.
 */
export class TouchProvider implements InputProvider {
  readonly id = 'touch';
  private moveId: number | null = null;
  private moveOrigin = new THREE.Vector2();
  private moveVec = new THREE.Vector2();
  private lookId: number | null = null;
  private lookLast = new THREE.Vector2();
  private lookDelta = new THREE.Vector2();
  private lookMoved = 0;
  private tapNdc: THREE.Vector2 | null = null;
  private edges = new Set<string>();
  private held = new Set<string>();
  private driving = false;
  private root: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  readonly isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  sensitivity = 0.005;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.root = document.createElement('div');
    this.root.id = 'touch-ui';
    this.root.style.cssText = 'position:fixed;inset:0;pointer-events:none;display:none;font-family:system-ui,sans-serif;';
    this.root.innerHTML = `
      <div id="stick-base" style="position:absolute;left:24px;bottom:96px;width:120px;height:120px;border-radius:50%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.25);display:none">
        <div id="stick-knob" style="position:absolute;left:35px;top:35px;width:50px;height:50px;border-radius:50%;background:rgba(255,181,74,.6)"></div>
      </div>
      <div id="touch-buttons" style="position:absolute;right:20px;bottom:100px;display:flex;flex-direction:column;gap:12px;pointer-events:auto">
        ${btn('action', 'ACTION')}${btn('jump', 'JUMP')}${btn('grab', 'GRAB')}${btn('mode', 'MODE')}${btn('possess', 'BE')}${btn('say', 'SAY')}
      </div>
      <div id="touch-drive" style="position:absolute;right:96px;bottom:100px;display:none;flex-direction:column;gap:12px;pointer-events:auto">
        ${btn('lift', 'LIFT')}${btn('beat', 'BEAT')}
      </div>`;
    document.body.appendChild(this.root);
    this.stickBase = this.root.querySelector('#stick-base')!;
    this.stickKnob = this.root.querySelector('#stick-knob')!;
    if (this.isTouchDevice) this.root.style.display = 'block';
    for (const [id, edge] of [
      ['action', 'action'],
      ['jump', 'jump'],
      ['grab', 'interact'],
      ['mode', 'modeCycle'],
      ['beat', 'beatToggle'],
      ['possess', 'possess'],
      ['say', 'say'],
    ] as const) {
      this.root.querySelector(`#btn-${id}`)!.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.edges.add(edge);
      });
    }
    const lift = this.root.querySelector('#btn-lift')!;
    const liftOn = (e: Event) => {
      e.preventDefault();
      this.held.add('lift');
    };
    const liftOff = () => this.held.delete('lift');
    lift.addEventListener('pointerdown', liftOn);
    lift.addEventListener('pointerup', liftOff);
    lift.addEventListener('pointercancel', liftOff);
    lift.addEventListener('pointerleave', liftOff);
    canvas.addEventListener('touchstart', this.onStart, { passive: false });
    canvas.addEventListener('touchmove', this.onMove, { passive: false });
    canvas.addEventListener('touchend', this.onEnd, { passive: false });
    canvas.addEventListener('touchcancel', this.onEnd, { passive: false });
  }

  /** Relabel the buttons for the lowrider (PHY-3): JUMP→HOP, GRAB→EXIT, plus LIFT / BEAT. */
  setDriving(v: boolean) {
    if (v === this.driving) return;
    this.driving = v;
    this.root.querySelector('#btn-jump')!.textContent = v ? 'HOP' : 'JUMP';
    this.root.querySelector('#btn-grab')!.textContent = v ? 'EXIT' : 'GRAB';
    (this.root.querySelector('#touch-drive') as HTMLElement).style.display = v ? 'flex' : 'none';
    if (!v) this.held.clear();
  }

  poll(_dt: number, out: FrameInput) {
    if (this.moveId !== null) {
      out.move.x += this.moveVec.x;
      out.move.y += this.moveVec.y;
      if (!this.driving) out.sprint = out.sprint || this.moveVec.length() > 0.92; // full deflection = run (never brake)
    }
    if (this.held.has('lift')) out.hydro.y += 1;
    out.look.x += this.lookDelta.x * this.sensitivity;
    out.look.y += this.lookDelta.y * this.sensitivity;
    this.lookDelta.set(0, 0);
    if (this.tapNdc) {
      out.select = true;
      out.pointer = this.tapNdc;
      this.tapNdc = null;
    }
    if (this.edges.has('jump')) out.jump = true;
    if (this.edges.has('interact')) out.interact = true;
    if (this.edges.has('modeCycle')) out.modeCycle = true;
    if (this.edges.has('action')) out.action = true;
    if (this.edges.has('beatToggle')) out.beatToggle = true;
    if (this.edges.has('possess')) out.possess = true;
    if (this.edges.has('say')) out.say = true;
    this.edges.clear();
  }

  dispose() {
    this.root.remove();
    this.canvas.removeEventListener('touchstart', this.onStart);
    this.canvas.removeEventListener('touchmove', this.onMove);
    this.canvas.removeEventListener('touchend', this.onEnd);
    this.canvas.removeEventListener('touchcancel', this.onEnd);
  }

  private onStart = (e: TouchEvent) => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < innerWidth * 0.45 && this.moveId === null) {
        this.moveId = t.identifier;
        this.moveOrigin.set(t.clientX, t.clientY);
        this.moveVec.set(0, 0);
        this.stickBase.style.display = 'block';
        this.stickBase.style.left = `${t.clientX - 60}px`;
        this.stickBase.style.top = `${t.clientY - 60}px`;
        this.stickBase.style.bottom = 'auto';
      } else if (this.lookId === null) {
        this.lookId = t.identifier;
        this.lookLast.set(t.clientX, t.clientY);
        this.lookMoved = 0;
      }
    }
  };
  private onMove = (e: TouchEvent) => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.moveId) {
        const dx = t.clientX - this.moveOrigin.x;
        const dy = t.clientY - this.moveOrigin.y;
        const r = 50;
        const len = Math.hypot(dx, dy);
        const k = len > r ? r / len : 1;
        this.moveVec.set((dx * k) / r, (-dy * k) / r);
        this.stickKnob.style.left = `${35 + dx * k}px`;
        this.stickKnob.style.top = `${35 + dy * k}px`;
      } else if (t.identifier === this.lookId) {
        const dx = t.clientX - this.lookLast.x;
        const dy = t.clientY - this.lookLast.y;
        this.lookLast.set(t.clientX, t.clientY);
        this.lookDelta.x += dx;
        this.lookDelta.y += dy;
        this.lookMoved += Math.abs(dx) + Math.abs(dy);
      }
    }
  };
  private onEnd = (e: TouchEvent) => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.moveId) {
        this.moveId = null;
        this.moveVec.set(0, 0);
        this.stickBase.style.display = 'none';
        this.stickKnob.style.left = '35px';
        this.stickKnob.style.top = '35px';
      } else if (t.identifier === this.lookId) {
        if (this.lookMoved < 10) {
          const r = this.canvas.getBoundingClientRect();
          this.tapNdc = new THREE.Vector2(((t.clientX - r.left) / r.width) * 2 - 1, -((t.clientY - r.top) / r.height) * 2 + 1);
        }
        this.lookId = null;
      }
    }
  };
}

function btn(id: string, label: string) {
  return `<button id="btn-${id}" style="width:64px;height:64px;border-radius:50%;border:1px solid rgba(255,255,255,.35);background:rgba(11,10,16,.55);color:#f2ecdc;font:600 11px system-ui;letter-spacing:.06em;touch-action:none">${label}</button>`;
}
