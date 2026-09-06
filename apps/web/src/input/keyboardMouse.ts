import * as THREE from 'three';
import type { FrameInput, InputProvider } from './intents';

/**
 * Keyboard + mouse provider. Actor mode uses pointer lock (click the canvas); director/producer use drag-to-look.
 * Wheel zooms the follow distance. Left click = select/place (put-that-there fallback, DIR-3).
 * Driving: WASD throttle/steer, Space hop, Shift handbrake, I/J/K/L hydraulic switches, H hop on the beat, E get out.
 */
export class KeyboardMouseProvider implements InputProvider {
  readonly id = 'kbm';
  private down = new Set<string>();
  private edges = new Set<string>();
  private lookDx = 0;
  private lookDy = 0;
  private wheel = 0;
  private dragging = false;
  private clickEdge = false;
  private buttonDown = false;
  private pointerNdc = new THREE.Vector2();
  private hasPointer = false;
  private wantLock = false;
  private movedWhileDown = 0;
  sensitivity = 0.0022;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('blur', () => {
      this.down.clear();
      this.buttonDown = false;
    });
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== canvas) this.wantLock = false;
    });
  }

  /** The game calls this when the mode changes: actor mode wants pointer lock on the next click. */
  setPointerLockDesired(v: boolean) {
    this.wantLock = v;
    if (!v && document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  poll(_dt: number, out: FrameInput) {
    const d = this.down;
    let x = 0;
    let y = 0;
    if (d.has('KeyW') || d.has('ArrowUp')) y += 1;
    if (d.has('KeyS') || d.has('ArrowDown')) y -= 1;
    if (d.has('KeyD') || d.has('ArrowRight')) x += 1;
    if (d.has('KeyA') || d.has('ArrowLeft')) x -= 1;
    out.move.x += x;
    out.move.y += y;
    out.sprint = out.sprint || d.has('ShiftLeft') || d.has('ShiftRight');
    out.jump = out.jump || this.edges.has('Space');
    out.interact = out.interact || this.edges.has('KeyE');
    out.throwEdge = out.throwEdge || this.edges.has('KeyF');
    out.cancel = out.cancel || this.edges.has('Escape');
    out.undo = out.undo || this.edges.has('KeyZ');
    out.modeCycle = out.modeCycle || this.edges.has('Tab');
    out.timeCycle = out.timeCycle || this.edges.has('KeyT');
    out.debugToggle = out.debugToggle || this.edges.has('KeyC');
    out.resetEdge = out.resetEdge || this.edges.has('KeyR');
    out.action = out.action || this.edges.has('Enter') || this.edges.has('NumpadEnter');
    out.playback = out.playback || this.edges.has('KeyP');
    out.beatToggle = out.beatToggle || this.edges.has('KeyH');
    // Hydraulic switchbox (held): I front, K back, J left, L right.
    if (d.has('KeyI')) out.hydro.y += 1;
    if (d.has('KeyK')) out.hydro.y -= 1;
    if (d.has('KeyJ')) out.hydro.x -= 1;
    if (d.has('KeyL')) out.hydro.x += 1;
    for (let i = 1; i <= 4; i++) if (this.edges.has(`Digit${i}`)) out.sceneKey = i;

    const locked = document.pointerLockElement === this.canvas;
    out.pointerLocked = out.pointerLocked || locked;
    if (locked || this.dragging) {
      out.look.x += this.lookDx * this.sensitivity;
      out.look.y += this.lookDy * this.sensitivity;
    }
    if (this.wheel !== 0) out.zoom *= Math.exp(this.wheel * 0.0015);
    if (this.clickEdge) out.select = true;
    out.primaryHeld = out.primaryHeld || this.buttonDown;
    if (this.hasPointer) out.pointer = this.pointerNdc.clone();

    this.lookDx = this.lookDy = this.wheel = 0;
    this.clickEdge = false;
    this.edges.clear();
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Tab') e.preventDefault();
    if (!e.repeat) this.edges.add(e.code);
    this.down.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => this.down.delete(e.code);

  private onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return; // touch provider owns touch
    if (e.button !== 0) return;
    this.buttonDown = true;
    this.updateNdc(e);
    if (this.wantLock && document.pointerLockElement !== this.canvas) {
      this.canvas.requestPointerLock?.();
      this.clickEdge = true; // a click in actor mode still selects what's under the crosshair
      return;
    }
    this.dragging = true;
    this.movedWhileDown = 0;
  };
  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    this.updateNdc(e);
    if (document.pointerLockElement === this.canvas) {
      this.lookDx += e.movementX;
      this.lookDy += e.movementY;
    } else if (this.dragging) {
      this.lookDx += e.movementX;
      this.lookDy += e.movementY;
      this.movedWhileDown += Math.abs(e.movementX) + Math.abs(e.movementY);
    }
  };
  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (e.button === 0) this.buttonDown = false;
    if (this.dragging) {
      this.dragging = false;
      if (this.movedWhileDown < 6) this.clickEdge = true; // a click, not a drag
    }
  };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.wheel += e.deltaY;
  };
  private updateNdc(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    this.pointerNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.hasPointer = true;
  }
}
