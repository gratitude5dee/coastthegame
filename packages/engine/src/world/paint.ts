/**
 * Splat tagging (goal.md W-4, ACT-2 `sdfPaint`): spray paint as Spark SDF edits — each puff is a SplatEditSdf sphere
 * that recolours the splats it covers (SET_RGB with a soft edge). One global SplatEdit lives under the world group, so
 * strokes sit in world space, follow the diorama scale, and apply to every splat mesh in the block.
 *
 * Budget: SDFs cost per-splat shader work on every frame, so strokes are decimated (a puff closer than `minSpacing`
 * to the last one is skipped) and capped at `maxSdfs` per cell (oldest strokes fall off first). Undo pops strokes.
 */
import * as THREE from 'three';
import { SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType } from '@sparkjsdev/spark';

export interface PaintOptions {
  maxSdfs?: number;
  minSpacing?: number;
  softEdge?: number;
}

export interface Puff {
  pos: [number, number, number];
  r: number;
  rgba: [number, number, number, number];
}

export class SplatPainter {
  readonly edit: SplatEdit;
  readonly maxSdfs: number;
  readonly minSpacing: number;
  /** Strokes in order; each stroke is the puffs sprayed between begin() and end(). */
  readonly strokes: Puff[][] = [];
  private current: Puff[] | null = null;
  private lastPoint: THREE.Vector3 | null = null;

  constructor(parent: THREE.Object3D, opts: PaintOptions = {}) {
    this.maxSdfs = opts.maxSdfs ?? 96;
    this.minSpacing = opts.minSpacing ?? 0.12;
    this.edit = new SplatEdit({
      name: 'coast-tags',
      rgbaBlendMode: SplatEditRgbaBlendMode.SET_RGB,
      softEdge: opts.softEdge ?? 0.08,
      sdfs: [],
    });
    parent.add(this.edit);
  }

  /** Total puffs currently applied. */
  get count() {
    return this.edit.sdfs?.length ?? 0;
  }

  /** Start a stroke (mouse down / trigger down). */
  begin() {
    if (this.current) this.end();
    this.current = [];
    this.lastPoint = null;
  }

  /** Spray one puff at a world point. Returns the puff when it was applied (not decimated), else null. */
  spray(point: THREE.Vector3, color: THREE.Color, radius = 0.22): Puff | null {
    if (!this.current) this.begin();
    if (this.lastPoint && this.lastPoint.distanceTo(point) < this.minSpacing) return null;
    const sdf = new SplatEditSdf({ type: SplatEditSdfType.SPHERE, radius, color: color.clone(), opacity: 1 });
    sdf.position.copy(point);
    this.edit.add(sdf);
    this.edit.addSdf(sdf);
    const puff: Puff = { pos: [point.x, point.y, point.z], r: radius, rgba: [color.r, color.g, color.b, 1] };
    this.current!.push(puff);
    this.lastPoint = point.clone();
    this.trim();
    return puff;
  }

  /** End the stroke (mouse up / trigger up). Empty strokes are dropped. */
  end() {
    if (this.current && this.current.length) this.strokes.push(this.current);
    this.current = null;
    this.lastPoint = null;
  }

  /** Remove the most recent stroke. Returns false when there is nothing to undo. */
  undo(): boolean {
    if (this.current?.length) this.end();
    const stroke = this.strokes.pop();
    if (!stroke) return false;
    this.removeLast(stroke.length);
    return true;
  }

  clear() {
    this.current = null;
    this.strokes.length = 0;
    for (const s of [...(this.edit.sdfs ?? [])]) this.detach(s);
  }

  dispose() {
    this.clear();
    this.edit.removeFromParent();
  }

  private trim() {
    // Drop the oldest puffs (and empty strokes) once over budget.
    while (this.count > this.maxSdfs) {
      const oldest = this.edit.sdfs![0]!;
      this.detach(oldest);
      const first = this.strokes[0];
      if (first) {
        first.shift();
        if (!first.length) this.strokes.shift();
      } else this.current?.shift();
    }
  }

  private removeLast(n: number) {
    const sdfs = this.edit.sdfs ?? [];
    for (const s of sdfs.slice(Math.max(0, sdfs.length - n))) this.detach(s);
  }

  private detach(sdf: SplatEditSdf) {
    this.edit.removeSdf(sdf);
    this.edit.remove(sdf);
  }
}
